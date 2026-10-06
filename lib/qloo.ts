// Thin, server-only Qloo client.
// - The key is read from the environment on every call and never leaves the server.
// - Responses are cached in-process (Qloo allows private server-side caching).
// - Every call is recorded so the UI can show the agent's real tool usage.

export const SEARCH_TYPES = [
  "urn:entity:movie",
  "urn:entity:artist",
  "urn:entity:book",
  "urn:entity:tv_show",
  "urn:entity:videogame",
  "urn:entity:brand",
  "urn:entity:podcast",
  "urn:entity:author",
] as const;

export interface QlooEntity {
  entity_id: string;
  name: string;
  types?: string[];
  popularity?: number;
  disambiguation?: string;
  properties?: Record<string, any>;
  location?: { lat?: number; lon?: number; geohash?: string };
  tags?: { id: string; name: string; type: string }[];
  query?: { affinity?: number; [k: string]: unknown };
}

export interface QlooTag {
  tag_id?: string;
  id?: string;
  name: string;
  type?: string;
  subtype?: string;
  query?: { affinity?: number };
}

export interface CallRecord {
  endpoint: string;
  params: Record<string, string>;
  status: number;
  ms: number;
  cached: boolean;
  results: number;
}

type Fetcher = typeof fetch;

const cache = new Map<string, { at: number; body: any }>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const CACHE_MAX = 500;

// Process-wide concurrency gate: the hackathon key answers 429 when too many requests
// arrive at once, so every Qloo call waits for one of a few slots.
const MAX_IN_FLIGHT = Number(process.env.QLOO_MAX_IN_FLIGHT ?? 2);
let inFlight = 0;
const waiters: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return;
  }
  await new Promise<void>((r) => waiters.push(r));
}
function release(): void {
  const next = waiters.shift();
  if (next) next();
  else inFlight--;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class QlooError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class QlooClient {
  readonly calls: CallRecord[] = [];
  private readonly base: string;
  private readonly key: string;
  private fetcher: Fetcher = (...a) => fetch(...a);

  constructor(opts?: { key?: string; base?: string; fetcher?: Fetcher }) {
    this.key = opts?.key ?? process.env.QLOO_API_KEY ?? "";
    this.base = (opts?.base ?? process.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com").replace(/\/$/, "");
    if (opts?.fetcher) this.fetcher = opts.fetcher;
    if (!this.key) throw new QlooError(500, "QLOO_API_KEY is not configured on the server.");
  }

  private async get(endpoint: string, params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    const url = `${this.base}${endpoint}?${qs}`;
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      this.calls.push({ endpoint, params, status: 200, ms: 0, cached: true, results: countResults(hit.body) });
      return hit.body;
    }
    const t0 = Date.now();
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      await acquire();
      let res: Response;
      let body: any;
      try {
        res = await this.fetcher(url, {
          headers: { "X-Api-Key": this.key, accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        });
        body = await res.json().catch(() => ({}));
      } catch (e) {
        lastErr = e;
        release();
        await sleep(500 * (attempt + 1));
        continue;
      }
      release();
      this.calls.push({ endpoint, params, status: res.status, ms: Date.now() - t0, cached: false, results: countResults(body) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new QlooError(res.status, `Qloo ${endpoint} returned ${res.status}`);
        const ra = Number(res.headers.get("retry-after"));
        await sleep(ra > 0 ? Math.min(ra, 5) * 1000 : 700 * 2 ** attempt + Math.random() * 300);
        continue;
      }
      if (!res.ok) throw new QlooError(res.status, `Qloo ${endpoint} returned ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(url, { at: Date.now(), body });
      return body;
    }
    throw lastErr instanceof Error ? lastErr : new QlooError(502, "Qloo request failed");
  }

  /** Resolve a free-text favourite to a Qloo entity. */
  async search(query: string, types?: string[], take = 5): Promise<QlooEntity[]> {
    const body = await this.get("/search", {
      query,
      types: (types && types.length ? types : SEARCH_TYPES).join(","),
      take: String(take),
    });
    return (body?.results ?? []) as QlooEntity[];
  }

  /** Find tag IDs (e.g. place categories) by keyword. */
  async tags(query: string, parentType = "urn:entity:place", take = 5): Promise<QlooTag[]> {
    const body = await this.get("/v2/tags", {
      "filter.query": query,
      "filter.parents.types": parentType,
      take: String(take),
    });
    return (body?.results?.tags ?? []) as QlooTag[];
  }

  /** Taste analysis: which tags describe this person's favourites. */
  async tasteTags(entityIds: string[], take = 15, tagTypes?: string): Promise<QlooTag[]> {
    const params: Record<string, string> = {
      "filter.type": "urn:tag",
      "signal.interests.entities": entityIds.join(","),
      take: String(take),
    };
    if (tagTypes) params["filter.tag.types"] = tagTypes;
    const body = await this.get("/v2/insights", params);
    return (body?.results?.tags ?? []) as QlooTag[];
  }

  /** Places near a location, ranked by affinity to the given taste signal. */
  async places(opts: {
    signalEntities: string[];
    location: string;
    categoryTag?: string;
    priceMax?: number;
    take?: number;
  }): Promise<QlooEntity[]> {
    const params: Record<string, string> = {
      "filter.type": "urn:entity:place",
      "filter.location.query": opts.location,
      take: String(opts.take ?? 12),
    };
    if (opts.signalEntities.length) params["signal.interests.entities"] = opts.signalEntities.join(",");
    if (opts.categoryTag) params["filter.tags"] = opts.categoryTag;
    if (opts.priceMax) params["filter.price_level.max"] = String(opts.priceMax);
    const body = await this.get("/v2/insights", params);
    return (body?.results?.entities ?? []) as QlooEntity[];
  }

  /** Score a fixed candidate set against ONE person's taste (per-person affinity). */
  async scoreFor(signalEntities: string[], candidateIds: string[]): Promise<Map<string, number>> {
    const body = await this.get("/v2/insights", {
      "filter.type": "urn:entity:place",
      "signal.interests.entities": signalEntities.join(","),
      "filter.results.entities": candidateIds.join(","),
      take: String(candidateIds.length),
    });
    const out = new Map<string, number>();
    for (const e of (body?.results?.entities ?? []) as QlooEntity[]) {
      if (typeof e.query?.affinity === "number") out.set(e.entity_id, e.query.affinity);
    }
    return out;
  }

  /** Destinations that fit the combined taste (used for "where should we go?"). */
  async destinations(signalEntities: string[], take = 6): Promise<QlooEntity[]> {
    const body = await this.get("/v2/insights", {
      "filter.type": "urn:entity:destination",
      "signal.interests.entities": signalEntities.join(","),
      take: String(take),
    });
    return (body?.results?.entities ?? []) as QlooEntity[];
  }
}

function countResults(body: any): number {
  if (!body) return 0;
  if (Array.isArray(body.results)) return body.results.length;
  const r = body.results ?? {};
  return (r.entities?.length ?? 0) + (r.tags?.length ?? 0);
}
