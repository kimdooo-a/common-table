// Per-IP sliding-window limiter. In-memory per server instance — enough to stop a
// public demo from being used to drain the Qloo quota; no external store needed.
const hits = new Map<string, number[]>();
const WINDOW_MS = 10 * 60 * 1000;

export function allow(ip: string, limit = Number(process.env.RATE_LIMIT_PER_10MIN ?? 12)): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= limit) {
    hits.set(ip, list);
    return { ok: false, retryAfterSec: Math.ceil((WINDOW_MS - (now - list[0])) / 1000) };
  }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.delete(hits.keys().next().value as string);
  return { ok: true, retryAfterSec: 0 };
}
