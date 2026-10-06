export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ ok: true, qlooConfigured: Boolean(process.env.QLOO_API_KEY), narration: process.env.GEMINI_API_KEY ? "gemini" : "template" });
}
