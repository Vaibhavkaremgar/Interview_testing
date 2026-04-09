import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";
import { DISCONNECT_EXPIRE_MS, ensureColumns, startSessionWorker } from "@/lib/sessionWorker.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET(request, { params }) {
  const sessionToken = params?.sessionToken || "";
  if (!sessionToken || !DB_READY || !pool) {
    return withCors(
      NextResponse.json({ success: false, allowResume: false, error: "Invalid session or DB unavailable" }, { status: 400 })
    );
  }

  startSessionWorker();
  await ensureColumns();

  try {
    const { rows } = await pool.query(
      `SELECT disconnected_at, connection_status
            , vapi_call_id, vapi_conversation_state
         FROM interview_sessions
        WHERE session_token = $1
        LIMIT 1`,
      [sessionToken]
    );
    if (!rows.length) {
      return withCors(NextResponse.json({ success: false, allowResume: false, error: "Session not found" }, { status: 404 }));
    }

    const { disconnected_at, connection_status, vapi_call_id, vapi_conversation_state } = rows[0];
    const now = Date.now();
    const discMs = disconnected_at ? now - new Date(disconnected_at).getTime() : null;
    const withinWindow = connection_status === "disconnected" && discMs !== null && discMs < DISCONNECT_EXPIRE_MS;

    if (withinWindow) {
      await pool.query(
        `UPDATE interview_sessions
           SET connection_status = 'resumed',
               last_activity_at = NOW(),
               disconnected_at = NULL
         WHERE session_token = $1`,
        [sessionToken]
      );
      console.log("[session] resumed", { sessionToken });
      return withCors(NextResponse.json({
        success: true,
        allowResume: true,
        vapi_call_id,
        vapi_conversation_state,
      }));
    }

    return withCors(NextResponse.json({ success: true, allowResume: false }));
  } catch (e) {
    console.error("[session] resume failed:", e.message);
    return withCors(NextResponse.json({ success: false, allowResume: false, error: e.message }, { status: 500 }));
  }
}
