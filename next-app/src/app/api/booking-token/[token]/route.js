import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET(request, { params }) {
  const token = params?.token || "";
  if (!token.trim()) {
    return withCors(NextResponse.json({ success: false, error: "Token is required" }, { status: 400 }));
  }
  if (!DB_READY || !pool) {
    return withCors(NextResponse.json({ success: false, error: "Database not available" }, { status: 503 }));
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT payload, agency_id, candidate_id, job_id, user_id
       FROM notification_workflow_tokens
       WHERE token = $1 AND is_active = true AND expires_at > NOW()`
      , [token]
    );
    if (!rows.length) {
      return withCors(NextResponse.json({ success: false, error: "Token invalid, expired, or already used" }, { status: 404 }));
    }
    const { payload, agency_id, candidate_id, job_id, user_id } = rows[0];
    return withCors(NextResponse.json({
      success: true,
      name: payload.candidate_name || "",
      email: payload.email || payload.candidate_email || "",
      resume_text: payload.resume_text || "",
      job_title: payload.job_title || payload.job_role || "",
      job_description: payload.job_description || "",
      agency_id: payload.agency_id || agency_id || "",
      candidate_id: payload.candidate_id || candidate_id || "",
      job_id: payload.job_id || job_id || "",
      user_id: payload.user_id || user_id || "",
      interview_questions: payload.interview_questions || payload.async_questions || [],
    }));
  } catch (e) {
    console.error("booking-token error:", e.message);
    return withCors(NextResponse.json({ success: false, error: "Failed to resolve token" }, { status: 500 }));
  } finally {
    client.release();
  }
}
