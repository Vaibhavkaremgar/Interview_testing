import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { parseSlotStart } from "@/lib/slots.js";
import { corsHeaders, withCors } from "@/lib/cors.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET(request, { params }) {
  const url = new URL(request.url);
  const tokenFromQuery = url.searchParams.get("session") || url.searchParams.get("sessionToken");
  const tokenFromPath = params?.sessionToken || url.pathname.split("/").pop();
  const sessionToken = (tokenFromQuery || tokenFromPath || "").toString().trim();
  if (!sessionToken) {
    return withCors(NextResponse.json({
      success: false,
      error: "Session token is required",
      debug: { tokenFromQuery, tokenFromPath, pathname: url.pathname },
    }, { status: 400 }));
  }

  if (!DB_READY || !pool) {
    return withCors(NextResponse.json({ success: false, error: "Database not available" }, { status: 503 }));
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT candidate_name, email, resume_text, job_role, jd_text, agency_id, candidate_id, user_id, job_id,
              session_token, last_transcript_snapshot, interview_questions, slot_id, status, ended_at
       FROM interview_sessions
       WHERE session_token = $1`,
      [sessionToken]
    );
    if (!rows.length) {
      return withCors(NextResponse.json({ success: false, error: "Session not found" }, { status: 404 }));
    }

    const d = rows[0];
    const isEmpty = (v) => v === null || v === undefined || String(v).trim() === "";

    if (isEmpty(d.candidate_name) || isEmpty(d.email) || isEmpty(d.resume_text) || isEmpty(d.jd_text) || isEmpty(d.job_role)) {
      try {
        const fallback = await client.query(
          `SELECT c.name, c.email, c.resume_text, jd.title AS job_title, jd.description AS jd_text
           FROM interview_sessions s
           LEFT JOIN candidates c ON c.id = s.candidate_id
           LEFT JOIN job_descriptions jd ON jd.id = s.job_id
           WHERE s.session_token = $1`,
          [sessionToken]
        );
        if (fallback.rows.length) {
          d.candidate_name = d.candidate_name || fallback.rows[0].name || "";
          d.email = d.email || fallback.rows[0].email || "";
          d.resume_text = d.resume_text || fallback.rows[0].resume_text || "";
          d.job_role = d.job_role || fallback.rows[0].job_title || "";
          d.jd_text = d.jd_text || fallback.rows[0].jd_text || "";
        }
      } catch (e) {
        console.warn("session-info fallback lookup failed:", e.message);
      }
    }
    let asyncQuestions = [];
    if (d.async_questions) {
      try {
        asyncQuestions = typeof d.async_questions === "string" ? JSON.parse(d.async_questions) : d.async_questions;
      } catch (parseErr) {
        asyncQuestions = [];
      }
    }

    let slotMeta = null;
    if (d.slot_id && !d.slot_id.startsWith("mem-")) {
      const slotRes = await client.query(`SELECT slot_date, slot_time FROM interview_slots WHERE id = $1`, [d.slot_id]);
      if (slotRes.rows.length) slotMeta = slotRes.rows[0];
    }
    const slotDateStr = slotMeta?.slot_date instanceof Date
      ? slotMeta.slot_date.toISOString().slice(0, 10)
      : slotMeta?.slot_date || null;
    const slotTimeStr = slotMeta?.slot_time ? slotMeta.slot_time.toString().slice(0, 8) : null;
    let expired = false;

    // Hard-expire if interview already completed/ended
    try {
      const interview = await client.query(
        `SELECT status, async_completed_at FROM interviews WHERE async_token = $1 LIMIT 1`,
        [sessionToken]
      );
      const status = interview.rows?.[0]?.status || d.status || "";
      const asyncCompletedAt = interview.rows?.[0]?.async_completed_at || null;
      const sessionEnded = d.ended_at;
      if (["completed", "ended", "failed", "cancelled"].includes(String(status).toLowerCase()) || asyncCompletedAt || sessionEnded) {
        expired = true;
      }
    } catch (e) {
      console.warn("session-info interview status lookup failed:", e.message);
    }

    if (expired) {
      return withCors(NextResponse.json({ success: false, error: "Interview session has ended.", expired: true }, { status: 410 }));
    }

    let interviewQuestions = d.interview_questions || [];
    if (typeof interviewQuestions === "string") {
      try { interviewQuestions = JSON.parse(interviewQuestions); } catch { interviewQuestions = []; }
    }

    return withCors(NextResponse.json({
      success: true,
      name: d.candidate_name,
      email: d.email,
      resume_text: d.resume_text,
      job_title: d.job_role,
      job_description: d.jd_text,
      candidate_id: d.candidate_id,
      agency_id: d.agency_id,
      user_id: d.user_id,
      job_id: d.job_id,
      session_token: d.session_token,
      resumed: !!d.last_transcript_snapshot,
      lastTranscript: d.last_transcript_snapshot || null,
      interview_questions: interviewQuestions,
      slot_date: slotDateStr,
      slot_time: slotTimeStr,
      expired,
    }));
  } catch (e) {
    console.error("session-info error:", e.message);
    return withCors(NextResponse.json({ success: false, error: "Failed to fetch session info" }, { status: 500 }));
  } finally {
    client.release();
  }
}
