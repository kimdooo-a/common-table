// End-to-end run against the live Qloo API (needs QLOO_API_KEY in the environment).
// Usage: QLOO_API_KEY=... npm run smoke -- [pair|trio|date]
import { runAgent, validate } from "../lib/agent.ts";

const SCENARIOS: Record<string, unknown> = {
  // Two people with no direct taste overlap, evening in Lisbon.
  pair: {
    city: "Lisbon",
    outing: "evening",
    people: [
      { name: "Mina", favorites: [{ text: "Spirited Away", type: "urn:entity:movie" }, { text: "Your Name", type: "urn:entity:movie" }] },
      { name: "Leo", favorites: [{ text: "Radiohead", type: "urn:entity:artist" }, { text: "Portishead", type: "urn:entity:artist" }] },
    ],
  },
  // Three people, no city (the agent picks one), full day, budget $$.
  trio: {
    city: "",
    outing: "day",
    budget: 2,
    people: [
      { name: "Ana", favorites: [{ text: "Pride and Prejudice", type: "urn:entity:book" }, { text: "Taylor Swift", type: "urn:entity:artist" }] },
      { name: "Kenji", favorites: [{ text: "The Legend of Zelda: Breath of the Wild", type: "urn:entity:videogame" }, { text: "Daft Punk", type: "urn:entity:artist" }] },
      { name: "Sol", favorites: [{ text: "Patagonia", type: "urn:entity:brand" }, { text: "Into the Wild", type: "urn:entity:movie" }] },
    ],
  },
  // Date night in Seoul.
  date: {
    city: "Seoul",
    outing: "date",
    people: [
      { name: "Jun", favorites: [{ text: "Parasite", type: "urn:entity:movie" }, { text: "Hyukoh", type: "urn:entity:artist" }] },
      { name: "Eli", favorites: [{ text: "Norah Jones", type: "urn:entity:artist" }, { text: "Before Sunrise", type: "urn:entity:movie" }] },
    ],
  },
};

const name = process.argv[2] ?? "pair";
const req = validate(SCENARIOS[name]);
const t0 = Date.now();
const plan = await runAgent(req, (e) => {
  if (e.type === "step" && e.status !== "running") console.log(`[${e.status}] ${e.title}${e.detail ? " — " + e.detail : ""}`);
});
console.log("\n" + plan.story);
console.log(`\n[${name}] ${plan.stops.length} stops · evenness ${(plan.fairness.evenness * 100).toFixed(0)}% · ${plan.calls.total} Qloo calls · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(JSON.stringify(plan.calls.endpoints));
