// The Common Table agent.
// It runs an observe → decide → act loop over Qloo tools and streams every step,
// so the user sees *why* each venue was chosen and which tool calls produced it.

import { QlooClient, type QlooEntity, type QlooTag } from "./qloo.ts";
import { assemble, audit, groupScore, toPercentiles, type Candidate, type Percentiles, type Pick, type SlotInput } from "./fairness.ts";
import { rankSlots, type OutingType, type CategoryOption } from "./strategy.ts";
import { narrate } from "./narrate.ts";

export interface PersonInput {
  name: string;
  favorites: { text: string; type?: string }[];
}

export interface PlanRequest {
  people: PersonInput[];
  city?: string;
  outing: OutingType;
  budget?: 1 | 2 | 3 | 4;
}

export type AgentEvent =
  | { type: "step"; id: string; title: string; status: "running" | "done" | "warn"; detail?: string; data?: unknown }
  | { type: "plan"; plan: FinalPlan }
  | { type: "error"; message: string };

export interface StopOut {
  slot: string;
  slotTitle: string;
  category: string;
  name: string;
  id: string;
  address?: string;
  neighborhood?: string;
  lat?: number;
  lon?: number;
  image?: string;
  website?: string;
  rating?: number;
  priceLevel?: number;
  blurb?: string;
  keywords: string[];
  perPerson: Record<string, number>;
  champion: string;
  groupScore: number;
  hopKm: number;
  why: string;
  baseline?: { name: string; perPerson: Record<string, number> };
}

export interface FinalPlan {
  city: string;
  outing: OutingType;
  people: { name: string; favorites: { name: string; type: string; image?: string }[]; tasteTags: string[] }[];
  sharedTags: string[];
  stops: StopOut[];
  fairness: { perPerson: Record<string, number>; evenness: number; groupFit: number; worstOff: string; rebalanced: boolean };
  baselineFit?: number;
  /** group score of the chosen stops, over the same stops that have a baseline */
  chosenFit?: number;
  story: string;
  storySource: "gemini" | "template";
  calls: { total: number; cached: number; endpoints: Record<string, number> };
}

const TYPE_LABEL: Record<string, string> = {
  "urn:entity:movie": "film",
  "urn:entity:artist": "music",
  "urn:entity:book": "book",
  "urn:entity:tv_show": "TV",
  "urn:entity:videogame": "game",
  "urn:entity:brand": "brand",
  "urn:entity:podcast": "podcast",
  "urn:entity:author": "author",
};

const PRICED = new Set(
  ["restaurant", "cafe", "bakery", "tea_house", "bar", "cocktail_bar", "wine_bar", "jazz_club"].map((c) => `urn:tag:category:place:${c}`),
);

export function validate(req: any): PlanRequest {
  if (!req || typeof req !== "object") throw new Error("Invalid request.");
  const outing: OutingType = ["evening", "day", "date"].includes(req.outing) ? req.outing : "evening";
  const people: PersonInput[] = (Array.isArray(req.people) ? req.people : [])
    .slice(0, 4)
    .map((p: any, i: number) => ({
      name: String(p?.name ?? "").trim().slice(0, 24) || `Friend ${i + 1}`,
      favorites: (Array.isArray(p?.favorites) ? p.favorites : [])
        .map((f: any) => ({ text: String(f?.text ?? "").trim().slice(0, 60), type: typeof f?.type === "string" && f.type.startsWith("urn:entity:") ? f.type : undefined }))
        .filter((f: { text: string }) => f.text)
        .slice(0, 3),
    }))
    .filter((p: PersonInput) => p.favorites.length);
  if (people.length < 2) throw new Error("Add at least two people, each with at least one favourite.");
  // de-duplicate names so the fairness ledger has one row per person
  const seen = new Map<string, number>();
  for (const p of people) {
    const n = seen.get(p.name) ?? 0;
    seen.set(p.name, n + 1);
    if (n) p.name = `${p.name} (${n + 1})`;
  }
  const city = String(req.city ?? "").trim().slice(0, 60);
  const budget = [1, 2, 3, 4].includes(Number(req.budget)) ? (Number(req.budget) as 1 | 2 | 3 | 4) : undefined;
  return { people, city, outing, budget };
}

