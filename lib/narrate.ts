// Narration step.
// If GEMINI_API_KEY is set, Gemini (free tier) writes a short, warm summary that is
// constrained to the venues and facts the agent already chose from Qloo — it may not
// add places. Without a key, a deterministic writer produces the same structure,
// so the public demo never depends on a paid model.

import type { OutingType } from "./strategy.ts";

interface NarrateInput {
  city: string;
  outing: OutingType;
  people: { name: string; favorites: { name: string; type: string }[]; tasteTags: string[] }[];
  sharedTags: string[];
  stops: { slotTitle: string; name: string; category: string; champion: string; perPerson: Record<string, number>; neighborhood?: string; hopKm: number }[];
  fairness: { perPerson: Record<string, number>; evenness: number; worstOff: string; rebalanced: boolean };
}

const OUTING_WORD: Record<OutingType, string> = { evening: "An evening", day: "A day", date: "A date night" };

export async function narrate(input: NarrateInput): Promise<{ text: string; source: "gemini" | "template" }> {
  const key = process.env.GEMINI_API_KEY;
  if (key) {
    try {
      const text = await gemini(key, input);
      if (text && mentionsOnlyKnownStops(text, input)) return { text, source: "gemini" };
    } catch {
      /* fall through to the deterministic writer */
    }
  }
  return { text: template(input), source: "template" };
}

function template(i: NarrateInput): string {
  const who = i.people.map((p) => `${p.name} (${p.favorites.map((f) => f.name).join(", ")})`).join(", ");
  const lines = [`${OUTING_WORD[i.outing]} in ${i.city} for ${who}.`];
  if (i.sharedTags.length) lines.push(`What you share, according to Qloo's taste graph: ${i.sharedTags.slice(0, 5).join(", ")}.`);
  i.stops.forEach((s, n) => {
    const hop = n > 0 && s.hopKm > 0 ? ` (${s.hopKm} km from the last stop)` : "";
    const entries = Object.entries(s.perPerson);
    const [lowName, lowVal] = entries.reduce((a, b) => (b[1] < a[1] ? b : a), entries[0] ?? ["", 1]);
    const tail = lowVal >= 0.5 ? "and it sits in everyone's top half" : `— a give for ${lowName}, balanced elsewhere in the route`;
    lines.push(`${n + 1}. ${s.slotTitle} — ${s.name}${s.neighborhood ? `, ${s.neighborhood}` : ""}${hop}. ${s.champion} will love it most, ${tail}.`);
  });
  const worst = Math.round((i.fairness.perPerson[i.fairness.worstOff] ?? 0) * 100);
  lines.push(
    i.fairness.rebalanced
      ? `The agent noticed ${i.fairness.worstOff} was getting the short end and re-balanced the route; everyone now averages at least ${worst}/100.`
      : `Evenness across the table: ${Math.round(i.fairness.evenness * 100)}% — the least-served person still averages ${worst}/100.`,
  );
  return lines.join("\n");
}

async function gemini(key: string, i: NarrateInput): Promise<string> {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const facts = JSON.stringify({ ...i, stops: i.stops.map((s) => ({ ...s, perPerson: undefined })) });
  const prompt =
    `You are a concierge. Write a warm 90-130 word plan for this group outing. ` +
    `Use ONLY the venues listed in "stops", in order. Do not invent venues, prices, opening hours or facts. ` +
    `Mention one shared taste and who each stop is especially for. Plain text, no markdown headers.\n\nDATA:\n${facts}`;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.6, maxOutputTokens: 400 } }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const body: any = await res.json();
  return String(body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "").trim();
}

/** Guardrail: the narration must name every chosen stop (it may not swap venues). */
function mentionsOnlyKnownStops(text: string, i: NarrateInput): boolean {
  const t = text.toLowerCase();
  return i.stops.every((s) => t.includes(s.name.toLowerCase()));
}
