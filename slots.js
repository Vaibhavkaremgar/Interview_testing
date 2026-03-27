const express = require("express");
const router  = express.Router();
const { v4: uuidv4 } = require("uuid");
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

const FRONTEND_INTERVIEW_URL = process.env.FRONTEND_INTERVIEW_URL || "http://localhost:3000/interview";
const DB_ENABLED = !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("user:password");
const CONCURRENT_INTERVIEWS = Number(process.env.CONCURRENT_INTERVIEWS) || 3;
const SLOT_CLEANUP_INTERVAL_MS = Number(process.env.SLOT_CLEANUP_INTERVAL_MS) || 5 * 60 * 1000;

let pool = null;
if (DB_ENABLED) {
  try { pool = require("./db").pool; } catch (e) { console.warn("  DB pool load failed:", e.message); }
}

//  TIMEZONE HELPERS (always use local/IST time) 
function localDateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localTimeStr(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:00`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function parseSlotStart(slotDate, slotTime) {
  if (!slotDate || !slotTime) return null;
  const normalizedTime = slotTime.includes(":") ? slotTime.split(".")[0] : slotTime;
  const [h = "00", m = "00", s = "00"] = normalizedTime.split(":").map(part => part.padStart(2, "0"));
  return new Date(`${slotDate}T${h}:${m}:${s}+05:30`);
}

//  SLOT TIMES: 9:00 AM to 5:30 PM, every 30 min 
function slotTimes() {
  const times = [];
  for (let h = 9; h < 18; h++) {
    times.push(`${String(h).padStart(2, "0")}:00:00`);
    times.push(`${String(h).padStart(2, "0")}:30:00`);
  }
  return times;
}

//  GENERATE SLOTS FOR TODAY, TOMORROW, DAY AFTER 
async function generateSlots() {
  if (!DB_ENABLED || !pool) return;
  try {
    const now   = new Date();
    const dates = [localDateStr(now), localDateStr(addDays(now, 1)), localDateStr(addDays(now, 2))];
    const times = slotTimes();

    let inserted = 0;
    for (const slot_date of dates) {
      for (const slot_time of times) {
        const { rowCount } = await pool.query(
          `INSERT INTO interview_slots (slot_date, slot_time, max_concurrent, current_bookings)
           SELECT $1, $2, $3, 0
           WHERE NOT EXISTS (
             SELECT 1 FROM interview_slots WHERE slot_date = $1 AND slot_time = $2
           )`,
          [slot_date, slot_time, CONCURRENT_INTERVIEWS]
        );
        if (rowCount > 0) inserted++;
      }
    }
    if (inserted > 0) console.log(` Generated ${inserted} slot(s) for ${dates.join(", ")}`);
  } catch (e) {
    console.error("Slot generation failed:", e.message);
  }
}

//  DELETE PAST SLOTS 
async function deletePastSlots() {
  if (!DB_ENABLED || !pool) return;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM interview_slots
       WHERE (slot_date + slot_time + interval '30 minutes') < (NOW() AT TIME ZONE 'Asia/Kolkata')`
    );
    if (rowCount > 0) console.log(`  Deleted ${rowCount} past slot(s)`);
  } catch (e) {
    console.error("Past slot cleanup failed:", e.message);
  }
}

// Run on startup and on a short heartbeat so we never return stale options
generateSlots();
deletePastSlots();
setInterval(generateSlots, 60 * 60 * 1000);
setInterval(deletePastSlots, SLOT_CLEANUP_INTERVAL_MS);
//  IN-MEMORY FALLBACK 
function generateInMemorySlots() {
  const now      = new Date();
  const todayStr = localDateStr(now);
  const curMins  = now.getHours() * 60 + now.getMinutes();
  const slots    = [];

  for (let d = 0; d < 3; d++) {
    const dateStr = localDateStr(addDays(now, d));
    for (let h = 9; h < 18; h++) {
      for (let m = 0; m < 60; m += 30) {
        if (dateStr === todayStr && h * 60 + m <= curMins) continue;
        slots.push({
          slot_id:   `mem-${dateStr}-${String(h).padStart(2,"0")}${String(m).padStart(2,"0")}`,
          slot_date: dateStr,
          slot_time: `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`,
          available: CONCURRENT_INTERVIEWS,
        });
      }
    }
  }
  return slots;
}

//  HELPERS 
function formatDateLong(dateStr) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

