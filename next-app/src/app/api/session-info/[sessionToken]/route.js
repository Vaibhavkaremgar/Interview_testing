import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { parseSlotStart } from "@/lib/slots.js";
import { corsHeaders, withCors } from "@/lib/cors.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET(request, { params }) {
  const sessionToken = params?.sessionToken || "";
  if (!sessionToken.trim()) {
    return withCors(NextResponse.json({ success: false, error: "Session token is required" }, { status: 400 }));
  }
  if (!DB_READY || !pool) {
    return withCors(NextResponse.json({ success: false, error: "Database not available" }, { status: 503 }));
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT candidate_name, email, resume_text, job_role, jd_text, agency_id, candidate_id, user_id, job_id,
              session_token, last_transcript_snapshot, interview_questions, slot_id
       FROM interview_sessions
       WHERE session_token = $1`,
      [sessionToken]
    );
    if (!rows.length) {
      return withCors(NextResponse.json({ success: false, error: "Session not found" }, { status: 404 }));
    }

    const d = rows[0];
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
    const slotStart = parseSlotStart(slotDateStr, slotTimeStr);
    if (slotStart) {
      const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);
      if (Date.now() > slotEnd.getTime()) {
        return withCors(NextResponse.json({
          success: false,
          error: "Interview link expired for the selected slot",
          slot_date: slotDateStr,
          slot_time: slotTimeStr,
        }, { status: 410 }));
      }
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
      interview_questions: d.interview_questions || [],
      slot_date: slotDateStr,
      slot_time: slotTimeStr,
    }));
  } catch (e) {
    console.error("session-info error:", e.message);
    return withCors(NextResponse.json({ success: false, error: "Failed to fetch session info" }, { status: 500 }));
  } finally {
    client.release();
  }
}