export async function runAgent(req: PlanRequest, emit: (e: AgentEvent) => void, client = new QlooClient()): Promise<FinalPlan> {
  const names = req.people.map((p) => p.name);

  // 1. Resolve every favourite to a Qloo entity -------------------------------------------
  emit({ type: "step", id: "resolve", title: "Resolving favourites in the Qloo taste graph", status: "running" });
  const resolved: Record<string, QlooEntity[]> = {};
  const misses: string[] = [];
  await Promise.all(
    req.people.map(async (p) => {
      resolved[p.name] = [];
      for (const f of p.favorites) {
        const hits = await client.search(f.text, f.type ? [f.type] : undefined, 3);
        const best = pickBest(hits, f.text);
        if (best) resolved[p.name].push(best);
        else misses.push(`${p.name}: “${f.text}”`);
      }
    }),
  );
  const empty = names.filter((n) => !resolved[n].length);
  if (empty.length) throw new Error(`Couldn't find any of ${empty.join(", ")}'s favourites in Qloo. Try a well-known film, artist, book or brand.`);
  emit({
    type: "step",
    id: "resolve",
    title: "Resolved favourites",
    status: misses.length ? "warn" : "done",
    detail: misses.length ? `Skipped (not found): ${misses.join("; ")}` : `${Object.values(resolved).flat().length} entities matched`,
    data: Object.fromEntries(names.map((n) => [n, resolved[n].map(entityCard)])),
  });

  // 2. Profile each person's taste, and the group's overlap ---------------------------------
  emit({ type: "step", id: "profile", title: "Reading each person's taste profile", status: "running" });
  const signal = (n: string) => resolved[n].map((e) => e.entity_id);
  const allSignal = names.flatMap(signal);
  const tagTypes = "urn:tag:keyword:media,urn:tag:genre:media";
  const [personTags, groupTags] = await Promise.all([
    Promise.all(names.map((n) => client.tasteTags(signal(n), 20, tagTypes).catch(() => [] as QlooTag[]))),
    client.tasteTags(allSignal, 15, tagTypes).catch(() => [] as QlooTag[]),
  ]);
  const tagNames = (tags: QlooTag[]) => tags.map((t) => t.name.trim()).filter(Boolean);
  const perPersonTags: Record<string, string[]> = Object.fromEntries(names.map((n, i) => [n, tagNames(personTags[i])]));
  const overlap = intersectMany(names.map((n) => perPersonTags[n]));
  const shared = dedupe([...overlap, ...tagNames(groupTags)]).slice(0, 12);
  emit({
    type: "step",
    id: "profile",
    title: "Taste profiles built",
    status: "done",
    detail: overlap.length
      ? `Direct overlap: ${overlap.slice(0, 5).join(", ")}`
      : `No direct overlap — using Qloo's cross-domain bridge: ${tagNames(groupTags).slice(0, 5).join(", ")}`,
    data: { perPerson: Object.fromEntries(names.map((n) => [n, perPersonTags[n].slice(0, 8)])), shared },
  });

  // 3. Where? If no city was given, let the group's taste choose one ------------------------
  let city = req.city?.trim() ?? "";
  if (!city) {
    emit({ type: "step", id: "where", title: "No city given — asking Qloo where this group would love to go", status: "running" });
    const dests = await client.destinations(allSignal, 8);
    // Taste fit alone is not enough: verify Qloo actually has venue coverage there.
    const checked: string[] = [];
    for (const d of dests.slice(0, 5)) {
      const probe = await client.places({ signalEntities: allSignal, location: d.name, categoryTag: "urn:tag:category:place:restaurant", take: 8 }).catch(() => []);
      checked.push(`${d.name} (${probe.length} venues)`);
      if (probe.length >= 6) {
        city = d.name;
        break;
      }
    }
    const fellBack = !city;
    if (!city) city = "Lisbon";
    emit({
      type: "step",
      id: "where",
      title: `Destination chosen: ${city}`,
      status: fellBack || checked.length > 1 ? "warn" : "done",
      detail: `Taste matches checked for venue coverage: ${checked.join(", ")}${fellBack ? " — none had enough venues, falling back to Lisbon" : ""}`,
    });
  }

  // 4. Decide the shape of the outing ----------------------------------------------------
  const slots = rankSlots(req.outing, shared);
  emit({
    type: "step",
    id: "strategy",
    title: "Planned the shape of the outing",
    status: "done",
    detail: slots
      .map((s) => `${s.template.title}: ${s.ranked[0].option.label}${s.ranked[0].hits.length ? ` (shared taste: ${s.ranked[0].hits.slice(0, 2).join(", ")})` : ""}`)
      .join(" · "),
  });

  // 5. For each slot: gather candidates, then score them against EVERY person -----------
  const slotInputs: SlotInput[] = [];
  const slotMeta: Record<string, { title: string; option: CategoryOption; places: Map<string, QlooEntity>; baseline: QlooEntity[] }> = {};
  for (const s of slots) {
    emit({ type: "step", id: `slot-${s.template.key}`, title: `${s.template.title}: searching ${city}`, status: "running" });
    let chosen: CategoryOption | undefined;
    let pool: QlooEntity[] = [];
    const tried: string[] = [];
    let fallback: { option: CategoryOption; pool: QlooEntity[] } | undefined;
    for (const { option } of s.ranked) {
      // Budget only constrains food & drink — museums and parks rarely carry a price level.
      const priced = req.budget && PRICED.has(option.tag) ? [req.budget, undefined] : [undefined];
      for (const price of priced) {
        pool = await client.places({ signalEntities: allSignal, location: city, categoryTag: option.tag, priceMax: price, take: 15 }).catch(() => []);
        tried.push(`${option.label}${price ? ` ≤${"$".repeat(price)}` : ""} → ${pool.length}`);
        if (pool.length >= 4) break;
        if (pool.length >= 2 && (!fallback || pool.length > fallback.pool.length)) fallback = { option, pool };
      }
      if (pool.length >= 4) {
        chosen = option;
        break;
      }
    }
    if (!chosen && fallback) {
      // Thin coverage: accept the richest small pool rather than dropping the stop.
      chosen = fallback.option;
      pool = fallback.pool;
    }
    if (!chosen || !pool.length) {
      emit({ type: "step", id: `slot-${s.template.key}`, title: `${s.template.title}: nothing suitable in ${city}`, status: "warn", detail: `Tried ${tried.join("; ")}. Dropping this stop.` });
      continue;
    }
    // A taste-blind baseline: what a generic "top places" list would suggest.
    const baseline = await client.places({ signalEntities: [], location: city, categoryTag: chosen.tag, take: 3 }).catch(() => [] as QlooEntity[]);
    const ids = dedupe([...pool.map((e) => e.entity_id), ...baseline.map((e) => e.entity_id)]);
    const raw = Object.fromEntries(
      await Promise.all(names.map(async (n) => [n, await client.scoreFor(signal(n), ids).catch(() => new Map<string, number>())] as const)),
    );
    const pct = toPercentiles(raw, ids);
    const places = new Map<string, QlooEntity>([...baseline, ...pool].map((e) => [e.entity_id, e]));
    slotInputs.push({ key: s.template.key, pool: pool.map(toCandidate), pct });
    slotMeta[s.template.key] = { title: s.template.title, option: chosen, places, baseline };
    emit({
      type: "step",
      id: `slot-${s.template.key}`,
      title: `${s.template.title}: ${pool.length} ${chosen.label} candidates scored for ${names.length} people`,
      status: tried.length > 1 ? "warn" : "done",
      detail: tried.length > 1 ? `Re-planned: ${tried.join("; ")}` : undefined,
    });
  }
  if (!slotInputs.length) throw new Error(`Qloo has no matching venues in “${city}”. Try a larger city.`);

  // 6. Assemble, audit, and re-balance if someone is being short-changed ------------------
  emit({ type: "step", id: "assemble", title: "Assembling a route everyone can enjoy", status: "running" });
  let picks = assemble(slotInputs, names);
  let report = audit(picks, names);
  let rebalanced = false;
  if (names.length > 1 && report.evenness < 0.8) {
    const boost = Object.fromEntries(names.map((n) => [n, n === report.worstOff ? 3 : 1]));
    const alt = assemble(slotInputs, names, boost);
    const altReport = audit(alt, names);
    const accept = altReport.evenness > report.evenness && altReport.groupFit >= report.groupFit - 0.08;
    emit({
      type: "step",
      id: "rebalance",
      title: accept ? `Re-balanced the plan in ${report.worstOff}'s favour` : `Checked a re-balance for ${report.worstOff}`,
      status: accept ? "warn" : "done",
      detail: `Evenness ${(report.evenness * 100).toFixed(0)}% → ${(altReport.evenness * 100).toFixed(0)}%, group fit ${(report.groupFit * 100).toFixed(0)} → ${(altReport.groupFit * 100).toFixed(0)}. ${accept ? "Accepted." : "Kept the original — the trade-off cost the group too much."}`,
    });
    if (accept) {
      picks = alt;
      report = altReport;
      rebalanced = true;
    }
  }
  emit({
    type: "step",
    id: "assemble",
    title: `Route ready: ${picks.length} stops`,
    status: "done",
    detail: `Group fit ${(report.groupFit * 100).toFixed(0)}/100 · evenness ${(report.evenness * 100).toFixed(0)}%`,
  });

  // 7. Compare with a taste-blind plan --------------------------------------------------
  // Both averages are taken over the same stops, so the comparison is like-for-like.
  const baselineScores: number[] = [];
  const pairedChosen: number[] = [];
  const stops: StopOut[] = picks.map((p) => {
    const meta = slotMeta[p.slot];
    const e = meta.places.get(p.candidate.id)!;
    const slotIn = slotInputs.find((s) => s.key === p.slot)!;
    const b = meta.baseline[0];
    let baselineOut: StopOut["baseline"];
    if (b) {
      baselineScores.push(groupScore(slotIn.pct, b.entity_id));
      pairedChosen.push(groupScore(slotIn.pct, p.candidate.id));
      if (b.entity_id !== p.candidate.id) {
        baselineOut = { name: b.name, perPerson: Object.fromEntries(names.map((n) => [n, slotIn.pct[n].get(b.entity_id) ?? 0])) };
      }
    }
    return toStop(p, e, meta.title, meta.option.label, shared, resolved, baselineOut);
  });
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const chosenFit = avg(pairedChosen);
  const baselineFit = baselineScores.length ? avg(baselineScores) : undefined;
  if (baselineFit !== undefined) {
    emit({
      type: "step",
      id: "baseline",
      title: "Compared against a taste-blind “top places” plan",
      status: "done",
      detail: `Taste-fair plan: ${(chosenFit * 100).toFixed(0)}/100 vs. generic top picks: ${(baselineFit * 100).toFixed(0)}/100 (least-misery group score)`,
    });
  }

  // 8. Narrate ----------------------------------------------------------------------------
  emit({ type: "step", id: "narrate", title: "Writing the plan", status: "running" });
  const people = names.map((n) => ({
    name: n,
    favorites: resolved[n].map((e) => ({ name: e.name, type: TYPE_LABEL[e.types?.[0] ?? ""] ?? "favourite", image: e.properties?.image?.url })),
    tasteTags: perPersonTags[n].slice(0, 8),
  }));
  const fairness = { perPerson: report.perPerson, evenness: report.evenness, groupFit: report.groupFit, worstOff: report.worstOff, rebalanced };
  const { text: story, source } = await narrate({ city, outing: req.outing, people, sharedTags: shared, stops, fairness });
  emit({ type: "step", id: "narrate", title: source === "gemini" ? "Plan written (Gemini narration, grounded in Qloo data)" : "Plan written", status: "done" });

  const endpoints: Record<string, number> = {};
  for (const c of client.calls) endpoints[c.endpoint] = (endpoints[c.endpoint] ?? 0) + 1;
  const plan: FinalPlan = {
    city,
    outing: req.outing,
    people,
    sharedTags: shared,
    stops,
    fairness,
    baselineFit,
    chosenFit: baselineFit === undefined ? undefined : chosenFit,
    story,
    storySource: source,
    calls: { total: client.calls.length, cached: client.calls.filter((c) => c.cached).length, endpoints },
  };
  emit({ type: "plan", plan });
  return plan;
}

