import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";
import { ensureColumns, startSessionWorker } from "@/lib/sessionWorker.js";
import { validateInterviewSessionToken } from "@/lib/sessionAuth.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request) {
  const { session_token } = await request.json().catch(() => ({}));
  const validation = await validateInterviewSessionToken(session_token);
  if (!validation.ok) {
    return withCors(NextResponse.json({ success: false, error: validation.error }, { status: validation.status }));
  }
  if (!DB_READY || !pool) {
    return withCors(NextResponse.json({ success: false, error: "Database unavailable" }, { status: 503 }));
  }

  startSessionWorker();
  await ensureColumns();
  pool.query(
    `UPDATE interview_sessions SET last_activity_at = NOW() WHERE session_token = $1`,
    [session_token]
  ).then(() => {
    console.log("[session] heartbeat", { sessionToken: session_token });
  }).catch(e => console.warn("Heartbeat save failed:", e.message));

  return withCors(NextResponse.json({ ok: true }));
}
