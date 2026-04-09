import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";
import { ensureColumns, startSessionWorker } from "@/lib/sessionWorker.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request) {
  const { session_token } = await request.json().catch(() => ({}));
  if (!session_token || !DB_READY || !pool) {
    return withCors(
      NextResponse.json({ success: false, error: "Invalid session or DB unavailable" }, { status: 400 })
    );
  }

  startSessionWorker();
  await ensureColumns();

  try {
    await pool.query(
      `UPDATE interview_sessions
         SET connection_status = 'disconnected',
             disconnected_at = NOW(),
             last_activity_at = NOW()
       WHERE session_token = $1`,
      [session_token]
    );
    console.log("[session] disconnected", { sessionToken: session_token });
    return withCors(NextResponse.json({ success: true }));
  } catch (e) {
    console.error("[session] disconnect update failed:", e.message);
    return withCors(NextResponse.json({ success: false, error: e.message }, { status: 500 }));
  }
}
