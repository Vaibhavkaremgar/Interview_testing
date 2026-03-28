import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { applyCors, corsHeaders, withCors } from "@/lib/cors.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET(request, { params }) {
  const sessionToken = params?.sessionToken || "";
  if (!DB_READY || !pool) {
    return withCors(NextResponse.json({ error: "DB not available" }, { status: 503 }));
  }
  try {
    const { rows } = await pool.query(
      `SELECT recording_data, recording_path FROM interview_sessions WHERE session_token = $1`,
      [sessionToken]
    );
    if (!rows.length || !rows[0].recording_data) {
      return withCors(NextResponse.json({ error: "Recording not found" }, { status: 404 }));
    }
    const headers = new Headers();
    headers.set("Content-Type", "video/webm");
    headers.set("Content-Disposition", `inline; filename="${sessionToken}.webm"`);
    applyCors(headers);
    return new Response(rows[0].recording_data, { headers });
  } catch (e) {
    return withCors(NextResponse.json({ error: e.message }, { status: 500 }));
  }
}
