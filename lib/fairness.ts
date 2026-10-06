// Pure group-fairness math. No I/O — unit tested in fairness.test.ts.
//
// Qloo returns an affinity per (person, place). Raw affinities are not comparable
// across people (one person's taste signal may score everything 0.85, another's 0.70),
// so each person's scores are turned into percentiles WITHIN the same candidate pool.
// The group score then blends "least misery" (the unhappiest person) with the mean,
// so a place one person adores and another tolerates loses to a place everyone likes.

export interface Candidate {
  id: string;
  name: string;
  lat?: number;
  lon?: number;
}

/** person -> (placeId -> raw affinity) */
export type RawScores = Record<string, Map<string, number>>;
/** person -> (placeId -> percentile in [0,1]) */
export type Percentiles = Record<string, Map<string, number>>;

export function toPercentiles(raw: RawScores, poolIds: string[]): Percentiles {
  const out: Percentiles = {};
  for (const [person, scores] of Object.entries(raw)) {
    const ranked = poolIds
      .map((id) => ({ id, s: scores.get(id) }))
      .filter((x): x is { id: string; s: number } => typeof x.s === "number")
      .sort((a, b) => a.s - b.s);
    const m = new Map<string, number>();
    const n = ranked.length;
    ranked.forEach((x, i) => m.set(x.id, n <= 1 ? 1 : i / (n - 1)));
    // A place Qloo would not score for this person at all is treated as a poor fit.
    for (const id of poolIds) if (!m.has(id)) m.set(id, 0);
    out[person] = m;
  }
  return out;
}

export const MISERY_WEIGHT = 0.6;

export function groupScore(pct: Percentiles, id: string, weights?: Record<string, number>): number {
  const people = Object.keys(pct);
  if (!people.length) return 0;
  let min = 1;
  let wsum = 0;
  let acc = 0;
  for (const p of people) {
    const v = pct[p].get(id) ?? 0;
    min = Math.min(min, v);
    const w = weights?.[p] ?? 1;
    acc += v * w;
    wsum += w;
  }
  return MISERY_WEIGHT * min + (1 - MISERY_WEIGHT) * (acc / wsum);
}

export function haversineKm(a: Candidate, b: Candidate): number {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return 0;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Gentle penalty for hopping across town between consecutive stops. */
export function travelPenalty(km: number): number {
  if (km <= 2.5) return 0;
  return Math.min(0.3, (km - 2.5) * 0.025);
}

export interface SlotInput {
  key: string;
  pool: Candidate[];
  pct: Percentiles;
}

export interface Pick {
  slot: string;
  candidate: Candidate;
  score: number;
  perPerson: Record<string, number>;
  champion: string;
  hopKm: number;
}

/**
 * Greedy itinerary builder with a satisfaction ledger: after each stop, people who
 * have been served least so far get more weight on the next stop.
 */
export function assemble(slots: SlotInput[], people: string[], forceWeights?: Record<string, number>): Pick[] {
  const ledger: Record<string, number> = Object.fromEntries(people.map((p) => [p, 0]));
  const used = new Set<string>();
  const picks: Pick[] = [];
  let prev: Candidate | undefined;
  for (const slot of slots) {
    const served = Object.values(ledger);
    const top = Math.max(...served);
    const weights: Record<string, number> = {};
    for (const p of people) weights[p] = (forceWeights?.[p] ?? 1) + (top - ledger[p]) * 1.5;
    let best: Pick | undefined;
    for (const c of slot.pool) {
      if (used.has(c.id)) continue;
      const hopKm = prev ? haversineKm(prev, c) : 0;
      const score = groupScore(slot.pct, c.id, weights) - travelPenalty(hopKm);
      if (!best || score > best.score) {
        const perPerson = Object.fromEntries(people.map((p) => [p, slot.pct[p]?.get(c.id) ?? 0]));
        const champion = people.reduce((a, b) => (perPerson[b] > perPerson[a] ? b : a), people[0]);
        best = { slot: slot.key, candidate: c, score, perPerson, champion, hopKm };
      }
    }
    if (!best) continue;
    used.add(best.candidate.id);
    for (const p of people) ledger[p] += best.perPerson[p];
    picks.push(best);
    prev = best.candidate;
  }
  return picks;
}

export interface FairnessReport {
  perPerson: Record<string, number>;
  worstOff: string;
  bestOff: string;
  /** min average / max average — 1.0 means perfectly even. */
  evenness: number;
  groupFit: number;
}

export function audit(picks: Pick[], people: string[]): FairnessReport {
  const perPerson: Record<string, number> = {};
  for (const p of people) {
    perPerson[p] = picks.length ? picks.reduce((s, x) => s + x.perPerson[p], 0) / picks.length : 0;
  }
  const worstOff = people.reduce((a, b) => (perPerson[b] < perPerson[a] ? b : a), people[0]);
  const bestOff = people.reduce((a, b) => (perPerson[b] > perPerson[a] ? b : a), people[0]);
  const evenness = perPerson[bestOff] > 0 ? perPerson[worstOff] / perPerson[bestOff] : 1;
  const groupFit = people.length ? people.reduce((s, p) => s + perPerson[p], 0) / people.length : 0;
  return { perPerson, worstOff, bestOff, evenness, groupFit };
}