function formatTimeFull(timeStr) {
  const [h, m] = timeStr.split(":");
  const hour = parseInt(h);
  return `${hour > 12 ? hour - 12 : hour || 12}:${m} ${hour >= 12 ? "PM" : "AM"}`;
}

async function sendConfirmationEmail(name, email, date, time, interviewLink) {
  const displayDate = formatDateLong(date);
  const displayTime = formatTimeFull(time);

  await resend.emails.send({
    from: "Pontis Interviews <onboarding@resend.dev>",
    to: email,
    subject: `Your Interview is Confirmed  ${displayDate}`,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Segoe UI,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:40px 0">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 40px rgba(15,23,42,0.12)">
        <tr>
          <td style="padding:28px 40px 12px">
            <p style="margin:0;font-size:22px;font-weight:700;color:#0f172a">Pontis AI Interview Platform</p>
            <p style="margin:6px 0 0;font-size:14px;font-weight:600;color:#475569;letter-spacing:0.1em;text-transform:uppercase">Interview Confirmed</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 32px">
            <p style="margin:0 0 14px;font-size:16px;color:#0f172a">Dear ${name},</p>
            <p style="margin:0;font-size:15px;color:#475569;line-height:1.6">
              Your AI video interview is scheduled. Below are the confirmed details and the link you will use on the day of the interview.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 16px">
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px">
              <tr>
                <td style="padding:18px 20px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em">Interview Date</td>
                <td style="padding:18px 20px;border-bottom:1px solid #e2e8f0;font-size:15px;font-weight:600;color:#0f172a">${displayDate}</td>
              </tr>
              <tr>
                <td style="padding:18px 20px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em">Interview Time</td>
                <td style="padding:18px 20px;border-bottom:1px solid #e2e8f0;font-size:15px;font-weight:600;color:#0f172a">${displayTime}</td>
              </tr>
              <tr>
                <td style="padding:18px 20px;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em">Format</td>
                <td style="padding:18px 20px;font-size:15px;font-weight:600;color:#0f172a">AI Video Interview</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 24px">
            <div style="text-align:left">
              <a href="${interviewLink}" style="display:inline-block;background:#1e1b4d;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:999px;font-size:15px">
                Start Interview
              </a>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 32px">
            <p style="margin:0 0 4px;font-size:14px;color:#475569;line-height:1.6">Before you begin:</p>
            <ul style="margin:0 0 0 16px;padding:0;color:#475569;font-size:14px;line-height:1.6">
              <li style="margin-bottom:4px">Use Google Chrome or Microsoft Edge for the best experience.</li>
              <li style="margin-bottom:4px">Allow camera and microphone access when prompted.</li>
              <li style="margin-bottom:4px">Find a quiet, well-lit space to speak freely.</li>
              <li style="margin-bottom:0">Test your audio before clicking the interview link.</li>
            </ul>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 32px">
            <p style="margin:0;font-size:13px;color:#94a3b8">This link is unique to you and must not be shared. Keep your browser tab open until the interview begins.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;background:#0f172a">
            <p style="margin:0;font-size:13px;color:#94a3b8">Pontis AI Interview Platform  Automated message</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
  });
}

//  ROUTES 

