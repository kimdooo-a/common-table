# Common Table

**Live demo:** https://common-table-topaz.vercel.app

**Plans for people who don't like the same things.**

Common Table is a group-outing agent built on [Qloo](https://www.qloo.com/)'s Taste AI graph.
Each person brings two or three favourites — a film, a band, a book, a game, a brand. The agent reads
each person's taste in Qloo, scores every candidate venue **separately for each person**, and assembles
a route where nobody is quietly compromising all night.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/).

## Why this needs Qloo

A generic LLM can list "top restaurants in Lisbon". It cannot tell you that the fan of *Spirited Away*
and the fan of *Radiohead* will both rank a fado house in Encarnação in their top 20%, while the
city's most popular food hall sits near the bottom for both. That judgement comes from Qloo's
cross-domain affinity data — film and music taste predicting venue fit — and it is the whole product.

## What the agent does

Every run streams its reasoning to the UI:

1. **Resolve** each favourite to a Qloo entity (`/search`).
2. **Profile** each person's taste and the group's overlap (`/v2/insights`, `filter.type=urn:tag`).
   If there is no direct overlap, it uses Qloo's cross-domain bridge from the combined signal.
3. **Choose a destination** if none was given (`filter.type=urn:entity:destination`) — and *verify*
   each candidate has venue coverage before committing to it.
4. **Shape the outing** — e.g. a music-leaning group gets a live-music nightcap, an art-leaning one
   starts at a gallery — keeping other categories as fallbacks.
5. **Gather candidates** per stop (`filter.type=urn:entity:place`, `filter.location.query`,
   `filter.tags`, optional `filter.price_level.max`), re-planning when a category is thin.
6. **Score every candidate for every person** with `filter.results.entities` — the same pool, each
   person's own signal. Raw affinities are converted to per-person percentiles so they are comparable.
7. **Assemble** a route with a *least-misery* group score (60% weight on the unhappiest person),
   a satisfaction ledger that favours whoever has been served least so far, and a walking-distance penalty.
8. **Audit fairness** and re-balance if one person is short-changed (accepting the change only if the
   group as a whole doesn't lose too much).
9. **Compare against a taste-blind baseline** — the most popular venue in the same category — scored the
   same way, so you can see what Qloo bought you.
10. **Narrate** the plan. With a `GEMINI_API_KEY` the narration is written by Gemini and is rejected
    unless it names exactly the venues the agent chose; without a key a deterministic writer is used.
    The demo never depends on a paid model.

## Run locally

```bash
cp .env.example .env.local   # add your QLOO_API_KEY
npm install
npm run dev                  # http://localhost:3000
npm test                     # fairness + strategy unit tests
QLOO_API_KEY=... npm run smoke -- pair   # live end-to-end run (pair | trio | date)
```

Requires Node 22.6+ (tests use `--experimental-strip-types`).

## Deploy (Vercel)

Import the repository, set `QLOO_API_KEY` (and optionally `GEMINI_API_KEY`) as environment variables.
The Qloo key is only read on the server (`app/api/plan/route.ts`); nothing is exposed to the browser.

## Safety for a public demo

- Keys are server-side only; the repo ships `.env.example` only.
- Per-IP rate limit (`RATE_LIMIT_PER_10MIN`, default 12 plans per 10 minutes).
- Qloo calls run through a small concurrency gate with retry/back-off on 429.
- Qloo responses are cached in-process only (never written to the repository).

## Structure

```
app/page.tsx          UI: inputs, live agent trace, fairness meters, route sketch, stop cards
app/api/plan/route.ts Streams agent events as NDJSON
lib/agent.ts          The agent loop
lib/qloo.ts           Qloo client (cache, concurrency gate, call log)
lib/fairness.ts       Percentiles, least-misery score, ledger-based assembly, audit (pure, tested)
lib/strategy.ts       Outing templates and taste-driven category ranking (pure, tested)
lib/narrate.ts        Optional Gemini narration with a venue guardrail; deterministic fallback
```

## License

MIT — see [LICENSE](./LICENSE). Venue and taste data © Qloo, accessed through the hackathon API.
