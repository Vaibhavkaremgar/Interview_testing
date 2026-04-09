import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";
import { ensureColumns, startSessionWorker } from "@/lib/sessionWorker.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request) {
  const { session_token, transcript_so_far } = await request.json().catch(() => ({}));
  if (session_token && DB_READY && pool) {
    startSessionWorker();
    await ensureColumns();
    pool.query(
      `UPDATE interview_sessions SET last_transcript_snapshot = $1, last_activity_at = NOW() WHERE session_token = $2`,
      [transcript_so_far || "", session_token]
    ).then(() => {
      console.log("[session] heartbeat", { sessionToken: session_token });
    }).catch(e => console.warn("Heartbeat save failed:", e.message));
  }
  return withCors(NextResponse.json({ ok: true }));
}
