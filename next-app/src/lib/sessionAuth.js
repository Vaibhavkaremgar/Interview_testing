import { pool, DB_READY } from "./db.js";

const ENDED_STATUSES = new Set(["completed", "ended", "failed", "cancelled", "expired", "no_show"]);

function isEndedStatus(status) {
  return ENDED_STATUSES.has((status || "").toString().trim().toLowerCase());
}

async function validateInterviewSessionToken(sessionToken, { allowEnded = false } = {}) {
  const token = (sessionToken || "").toString().trim();
  if (!token) {
    return { ok: false, status: 401, error: "Session token is required" };
  }
  if (!DB_READY || !pool) {
    return { ok: false, status: 503, error: "Database unavailable" };
  }

  try {
    const sessionRes = await pool.query(
      `SELECT status, ended_at
         FROM interview_sessions
        WHERE session_token = $1
        LIMIT 1`,
      [token]
    );
    if (!sessionRes.rows.length) {
      return { ok: false, status: 404, error: "Session not found" };
    }

    if (!allowEnded) {
      const sessionRow = sessionRes.rows[0];
      if (sessionRow.ended_at || isEndedStatus(sessionRow.status)) {
        return { ok: false, status: 410, error: "Session has ended" };
      }

      const interviewRes = await pool.query(
        `SELECT status, async_completed_at
           FROM interviews
          WHERE async_token = $1
          LIMIT 1`,
        [token]
      );
      const interview = interviewRes.rows[0];
      if (interview?.async_completed_at || isEndedStatus(interview?.status)) {
        return { ok: false, status: 410, error: "Session has ended" };
      }
    }

    return { ok: true, token };
  } catch (e) {
    console.error("[session-auth] validation failed:", e.message);
    return { ok: false, status: 500, error: "Failed to validate session token" };
  }
}

export { validateInterviewSessionToken };
