const express = require("express");
const router  = express.Router();
const { v4: uuidv4 } = require("uuid");
const nodemailer = require("nodemailer");

const FRONTEND_INTERVIEW_URL = process.env.FRONTEND_INTERVIEW_URL || "http://localhost:3000/interview";
const DB_ENABLED = !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("user:password");

let pool = null;
if (DB_ENABLED) {
  try { pool = require("./db").pool; } catch (e) { console.warn("⚠️  DB pool load failed:", e.message); }
}

// ── TIMEZONE HELPERS (always use local/IST time) ──────────────
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

// ── SLOT TIMES: 9:00 AM to 5:30 PM, every 30 min ─────────────
function slotTimes() {
  const times = [];
  for (let h = 9; h < 18; h++) {
    times.push(`${String(h).padStart(2, "0")}:00:00`);
    times.push(`${String(h).padStart(2, "0")}:30:00`);
  }
  return times;
}

// ── GENERATE SLOTS FOR TODAY, TOMORROW, DAY AFTER ─────────────
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
           SELECT $1, $2, 3, 0
           WHERE NOT EXISTS (
             SELECT 1 FROM interview_slots WHERE slot_date = $1 AND slot_time = $2
           )`,
          [slot_date, slot_time]
        );
        if (rowCount > 0) inserted++;
      }
    }
    if (inserted > 0) console.log(`✅ Generated ${inserted} slot(s) for ${dates.join(", ")}`);
  } catch (e) {
    console.error("Slot generation failed:", e.message);
  }
}

// ── DELETE PAST SLOTS ─────────────────────────────────────────
async function deletePastSlots() {
  if (!DB_ENABLED || !pool) return;
  try {
    const now         = new Date();
    const todayStr    = localDateStr(now);
    const currentTime = localTimeStr(now);

    const { rowCount } = await pool.query(
      `DELETE FROM interview_slots
       WHERE slot_date < $1
          OR (slot_date = $1 AND slot_time < $2)`,
      [todayStr, currentTime]
    );
    if (rowCount > 0) console.log(`🗑️  Deleted ${rowCount} past slot(s)`);
  } catch (e) {
    console.error("Past slot cleanup failed:", e.message);
  }
}

// Run on startup and every hour
generateSlots();
deletePastSlots();
setInterval(() => { generateSlots(); deletePastSlots(); }, 60 * 60 * 1000);

// ── IN-MEMORY FALLBACK ────────────────────────────────────────
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
          available: 3,
        });
      }
    }
  }
  return slots;
}

// ── HELPERS ───────────────────────────────────────────────────
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

async function sendConfirmationEmail(candidateName, candidateEmail, slotDate, slotTime, interviewLink) {
  if (!process.env.GMAIL_SENDER || !process.env.GMAIL_APP_PASSWORD) {
    console.log("Email skipped — GMAIL_SENDER / GMAIL_APP_PASSWORD not set");
    console.log("Interview link:", interviewLink);
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_SENDER, pass: process.env.GMAIL_APP_PASSWORD },
    });

    const displayDate = formatDateLong(slotDate);
    const displayTime = formatTimeFull(slotTime);

    await transporter.sendMail({
      from:    `Pontis Interviews <${process.env.GMAIL_SENDER}>`,
      to:      candidateEmail,
      subject: `Interview Confirmation — ${displayDate}`,
      html: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:4px;overflow:hidden;border:1px solid #e4e4e7">
        <tr>
          <td style="background:#1a1d27;padding:28px 40px">
            <p style="margin:0;font-size:18px;font-weight:600;color:#ffffff;letter-spacing:0.3px">Pontis</p>
            <p style="margin:4px 0 0;font-size:12px;color:#94a3b8;letter-spacing:0.5px;text-transform:uppercase">AI Interview Platform</p>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 32px">
            <p style="margin:0 0 24px;font-size:15px;color:#3f3f46">Dear ${candidateName},</p>
            <p style="margin:0 0 24px;font-size:15px;color:#3f3f46;line-height:1.6">Your interview has been scheduled. Please find the details below.</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;margin-bottom:32px">
              <tr>
                <td style="padding:20px 24px;border-bottom:1px solid #e2e8f0">
                  <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;color:#94a3b8;font-weight:600">Date</p>
                  <p style="margin:6px 0 0;font-size:15px;color:#0f172a;font-weight:500">${displayDate}</p>
                </td>
              </tr>
              <tr>
                <td style="padding:20px 24px;border-bottom:1px solid #e2e8f0">
                  <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;color:#94a3b8;font-weight:600">Time</p>
                  <p style="margin:6px 0 0;font-size:15px;color:#0f172a;font-weight:500">${displayTime}</p>
                </td>
              </tr>
              <tr>
                <td style="padding:20px 24px">
                  <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;color:#94a3b8;font-weight:600">Format</p>
                  <p style="margin:6px 0 0;font-size:15px;color:#0f172a;font-weight:500">AI Video Interview</p>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 20px;font-size:15px;color:#3f3f46;line-height:1.6">Please join the interview at your scheduled time using the link below. Ensure your camera and microphone are working before joining.</p>
            <table cellpadding="0" cellspacing="0" style="margin-bottom:32px">
              <tr>
                <td style="background:#1a73e8;border-radius:4px">
                  <a href="${interviewLink}" target="_blank" style="display:inline-block;padding:13px 28px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;letter-spacing:0.2px">Join Interview</a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px;font-size:13px;color:#71717a">If the button above does not work, copy and paste the following link into your browser:</p>
            <p style="margin:0;font-size:12px;color:#1a73e8;word-break:break-all"><a href="${interviewLink}" style="color:#1a73e8;text-decoration:none">${interviewLink}</a></p>
          </td>
        </tr>
        <tr><td style="padding:0 40px"><hr style="border:none;border-top:1px solid #e4e4e7;margin:0"></td></tr>
        <tr>
          <td style="padding:24px 40px">
            <p style="margin:0 0 4px;font-size:12px;color:#a1a1aa">This is an automated message. Please do not reply to this email.</p>
            <p style="margin:0;font-size:12px;color:#a1a1aa">Pontis AI Interview Platform</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    });
    console.log("Email sent to", candidateEmail);
    return true;
  } catch (e) {
    console.error("Email failed:", e.message);
    return false;
  }
}

// ── ROUTES ────────────────────────────────────────────────────

router.get("/booking-token/:token", async (req, res) => {
  const { token } = req.params;
  if (!token || !token.trim()) return res.status(400).json({ success: false, error: "Token is required" });
  if (!DB_ENABLED || !pool) return res.status(503).json({ success: false, error: "Database not available" });

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT c.name, c.email, c.resume_text, jd.title, jd.description, bl.agency_id, bl.candidate_id, bl.job_id, bl.user_id
       FROM booking_links bl
       JOIN candidates c ON c.id = bl.candidate_id
       JOIN job_descriptions jd ON jd.id = bl.job_id
       WHERE bl.token = $1 AND bl.used = false AND bl.expires_at > NOW()`,
      [token]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: "Token invalid, expired, or already used" });
    const d = rows[0];
    return res.json({ success: true, name: d.name, email: d.email, resume_text: d.resume_text, job_title: d.title, job_description: d.description, agency_id: d.agency_id, candidate_id: d.candidate_id, job_id: d.job_id, user_id: d.user_id });
  } catch (e) {
    console.error("❌ booking-token error:", e.message);
    return res.status(500).json({ success: false, error: "Failed to resolve token" });
  } finally {
    client.release();
  }
});