// ---------------------------------------------------------------------------------------

function pickBest(hits: QlooEntity[], text: string): QlooEntity | undefined {
  if (!hits.length) return undefined;
  const t = text.toLowerCase();
  const exact = hits.find((h) => h.name.toLowerCase() === t);
  return exact ?? hits[0];
}

function entityCard(e: QlooEntity) {
  return { name: e.name, type: TYPE_LABEL[e.types?.[0] ?? ""] ?? e.types?.[0], image: e.properties?.image?.url, id: e.entity_id };
}

function toCandidate(e: QlooEntity): Candidate {
  const lat = e.location?.lat ?? e.properties?.geocode?.lat;
  const lon = e.location?.lon ?? e.properties?.geocode?.lon;
  return { id: e.entity_id, name: e.name, lat: typeof lat === "number" ? lat : undefined, lon: typeof lon === "number" ? lon : undefined };
}

function toStop(
  p: Pick,
  e: QlooEntity,
  slotTitle: string,
  category: string,
  shared: string[],
  resolved: Record<string, QlooEntity[]>,
  baseline?: StopOut["baseline"],
): StopOut {
  const props = e.properties ?? {};
  const keywords: string[] = (props.keywords ?? []).map((k: any) => k?.name).filter(Boolean).slice(0, 5);
  const placeTags = (e.tags ?? []).map((t) => t.name.toLowerCase());
  // Only exact tag matches count as an "echo" — substring matches produced nonsense like "friend".
  const tagEcho = shared.filter((s) => s.length > 3 && placeTags.includes(s.toLowerCase())).slice(0, 2);
  const ranked = Object.entries(p.perPerson).sort((a, b) => b[1] - a[1]);
  const low = ranked[ranked.length - 1];
  const champFav = resolved[p.champion]?.[0]?.name;
  const why =
    `Ranks in the top ${Math.max(1, Math.round((1 - low[1]) * 100))}% for everyone at the table` +
    (champFav ? `; strongest pull for ${p.champion} (fans of ${champFav})` : "") +
    (tagEcho.length ? `; echoes your shared taste for ${tagEcho.join(" & ")}` : "") +
    ".";
  return {
    slot: p.slot,
    slotTitle,
    category,
    name: e.name,
    id: e.entity_id,
    address: props.address,
    neighborhood: props.neighborhood,
    lat: p.candidate.lat,
    lon: p.candidate.lon,
    image: props.images?.[0]?.url,
    website: props.website,
    rating: typeof props.business_rating === "number" ? Math.round(props.business_rating * 10) / 10 : undefined,
    priceLevel: typeof props.price_level === "number" ? props.price_level : undefined,
    blurb: props.short_description ?? props.description,
    keywords,
    perPerson: p.perPerson,
    champion: p.champion,
    groupScore: p.score,
    hopKm: Math.round(p.hopKm * 10) / 10,
    why,
    baseline,
  };
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function intersectMany(lists: string[][]): string[] {
  if (!lists.length) return [];
  const norm = lists.map((l) => new Set(l.map((x) => x.toLowerCase())));
  return lists[0].filter((x) => norm.every((s) => s.has(x.toLowerCase())));
}

export type { Percentiles };
