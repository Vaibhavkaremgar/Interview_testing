import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request) {
  const { recordingUrl, sessionToken } = await request.json().catch(() => ({}));
  if (!recordingUrl) return withCors(NextResponse.json({ success: false }, { status: 400 }));

  if (sessionToken && DB_READY && pool) {
    pool.query(
      `UPDATE interview_sessions SET vapi_recording_url = $1 WHERE session_token = $2`,
      [recordingUrl, sessionToken]
    ).catch(e => console.warn("Could not save vapi_recording_url:", e.message));
  }

  return withCors(NextResponse.json({ success: true }));
}
