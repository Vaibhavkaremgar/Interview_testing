import { Resend } from "resend";
import { pool, DB_READY } from "./db.js";

const resend = new Resend(process.env.RESEND_API_KEY);
const FRONTEND_INTERVIEW_URL =
  process.env.FRONTEND_INTERVIEW_URL ||
  process.env.INTERVIEW_BASE_URL ||
  process.env.NEXT_PUBLIC_INTERVIEW_BASE_URL ||
  "http://localhost:3000/interview";
const CONCURRENT_INTERVIEWS = Number(process.env.CONCURRENT_INTERVIEWS) || 3;

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

function slotTimes() {
  const times = [];
  for (let h = 9; h < 18; h++) {
    times.push(`${String(h).padStart(2, "0")}:00:00`);
    times.push(`${String(h).padStart(2, "0")}:30:00`);
  }
  return times;
}

async function generateSlots() {
  if (!DB_READY || !pool) return;
  try {
    const now = new Date();
    const dates = [localDateStr(now), localDateStr(addDays(now, 1)), localDateStr(addDays(now, 2))];
    const times = slotTimes();
    for (const slot_date of dates) {
      for (const slot_time of times) {
        await pool.query(
          `INSERT INTO interview_slots (slot_date, slot_time, max_concurrent, current_bookings)
           SELECT $1, $2, $3, 0
           WHERE NOT EXISTS (
             SELECT 1 FROM interview_slots WHERE slot_date = $1 AND slot_time = $2
           )`,
          [slot_date, slot_time, CONCURRENT_INTERVIEWS]
        );
      }
    }
  } catch (e) {
    console.error("Slot generation failed:", e.message);
  }
}

async function deletePastSlots() {
  if (!DB_READY || !pool) return;
  try {
    await pool.query(
      `DELETE FROM interview_slots
       WHERE (slot_date + slot_time + interval '30 minutes') < (NOW() AT TIME ZONE 'Asia/Kolkata')`
    );
  } catch (e) {
    console.error("Past slot cleanup failed:", e.message);
  }
}

function generateInMemorySlots() {
  const now = new Date();
  const todayStr = localDateStr(now);
  const curMins = now.getHours() * 60 + now.getMinutes();
  const slots = [];

  for (let d = 0; d < 3; d++) {
    const dateStr = localDateStr(addDays(now, d));
    for (let h = 9; h < 18; h++) {
      for (let m = 0; m < 60; m += 30) {
        if (dateStr === todayStr && h * 60 + m <= curMins) continue;
        slots.push({
          slot_id: `mem-${dateStr}-${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}`,
          slot_date: dateStr,
          slot_time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
          available: CONCURRENT_INTERVIEWS,
        });
      }
    }
  }
  return slots;
}

function formatDateLong(dateStr) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}

function formatTimeFull(timeStr) {
  const [h, m] = timeStr.split(":");
  const hour = parseInt(h, 10);
  return `${hour > 12 ? hour - 12 : hour || 12}:${m} ${hour >= 12 ? "PM" : "AM"}`;
}

async function sendConfirmationEmail(name, email, date, time, interviewLink) {
  const displayDate = formatDateLong(date);
  const displayTime = formatTimeFull(time);

  await resend.emails.send({
    from: "Pontis Interviews <info@pontis.one>",
    to: email,
    subject: `Your Interview is Confirmed ${displayDate}`,
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
            <p style="margin:0;font-size:13px;color:#94a3b8">Pontis AI Interview Platform · Automated message</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
  });
}

function buildInterviewLink(sessionToken) {
  const params = new URLSearchParams({ session: sessionToken });
  const base = (FRONTEND_INTERVIEW_URL || "").trim();
  if (!base) return `?${params.toString()}`;

  let url = base;
  if (url.endsWith("/")) url = url.slice(0, -1);
  if (!/\/interview$/i.test(url)) {
    url = `${url}/interview`;
  }
  return `${url}?${params.toString()}`;
}

export {
  FRONTEND_INTERVIEW_URL,
  CONCURRENT_INTERVIEWS,
  localDateStr,
  localTimeStr,
  addDays,
  parseSlotStart,
  slotTimes,
  generateSlots,
  deletePastSlots,
  generateInMemorySlots,
  formatDateLong,
  formatTimeFull,
  sendConfirmationEmail,
  buildInterviewLink,
};
