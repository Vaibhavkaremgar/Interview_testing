import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET(request, { params }) {
  const url = new URL(request.url);
  const tokenFromQuery = url.searchParams.get("token");
  const tokenFromPath = params?.token || url.pathname.split("/").pop();
  const token = (tokenFromQuery || tokenFromPath || "").trim();
  if (!token.trim()) {
    return withCors(NextResponse.json({ success: false, error: "Token is required" }, { status: 400 }));
  }
  if (!DB_READY || !pool) {
    return withCors(NextResponse.json({ success: false, error: "Database not available" }, { status: 503 }));
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT payload, agency_id, candidate_id, job_id, user_id,
              is_active, expires_at, consumed_at
       FROM notification_workflow_tokens
       WHERE token = $1`
      , [token]
    );
    if (!rows.length) {
      console.warn("[booking-token] token not found", { token });
      return withCors(NextResponse.json({ success: false, error: "Token invalid, expired, or already used" }, { status: 404 }));
    }

    const row = rows[0];
    const isActive = row.is_active === null || row.is_active === undefined ? true : row.is_active === true;
    const isExpired = row.expires_at ? new Date(row.expires_at).getTime() <= Date.now() : false;
    const isConsumed = !!row.consumed_at;

    if (!isActive || isExpired || isConsumed) {
      console.warn("[booking-token] token rejected", {
        token,
        isActive,
        isExpired,
        isConsumed,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
      });
      return withCors(NextResponse.json({ success: false, error: "Token invalid, expired, or already used" }, { status: 404 }));
    }

    let payload = row.payload || {};
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch { payload = {}; }
    }
    const { agency_id, candidate_id, job_id, user_id } = row;
    const pick = (obj, keys, fallback = "") => {
      for (const k of keys) {
        if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") return obj[k];
      }
      return fallback;
    };
    return withCors(NextResponse.json({
      success: true,
      name: pick(payload, ["candidate_name", "candidateName", "name"]),
      email: pick(payload, ["email", "candidate_email", "candidateEmail"]),
      resume_text: pick(payload, ["resume_text", "resume", "resumeText"]),
      job_title: pick(payload, ["job_title", "job_role", "jobRole", "role", "title"]),
      job_description: pick(payload, ["job_description", "jobDescription", "jd_text", "jd", "description"]),
      agency_id: pick(payload, ["agency_id", "agencyId"], agency_id || ""),
      candidate_id: pick(payload, ["candidate_id", "candidateId"], candidate_id || ""),
      job_id: pick(payload, ["job_id", "jobId"], job_id || ""),
      user_id: pick(payload, ["user_id", "userId"], user_id || ""),
      interview_questions: payload.interview_questions || payload.async_questions || payload.asyncQuestions || [],
    }));
  } catch (e) {
    console.error("booking-token error:", e.message);
    return withCors(NextResponse.json({ success: false, error: "Failed to resolve token" }, { status: 500 }));
  } finally {
    client.release();
  }
}