router.get("/booking-token/:token", async (req, res) => {
  const { token } = req.params;
  if (!token || !token.trim()) return res.status(400).json({ success: false, error: "Token is required" });
  if (!DB_ENABLED || !pool) return res.status(503).json({ success: false, error: "Database not available" });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT payload, agency_id, candidate_id, job_id, user_id
       FROM notification_workflow_tokens
       WHERE token = $1 AND is_active = true AND expires_at > NOW()`,
      [token]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: "Token invalid, expired, or already used" });
    const { payload, agency_id, candidate_id, job_id, user_id } = rows[0];
    return res.json({
      success:          true,
      name:             payload.candidate_name      || "",
      email:            payload.email               || payload.candidate_email || "",
      resume_text:      payload.resume_text         || "",
      job_title:        payload.job_title           || payload.job_role || "",
      job_description:  payload.job_description     || "",
      agency_id:        payload.agency_id           || agency_id || "",
      candidate_id:     payload.candidate_id        || candidate_id || "",
      job_id:           payload.job_id              || job_id || "",
      user_id:          payload.user_id             || user_id || "",
      interview_questions: payload.interview_questions || payload.async_questions || [],
    });
  } catch (e) {
    console.error(" booking-token error:", e.message);
    return res.status(500).json({ success: false, error: "Failed to resolve token" });
  } finally {
    client.release();
  }
});

router.get("/available-slots", async (req, res) => {
  if (DB_ENABLED && pool) {
    const client = await pool.connect();
    try {
      await deletePastSlots();
      const { rows: timeRows } = await client.query(`SELECT NOW() AT TIME ZONE 'Asia/Kolkata' AS now`);
      const now         = new Date(timeRows[0].now + '+05:30');
      const todayStr    = localDateStr(now);
      const day1Str     = localDateStr(addDays(now, 1));
      const day2Str     = localDateStr(addDays(now, 2));
      const currentTime = localTimeStr(now);

      const { rows } = await client.query(`
        SELECT id, slot_date::text, slot_time, max_concurrent, current_bookings
        FROM interview_slots
        WHERE current_bookings < max_concurrent
          AND (
            (slot_date = $1 AND slot_time >= $4)
            OR slot_date = $2
            OR slot_date = $3
          )
        ORDER BY slot_date, slot_time
      `, [todayStr, day1Str, day2Str, currentTime]);

      console.log(` Serving slots: ${todayStr}(today), ${day1Str}(tomorrow), ${day2Str}(day after)  found ${rows.length}`);

      return res.json({
        success: true,
        mode: "db",
        slots: rows.map(r => ({
          slot_id:   r.id,
          slot_date: r.slot_date,
          slot_time: r.slot_time.slice(0, 5),
          available: r.max_concurrent - r.current_bookings,
        })),
      });
    } catch (e) {
      console.error(" DB slots error:", e.message);
    } finally {
      client.release();
    }
  }

  console.log(" Serving in-memory slots (DB not connected)");
  return res.json({ success: true, mode: "memory", slots: generateInMemorySlots() });
});

router.post("/book-slot", async (req, res) => {
  const {
    slot_id, email, name, bookingToken,
    resume = "", jobDescription = "", jobRole = "", agencyId = "", userId = "", jobId = "", candidateId = "",
    async_questions = [], asyncQuestions, interviewQuestions,
  } = req.body;

  if (!slot_id || !email || !name) {
    return res.status(400).json({ success: false, error: "slot_id, email, and name are required" });
  }

  let slotDate, slotTime, sessionId, sessionToken;

  if (DB_ENABLED && pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

        const { rows } = await client.query(
          `SELECT * FROM interview_slots WHERE id = $1 AND current_bookings < max_concurrent FOR UPDATE`,
          [slot_id]
        );
        if (!rows.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, error: "Slot not available" });
        }
        const slot = rows[0];
        const slotStart = parseSlotStart(slot.slot_date, slot.slot_time);
        if (slotStart && slotStart.getTime() <= Date.now()) {
          await client.query("ROLLBACK");
          return res.status(400).json({ success: false, error: "Slot has already started" });
        }
        slotDate = localDateStr(new Date(slot.slot_date));
      slotTime = slot.slot_time.slice(0, 5);

      const candidateUUID    = uuidv4();
      const finalCandidateId = candidateId || uuidv4().slice(0, 8);
      const { rows: candRows } = await client.query(
        `INSERT INTO candidates (id, candidate_id, name, email, resume_text, agency_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (candidate_id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, resume_text = EXCLUDED.resume_text
         RETURNING id`,
        [candidateUUID, finalCandidateId, name, email, resume, agencyId || null]
      );
      const actualCandidateId = candRows[0].id;

      await client.query(
        `UPDATE interview_slots SET current_bookings = current_bookings + 1 WHERE id = $1`,
        [slot_id]
      );

      // Pull resume + JD from candidates/job_descriptions if not provided
      let finalResume = resume;
      let finalJD = jobDescription;
      let finalJobRole = jobRole;
      const finalQuestions = interviewQuestions || async_questions || asyncQuestions || [];
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
          finalResume   = finalResume   || cRows[0].resume_text        || "";
          finalJD       = finalJD       || cRows[0].jd_text            || "";
          finalJobRole  = finalJobRole  || cRows[0].job_title          || "";
        }
      }

      const isUUID = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
      sessionToken = uuidv4();
      const normalizedAsyncQuestions = Array.isArray(async_questions)
        ? async_questions
        : Array.isArray(asyncQuestions)
          ? asyncQuestions
          : [];
      const asyncQuestionsPayload = JSON.stringify(normalizedAsyncQuestions);

      const { rows: sr } = await client.query(
        `INSERT INTO interview_sessions (agency_id, job_id, candidate_id, user_id, slot_id, candidate_name, email, job_role, jd_text, resume_text, session_token, interview_questions, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'scheduled')
         RETURNING id, session_token`,
        [
          isUUID(agencyId)?agencyId:null,
          isUUID(jobId)?jobId:null,
          actualCandidateId,
          isUUID(userId)?userId:null,
          slot_id,
          name,
          email,
          finalJobRole,
          finalJD,
          finalResume,
          sessionToken,
          JSON.stringify(finalQuestions),
        ]
      );
      sessionId = sr[0].id;

      const scheduledAt = new Date(`${slotDate}T${slotTime}:00`);
      const asyncLink   = `${FRONTEND_INTERVIEW_URL}?session=${sessionToken}`;
      await client.query(
        `INSERT INTO interviews (candidate_id, agency_id, scheduled_at, status, async_token, async_link)
         VALUES ($1, $2, $3, 'scheduled', $4, $5)
         ON CONFLICT (async_token) DO NOTHING`,
        [actualCandidateId, isUUID(agencyId)?agencyId:null, scheduledAt, sessionToken, asyncLink]
      );
      console.log(' interviews row inserted for token:', sessionToken);

      await client.query("COMMIT");
      // Mark booking token as consumed  prevents rebooking
      pool.query(
        `UPDATE notification_workflow_tokens SET is_active = false, consumed_at = NOW() WHERE token = $1`,
        [req.body.bookingToken || ""]
      ).catch(() => {});
      client.release();
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      console.error(" book-slot DB error:", e.message);
      return res.status(500).json({ success: false, error: e.message });
    }
  } else {
    slotDate  = slot_id.split("-").slice(1, 4).join("-");
    slotTime  = slot_id.split("-")[4]?.replace(/(\d{2})(\d{2})/, "$1:$2") || "09:00";
    sessionId = uuidv4();
    console.log(" In-memory booking  no DB write");
  }

  const meetParams    = new URLSearchParams({ session: sessionToken || sessionId });
  const interviewLink = `${FRONTEND_INTERVIEW_URL}?${meetParams.toString()}`;

  console.log(" Meet link generated:", interviewLink.slice(0, 80) + "...");
  sendConfirmationEmail(name, email, slotDate, slotTime, interviewLink);

  return res.json({ success: true, message: "Slot booked successfully", session_id: sessionId, interview_link: interviewLink, slot_date: slotDate, slot_time: slotTime });
});

router.get("/session-info/:sessionToken", async (req, res) => {
  const { sessionToken } = req.params;
  if (!sessionToken || !sessionToken.trim()) return res.status(400).json({ success: false, error: "Session token is required" });
  if (!DB_ENABLED || !pool) return res.status(503).json({ success: false, error: "Database not available" });

  const client = await pool.connect();
  try {
    // Read directly from interview_sessions  all data was stored here at booking time
    const { rows } = await client.query(
      `SELECT candidate_name, email, resume_text, job_role, jd_text, agency_id, candidate_id, user_id, job_id, session_token, last_transcript_snapshot, interview_questions, slot_id
       FROM interview_sessions
       WHERE session_token = $1`,
      [sessionToken]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: "Session not found" });
    const d = rows[0];
    let asyncQuestions = [];
      if (d.async_questions) {
        try {
          asyncQuestions = typeof d.async_questions === "string"
            ? JSON.parse(d.async_questions)
            : d.async_questions;
      } catch (parseErr) {
        console.warn("Could not parse async_questions:", parseErr.message);
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
          return res.status(410).json({
            success: false,
            error: "Interview link expired for the selected slot",
            slot_date: slotDateStr,
            slot_time: slotTimeStr,
          });
        }
      }
      console.log(` session-info: ${d.candidate_name} | role: ${d.job_role} | resume: ${(d.resume_text||'').length} chars | jd: ${(d.jd_text||'').length} chars`);
      return res.json({
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
      });
  } catch (e) {
    console.error(" session-info error:", e.message);
    return res.status(500).json({ success: false, error: "Failed to fetch session info" });
  } finally {
    client.release();
  }
});

module.exports = router;
