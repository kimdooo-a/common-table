"use client";

import { useRef, useState } from "react";
import type { AgentEvent, FinalPlan, StopOut } from "@/lib/agent.ts";

type Fav = { text: string; type: string };
type Person = { name: string; favorites: Fav[] };
type Step = { id: string; title: string; status: "running" | "done" | "warn"; detail?: string };

const COLORS = ["var(--p0)", "var(--p1)", "var(--p2)", "var(--p3)"];
const TYPES: [string, string][] = [
  ["", "Any"],
  ["urn:entity:movie", "Film"],
  ["urn:entity:artist", "Music"],
  ["urn:entity:book", "Book"],
  ["urn:entity:tv_show", "TV"],
  ["urn:entity:videogame", "Game"],
  ["urn:entity:brand", "Brand"],
  ["urn:entity:podcast", "Podcast"],
];

const EXAMPLES: { label: string; city: string; outing: "evening" | "day" | "date"; people: Person[] }[] = [
  {
    label: "Anime fan + Radiohead fan in Lisbon",
    city: "Lisbon",
    outing: "evening",
    people: [
      { name: "Mina", favorites: [{ text: "Spirited Away", type: "urn:entity:movie" }, { text: "Your Name", type: "urn:entity:movie" }] },
      { name: "Leo", favorites: [{ text: "Radiohead", type: "urn:entity:artist" }, { text: "Portishead", type: "urn:entity:artist" }] },
    ],
  },
  {
    label: "Three friends, no city yet",
    city: "",
    outing: "day",
    people: [
      { name: "Ana", favorites: [{ text: "Pride and Prejudice", type: "urn:entity:book" }, { text: "Taylor Swift", type: "urn:entity:artist" }] },
      { name: "Kenji", favorites: [{ text: "The Legend of Zelda: Breath of the Wild", type: "urn:entity:videogame" }, { text: "Daft Punk", type: "urn:entity:artist" }] },
      { name: "Sol", favorites: [{ text: "Patagonia", type: "urn:entity:brand" }, { text: "Into the Wild", type: "urn:entity:movie" }] },
    ],
  },
  {
    label: "Date night in Seoul",
    city: "Seoul",
    outing: "date",
    people: [
      { name: "Jun", favorites: [{ text: "Parasite", type: "urn:entity:movie" }, { text: "Hyukoh", type: "urn:entity:artist" }] },
      { name: "Eli", favorites: [{ text: "Norah Jones", type: "urn:entity:artist" }, { text: "Before Sunrise", type: "urn:entity:movie" }] },
    ],
  },
];

const blank = (i: number): Person => ({ name: ["Mina", "Leo", "Sam", "Ari"][i] ?? `Friend ${i + 1}`, favorites: [{ text: "", type: "" }] });