router.get("/available-slots", async (req, res) => {
  if (DB_ENABLED && pool) {
    const client = await pool.connect();
    try {
      const now         = new Date();
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

      console.log(`📅 Serving slots: ${todayStr}(today), ${day1Str}(tomorrow), ${day2Str}(day after) — found ${rows.length}`);

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
      console.error("❌ DB slots error:", e.message);
    } finally {
      client.release();
    }
  }

  console.log("📋 Serving in-memory slots (DB not connected)");
  return res.json({ success: true, mode: "memory", slots: generateInMemorySlots() });
});

router.post("/book-slot", async (req, res) => {
  const {
    slot_id, email, name,
    resume = "", jobDescription = "", jobRole = "", agencyId = "", userId = "", jobId = "", candidateId = "",
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

      sessionToken = uuidv4();
      const { rows: sr } = await client.query(
        `INSERT INTO interview_sessions (agency_id, job_id, candidate_id, user_id, slot_id, candidate_name, email, job_role, jd_text, resume_text, session_token, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'scheduled')
         RETURNING id, session_token`,
        [agencyId||null, jobId||null, actualCandidateId, userId||null, slot_id, name, email, finalJobRole, finalJD, finalResume, sessionToken]
      );
      sessionId = sr[0].id;

      const scheduledAt = new Date(`${slotDate}T${slotTime}:00`);
      const asyncLink   = `${FRONTEND_INTERVIEW_URL}?session=${sessionToken}`;
      await client.query(
        `INSERT INTO interviews (candidate_id, agency_id, scheduled_at, status, async_token, async_link)
         VALUES ($1, $2, $3, 'scheduled', $4, $5)
         ON CONFLICT (async_token) DO NOTHING`,
        [actualCandidateId, agencyId||null, scheduledAt, sessionToken, asyncLink]
      );
      console.log('✅ interviews row inserted for token:', sessionToken);

      await client.query("COMMIT");
      client.release();
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      console.error("❌ book-slot DB error:", e.message);
      return res.status(500).json({ success: false, error: e.message });
    }
  } else {
    slotDate  = slot_id.split("-").slice(1, 4).join("-");
    slotTime  = slot_id.split("-")[4]?.replace(/(\d{2})(\d{2})/, "$1:$2") || "09:00";
    sessionId = uuidv4();
    console.log("📋 In-memory booking — no DB write");
  }

  const meetParams    = new URLSearchParams({ session: sessionToken || sessionId });
  const interviewLink = `${FRONTEND_INTERVIEW_URL}?${meetParams.toString()}`;

  console.log("🔗 Meet link generated:", interviewLink.slice(0, 80) + "...");
  sendConfirmationEmail(name, email, slotDate, slotTime, interviewLink);

  return res.json({ success: true, message: "Slot booked successfully", session_id: sessionId, interview_link: interviewLink, slot_date: slotDate, slot_time: slotTime });
});

router.get("/session-info/:sessionToken", async (req, res) => {
  const { sessionToken } = req.params;
  if (!sessionToken || !sessionToken.trim()) return res.status(400).json({ success: false, error: "Session token is required" });
  if (!DB_ENABLED || !pool) return res.status(503).json({ success: false, error: "Database not available" });

  const client = await pool.connect();
  try {
    // Read directly from interview_sessions — all data was stored here at booking time
    const { rows } = await client.query(
      `SELECT candidate_name, email, resume_text, job_role, jd_text, agency_id, candidate_id, user_id, job_id, session_token, last_transcript_snapshot
       FROM interview_sessions
       WHERE session_token = $1`,
      [sessionToken]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: "Session not found" });
    const d = rows[0];
    console.log(`✅ session-info: ${d.candidate_name} | role: ${d.job_role} | resume: ${(d.resume_text||'').length} chars | jd: ${(d.jd_text||'').length} chars`);
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
    });
  } catch (e) {
    console.error("❌ session-info error:", e.message);
    return res.status(500).json({ success: false, error: "Failed to fetch session info" });
  } finally {
    client.release();
  }
});

module.exports = router;
