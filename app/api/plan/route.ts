import { runAgent, validate, type AgentEvent } from "@/lib/agent.ts";
import { allow } from "@/lib/ratelimit.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const ip = (request.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const gate = allow(ip);
  if (!gate.ok) {
    return Response.json({ error: `Demo rate limit reached — try again in ${gate.retryAfterSec}s.` }, { status: 429, headers: { "retry-after": String(gate.retryAfterSec) } });
  }
  let req;
  try {
    req = validate(await request.json());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        await runAgent(req, emit);
      } catch (e) {
        const msg = (e as Error).message || "The agent failed.";
        // never echo upstream details that could include request URLs
        emit({ type: "error", message: msg.startsWith("Qloo ") ? "The Qloo API did not answer as expected. Please try again." : msg });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
