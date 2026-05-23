import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { pool, DB_READY } from "@/lib/db.js";
import { buildInterviewLink, localDateStr, parseSlotStart, sendConfirmationEmail } from "@/lib/slots.js";
import { corsHeaders, withCors } from "@/lib/cors.js";
import { ensureColumns, startSessionWorker } from "@/lib/sessionWorker.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request) {
  startSessionWorker();
  await ensureColumns();

  const body = await request.json().catch(() => ({}));
  const {
    slot_id, email, name, bookingToken,
    resume = "", jobDescription = "", jobRole = "", agencyId = "", userId = "", jobId = "", candidateId = "",
    async_questions = [], asyncQuestions, interviewQuestions,
  } = body;

  if (!slot_id || !email || !name) {
    return withCors(NextResponse.json({ success: false, error: "slot_id, email, and name are required" }, { status: 400 }));
  }

  let slotDate, slotTime, sessionId, sessionToken;

  if (DB_READY && pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `SELECT * FROM interview_slots WHERE id = $1 AND current_bookings < max_concurrent FOR UPDATE`,
        [slot_id]
      );
      if (!rows.length) {
        await client.query("ROLLBACK");
        return withCors(NextResponse.json({ success: false, error: "Slot not available" }, { status: 400 }));
      }
      const slot = rows[0];
      const slotStart = parseSlotStart(slot.slot_date, slot.slot_time);
      if (slotStart && slotStart.getTime() <= Date.now()) {
        await client.query("ROLLBACK");
        return withCors(NextResponse.json({ success: false, error: "Slot has already started" }, { status: 400 }));
      }

      slotDate = localDateStr(new Date(slot.slot_date));
      slotTime = slot.slot_time.slice(0, 5);

      let finalResume = resume;
      let finalJD = jobDescription;
      let finalJobRole = jobRole;
      let resolvedAgencyId = agencyId || "";
      let resolvedUserId = userId || "";
      let resolvedJobId = jobId || "";
      let resolvedCandidateRef = candidateId || "";
      const finalQuestions = interviewQuestions || async_questions || asyncQuestions || [];
      const isUUID = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

      if ((!finalResume || !finalJD || !finalJobRole) && bookingToken) {
        try {
          const { rows: tokRows } = await client.query(
            `SELECT payload, agency_id, candidate_id, job_id, user_id
             FROM notification_workflow_tokens
             WHERE token = $1`,
            [bookingToken]
          );
          if (tokRows.length) {
            let payload = tokRows[0].payload || {};
            if (typeof payload === "string") {
              try { payload = JSON.parse(payload); } catch { payload = {}; }
            }
            const pick = (obj, keys, fallback = "") => {
              for (const k of keys) {
                if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") return obj[k];
              }
              return fallback;
            };
            resolvedAgencyId = resolvedAgencyId || pick(payload, ["agency_id", "agencyId"], tokRows[0].agency_id || "");
            resolvedCandidateRef = resolvedCandidateRef || pick(payload, ["candidate_id", "candidateId"], tokRows[0].candidate_id || "");
            resolvedJobId = resolvedJobId || pick(payload, ["job_id", "jobId"], tokRows[0].job_id || "");
            resolvedUserId = resolvedUserId || pick(payload, ["user_id", "userId"], tokRows[0].user_id || "");
            finalResume = finalResume || pick(payload, ["resume_text", "resume", "resumeText"]);
            finalJD = finalJD || pick(payload, ["job_description", "jobDescription", "jd_text", "jd"]);
            finalJobRole = finalJobRole || pick(payload, ["job_title", "job_role", "jobRole", "role", "title"]);
          }
        } catch (e) {
          console.warn("booking-token hydrate failed:", e.message);
        }
      }
      if (!finalResume || !finalJD) {
        const { rows: cRows } = await client.query(
          `SELECT c.resume_text, c.predefined_questions, c.job_id,
                  jd.title AS job_title, jd.description AS jd_text
           FROM candidates c
           LEFT JOIN job_descriptions jd ON jd.id = c.job_id
           WHERE c.email = $1
           ORDER BY c.created_at DESC LIMIT 1`,
          [email]
        );
        if (cRows.length) {
          finalResume = finalResume || cRows[0].resume_text || "";
          finalJD = finalJD || cRows[0].jd_text || "";
          finalJobRole = finalJobRole || cRows[0].job_title || "";
        }
      }

      let actualCandidateId = "";
      if (resolvedCandidateRef && isUUID(resolvedCandidateRef)) {
        const { rows: existingCandidateRows } = await client.query(
          `UPDATE candidates
              SET name = $2,
                  email = $3,
                  resume_text = $4,
                  agency_id = COALESCE($5, agency_id)
            WHERE id = $1
            RETURNING id`,
          [resolvedCandidateRef, name, email, resume, isUUID(resolvedAgencyId) ? resolvedAgencyId : null]
        );

        if (existingCandidateRows.length) {
          actualCandidateId = existingCandidateRows[0].id;
        }
      }

      if (!actualCandidateId) {
        const candidateUUID = uuidv4();
        const finalCandidateId =
          resolvedCandidateRef && !isUUID(resolvedCandidateRef)
            ? resolvedCandidateRef
            : uuidv4().slice(0, 8);
        const { rows: candRows } = await client.query(
          `INSERT INTO candidates (id, candidate_id, name, email, resume_text, agency_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (candidate_id) DO UPDATE
             SET name = EXCLUDED.name,
                 email = EXCLUDED.email,
                 resume_text = EXCLUDED.resume_text,
                 agency_id = COALESCE(EXCLUDED.agency_id, candidates.agency_id)
           RETURNING id`,
          [candidateUUID, finalCandidateId, name, email, resume, isUUID(resolvedAgencyId) ? resolvedAgencyId : null]
        );
        actualCandidateId = candRows[0].id;
      }

      await client.query(
        `UPDATE interview_slots SET current_bookings = current_bookings + 1 WHERE id = $1`,
        [slot_id]
      );

      const normalizedAsyncQuestions = Array.isArray(async_questions)
        ? async_questions
        : Array.isArray(asyncQuestions)
          ? asyncQuestions
          : [];

      sessionToken = uuidv4();
      const questionsPayload = JSON.stringify(Array.isArray(finalQuestions) ? finalQuestions : normalizedAsyncQuestions);
      const { rows: sr } = await client.query(
        `INSERT INTO interview_sessions (agency_id, job_id, candidate_id, user_id, slot_id, candidate_name, email, job_role, jd_text, resume_text, session_token, interview_questions, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'scheduled')
         RETURNING id, session_token`,
        [
          isUUID(resolvedAgencyId) ? resolvedAgencyId : null,
          isUUID(resolvedJobId) ? resolvedJobId : null,
          actualCandidateId,
          isUUID(resolvedUserId) ? resolvedUserId : null,
          slot_id,
          name,
          email,
          finalJobRole,
          finalJD,
          finalResume,
          sessionToken,
          questionsPayload,
        ]
      );
      sessionId = sr[0].id;
      sessionToken = sr[0].session_token || sessionToken;

      const scheduledAt = new Date(`${slotDate}T${slotTime}:00`);
      const interviewLink = buildInterviewLink(sessionToken);
      await client.query(
        `INSERT INTO interviews (candidate_id, agency_id, scheduled_at, status, async_token, async_link)
         VALUES ($1, $2, $3, 'scheduled', $4, $5)
         ON CONFLICT (async_token) DO NOTHING`,
        [actualCandidateId, isUUID(resolvedAgencyId) ? resolvedAgencyId : null, scheduledAt, sessionToken, interviewLink]
      );

      await client.query("COMMIT");

      await client.query(
        `UPDATE notification_workflow_tokens SET is_active = false, consumed_at = NOW() WHERE token = $1`,
        [bookingToken || ""]
      ).catch(() => {});
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("book-slot DB error:", e.message);
      return withCors(NextResponse.json({ success: false, error: e.message }, { status: 500 }));
    } finally {
      client.release();
    }
  } else {
    slotDate = slot_id.split("-").slice(1, 4).join("-");
    slotTime = slot_id.split("-")[4]?.replace(/(\d{2})(\d{2})/, "$1:$2") || "09:00";
    sessionId = uuidv4();
    sessionToken = sessionId;
  }

  const interviewLink = buildInterviewLink(sessionToken || sessionId);
  sendConfirmationEmail(name, email, slotDate, slotTime, interviewLink);

  return withCors(NextResponse.json({
    success: true,
    message: "Slot booked successfully",
    session_id: sessionId,
    session_token: sessionToken || sessionId,
    interview_link: interviewLink,
    slot_date: slotDate,
    slot_time: slotTime,
  }));
}