export default function Home() {
  const [people, setPeople] = useState<Person[]>(EXAMPLES[0].people);
  const [city, setCity] = useState(EXAMPLES[0].city);
  const [outing, setOuting] = useState<"evening" | "day" | "date">("evening");
  const [budget, setBudget] = useState<string>("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [plan, setPlan] = useState<FinalPlan | null>(null);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);

  const update = (i: number, fn: (p: Person) => Person) => setPeople((ps) => ps.map((p, j) => (j === i ? fn(p) : p)));

  async function run() {
    setBusy(true);
    setSteps([]);
    setPlan(null);
    setError("");
    setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ people, city, outing, budget: budget ? Number(budget) : undefined }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as AgentEvent;
          if (ev.type === "step") {
            setSteps((s) => {
              const idx = s.findIndex((x) => x.id === ev.id);
              const next: Step = { id: ev.id, title: ev.title, status: ev.status, detail: ev.detail };
              return idx >= 0 ? s.map((x, k) => (k === idx ? next : x)) : [...s, next];
            });
          } else if (ev.type === "plan") setPlan(ev.plan);
          else if (ev.type === "error") setError(ev.message);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const colorOf = (name: string) => COLORS[Math.max(0, (plan?.people ?? people).findIndex((p) => p.name === name)) % COLORS.length];

  return (
    <main className="wrap">
      <header className="hero">
        <span className="eyebrow">Common Table · a Qloo-powered agent</span>
        <h1>Plans for people who don’t like the same things.</h1>
        <p>
          Everyone brings two or three favourites — a film, a band, a book, a game. The agent reads each person’s taste in Qloo’s
          cultural graph, scores every candidate venue <em>separately for each of you</em>, and builds a route where nobody is quietly
          compromising all night.
        </p>
      </header>

      <section className="card">
        <div className="grid-people">
          {people.map((p, i) => (
            <div key={i} className="card person" style={{ ["--pc" as any]: COLORS[i] }}>
              <div className="person-head">
                <span className="dot" />
                <input className="name-input" aria-label={`Person ${i + 1} name`} value={p.name} onChange={(e) => update(i, (x) => ({ ...x, name: e.target.value }))} />
                {people.length > 2 && (
                  <button className="x" aria-label="Remove person" onClick={() => setPeople((ps) => ps.filter((_, j) => j !== i))}>
                    ×
                  </button>
                )}
              </div>
              {p.favorites.map((f, k) => (
                <div className="fav" key={k}>
                  <input
                    placeholder={["e.g. Spirited Away", "e.g. Radiohead", "e.g. Dune"][k]}
                    aria-label={`${p.name} favourite ${k + 1}`}
                    value={f.text}
                    onChange={(e) => update(i, (x) => ({ ...x, favorites: x.favorites.map((y, m) => (m === k ? { ...y, text: e.target.value } : y)) }))}
                  />
                  <select
                    aria-label="Type"
                    value={f.type}
                    onChange={(e) => update(i, (x) => ({ ...x, favorites: x.favorites.map((y, m) => (m === k ? { ...y, type: e.target.value } : y)) }))}
                  >
                    {TYPES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              {p.favorites.length < 3 && (
                <button className="ghost" style={{ width: "100%", marginTop: 4 }} onClick={() => update(i, (x) => ({ ...x, favorites: [...x.favorites, { text: "", type: "" }] }))}>
                  + add a favourite
                </button>
              )}
            </div>
          ))}
          {people.length < 4 && (
            <button className="ghost" onClick={() => setPeople((ps) => [...ps, blank(ps.length)])}>
              + add a person
            </button>
          )}
        </div>

        <div className="controls">
          <div className="field">
            <label htmlFor="city">City</label>
            <input id="city" placeholder="Leave blank — your taste picks one" value={city} onChange={(e) => setCity(e.target.value)} />
          </div>
          <div className="field">
            <label>Outing</label>
            <div className="seg" role="group">
              {(["evening", "day", "date"] as const).map((o) => (
                <button key={o} aria-pressed={outing === o} onClick={() => setOuting(o)}>
                  {o === "evening" ? "Evening" : o === "day" ? "Full day" : "Date night"}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="budget">Budget</label>
            <select id="budget" value={budget} onChange={(e) => setBudget(e.target.value)}>
              <option value="">Any</option>
              <option value="1">$</option>
              <option value="2">$$</option>
              <option value="3">$$$</option>
            </select>
          </div>
          <button className="go" onClick={run} disabled={busy}>
            {busy ? "Planning…" : "Plan it"}
          </button>
        </div>
        <p className="examples">
          Try:
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              onClick={() => {
                setPeople(ex.people);
                setCity(ex.city);
                setOuting(ex.outing);
              }}
            >
              {ex.label}
            </button>
          ))}
        </p>
      </section>

      <div ref={resultsRef} />
      {error && <div className="err">{error}</div>}

      {(steps.length > 0 || plan) && (
        <div className="layout">
          <aside className="card trace" aria-live="polite">
            <h3>What the agent is doing</h3>
            <ol className="steps">
              {steps.map((s) => (
                <li key={s.id} className={`step ${s.status}`}>
                  <span className="ic" />
                  <div>
                    <div className="t">{s.title}</div>
                    {s.detail && <div className="d">{s.detail}</div>}
                  </div>
                </li>
              ))}
            </ol>
            {plan && (
              <div className="calls">
                {plan.calls.total} Qloo calls ({plan.calls.cached} cached) ·{" "}
                {Object.entries(plan.calls.endpoints)
                  .map(([k, v]) => `${k} ×${v}`)
                  .join(" · ")}
              </div>
            )}
          </aside>

          <section>{plan ? <PlanView plan={plan} colorOf={colorOf} /> : <div className="card">Working…</div>}</section>
        </div>
      )}

      <footer className="foot">
        Built for the Qloo Agentic Hackathon. Venue and taste data © Qloo. Open source (MIT).
      </footer>
    </main>
  );
}

function PlanView({ plan, colorOf }: { plan: FinalPlan; colorOf: (n: string) => string }) {
  const f = plan.fairness;
  const chosen = plan.stops.length ? plan.stops.reduce((s, x) => s + x.groupScore, 0) / plan.stops.length : 0;
  return (
    <div>
      <div className="summary">
        <div className="card">
          <h3 className="section-title">
            {plan.outing === "day" ? "A day" : plan.outing === "date" ? "A date night" : "An evening"} in {plan.city}
          </h3>
          <div className="story">{plan.story}</div>
          {plan.sharedTags.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {plan.sharedTags.slice(0, 8).map((t) => (
                <span key={t} className="pill">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <h3 className="section-title">Fairness check</h3>
          <div className="row" style={{ alignItems: "baseline" }}>
            <span className="big">{Math.round(f.evenness * 100)}%</span>
            <span className="meta">evenness across the table{f.rebalanced ? " · re-balanced by the agent" : ""}</span>
          </div>
          {Object.entries(f.perPerson).map(([n, v]) => (
            <div className="meter" key={n} style={{ ["--pc" as any]: colorOf(n) }}>
              <span>{n}</span>
              <span className="bar">
                <i style={{ width: `${Math.round(v * 100)}%` }} />
              </span>
              <span>{Math.round(v * 100)}</span>
            </div>
          ))}
          {plan.baselineFit !== undefined && (
            <p className="meta" style={{ marginTop: 10 }}>
              Group score {Math.round(chosen * 100)} vs. {Math.round(plan.baselineFit * 100)} for a taste-blind “top places” list in the same categories.
            </p>
          )}
        </div>
      </div>

      <RouteSketch stops={plan.stops} />

      <div className="stops">
        {plan.stops.map((s, i) => (
          <article className="card stop" key={s.id}>
            {s.image ? (
              <img
                src={s.image}
                alt={s.name}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  const el = e.currentTarget;
                  el.replaceWith(Object.assign(document.createElement("div"), { className: "noimg" }));
                }}
              />
            ) : (
              <div className="noimg" />
            )}
            <div className="body">
              <div className="slot">
                {i + 1}. {s.slotTitle} · {s.category}
              </div>
              <h4>{s.name}</h4>
              <div className="meta">
                {[s.neighborhood, s.rating ? `★ ${s.rating}` : "", s.priceLevel ? "$".repeat(s.priceLevel) : "", i > 0 && s.hopKm ? `${s.hopKm} km from stop ${i}` : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              <p className="why">{s.why}</p>
              {Object.entries(s.perPerson).map(([n, v]) => (
                <div className="meter" key={n} style={{ ["--pc" as any]: colorOf(n) }}>
                  <span>
                    {n}
                    {n === s.champion ? " ♥" : ""}
                  </span>
                  <span className="bar">
                    <i style={{ width: `${Math.round(v * 100)}%` }} />
                  </span>
                  <span>{Math.round(v * 100)}</span>
                </div>
              ))}
              {s.keywords.length > 0 && <div className="meta">People mention: {s.keywords.join(", ")}</div>}
              {s.baseline && (
                <div className="vs">
                  Generic top pick would have been <b>{s.baseline.name}</b> — fit:{" "}
                  {Object.entries(s.baseline.perPerson)
                    .map(([n, v]) => `${n} ${Math.round(v * 100)}`)
                    .join(", ")}
                </div>
              )}
              <div className="row" style={{ marginTop: 8, fontSize: 13 }}>
                {s.lat != null && s.lon != null && (
                  <a href={`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`} target="_blank" rel="noreferrer">
                    Map
                  </a>
                )}
                {s.website && (
                  <a href={s.website} target="_blank" rel="noreferrer">
                    Website
                  </a>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function RouteSketch({ stops }: { stops: StopOut[] }) {
  const pts = stops.filter((s) => s.lat != null && s.lon != null) as (StopOut & { lat: number; lon: number })[];
  if (pts.length < 2) return null;
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const [minLa, maxLa, minLo, maxLo] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const W = 800, H = 220, pad = 40;
  const sx = (lo: number) => pad + ((lo - minLo) / (maxLo - minLo || 1)) * (W - 2 * pad);
  const sy = (la: number) => H - pad - ((la - minLa) / (maxLa - minLa || 1)) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.lon).toFixed(1)},${sy(p.lat).toFixed(1)}`).join(" ");
  return (
    <div className="card" style={{ marginTop: 16, padding: 12 }}>
      <svg className="route" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Route sketch">
        <path d={d} fill="none" stroke="var(--ink)" strokeWidth="2" strokeDasharray="6 6" />
        {pts.map((p, i) => (
          <g key={p.id}>
            <circle cx={sx(p.lon)} cy={sy(p.lat)} r="13" fill="var(--accent)" />
            <text x={sx(p.lon)} y={sy(p.lat) + 4.5} textAnchor="middle" fontSize="13" fill="#fff" fontWeight="700">
              {i + 1}
            </text>
            <text
              x={sx(p.lon) > W / 2 ? sx(p.lon) - 18 : sx(p.lon) + 18}
              y={sy(p.lat) + 4}
              textAnchor={sx(p.lon) > W / 2 ? "end" : "start"}
              fontSize="13"
              fill="var(--ink)"
            >
              {p.name.length > 26 ? p.name.slice(0, 25) + "…" : p.name}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
