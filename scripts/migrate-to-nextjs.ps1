param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
$nextApp = Join-Path $root "next-app"

if (-not (Test-Path $nextApp)) {
  Write-Host "Creating Next.js app in $nextApp"
  cmd /c npx create-next-app@latest next-app --js --eslint --no-tailwind --src-dir --import-alias "@/*" --no-react-compiler --yes
}

# Copy env and static assets
if (Test-Path (Join-Path $root ".env")) {
  Copy-Item -Path (Join-Path $root ".env") -Destination (Join-Path $nextApp ".env") -Force
}
if (Test-Path (Join-Path $root "public")) {
  Copy-Item -Path (Join-Path $root "public" "*") -Destination (Join-Path $nextApp "public") -Recurse -Force
}

# Ensure lib directory
New-Item -ItemType Directory -Force (Join-Path $nextApp "src\lib") | Out-Null

# db.js
@'
import { Pool } from "pg";

const DB_URL = process.env.DATABASE_URL || "";
const DB_READY = DB_URL.length > 0 && !DB_URL.includes("user:password");

const pool = DB_READY
  ? new Pool({
      connectionString: DB_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    })
  : null;

if (pool) {
  pool.on("error", (err) => {
    console.error("Unexpected error on idle client", err);
  });
}

export { pool, DB_READY };
'@ | Set-Content -LiteralPath (Join-Path $nextApp "src\lib\db.js")

# slots.js
@'
import { Resend } from "resend";
import { pool, DB_READY } from "./db.js";

const resend = new Resend(process.env.RESEND_API_KEY);
const FRONTEND_INTERVIEW_URL = process.env.FRONTEND_INTERVIEW_URL || "http://localhost:3000/interview";
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
    from: "Pontis Interviews <onboarding@resend.dev>",
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
  return `${FRONTEND_INTERVIEW_URL}?${params.toString()}`;
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
'@ | Set-Content -LiteralPath (Join-Path $nextApp "src\lib\slots.js")

# vapi.js
@'
import { pool, DB_READY } from "./db.js";

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const sessions = {};

function getSession(callId) {
  if (!sessions[callId]) {
    sessions[callId] = {
      resumeText: "",
      jdText: "",
      candidateName: "there",
      email: "",
      jobRole: "",
      agencyId: "",
      userId: "",
      candidateId: "",
      jobId: "",
      asyncToken: "",
      conversationHistory: [],
      metadataLoaded: false,
    };
  }
  return sessions[callId];
}

function extractCandidateData(body) {
  const v = body?.message?.call?.assistantOverrides?.variableValues || {};
  if (v.candidateName || v.resume) return v;

  const toolCalls = body?.message?.toolCallList || body?.message?.toolCalls || [];
  for (const tc of toolCalls) {
    let args = tc?.function?.arguments || {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    if (args.candidateName || args.resume) return args;
  }

  const meta = body?.message?.call?.metadata || body?.call?.metadata || {};
  if (meta.candidateName || meta.resume) return meta;

  return {};
}

async function callGroq(systemPrompt, userMessage, maxTokens = 800) {
  if (!GROQ_API_KEY) { console.error("GROQ_API_KEY not set"); return null; }
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    });
    if (!res.ok) { console.error("Groq error:", res.status, await res.text()); return null; }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error("Groq fetch failed:", e.message);
    return null;
  }
}

async function generateInterviewQuestions(resumeText, jdText) {
  const response = await callGroq(
    `You are an expert technical interviewer. Generate exactly 8 interview questions based on the candidate's resume and job description.
- Reference specific technologies/projects from the resume
- Test skills listed in the job description
- Mix technical, behavioral, and situational questions
Return ONLY a valid JSON array of 8 question strings. No markdown, no explanation.`,
    `RESUME:\n${resumeText || "Not provided"}\n\nJOB DESCRIPTION:\n${jdText || "Not provided"}`,
    600
  );

  const fallback = [
    "Can you walk me through your background and what led you to apply for this role?",
    "Tell me about the most technically challenging project you've worked on.",
    "How do you approach debugging a problem you've never seen before?",
    "Describe a time you had to learn a new technology under a tight deadline.",
    "How do you prioritize tasks when working on multiple projects simultaneously?",
    "Tell me about a time you disagreed with a teammate and how you resolved it.",
    "What does your ideal development workflow look like?",
    "Where do you see yourself professionally in the next 2-3 years?",
  ];

  if (!response) return fallback;

  try {
    const parsed = JSON.parse(response.replace(/```json|```/g, "").trim());
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    const lines = response.split("\n")
      .map(l => l.replace(/^\d+[\.\)]\s*/, "").replace(/^[\"']|[\"']$/g, "").trim())
      .filter(l => l.length > 15);
    if (lines.length >= 3) return lines.slice(0, 8);
  }
  return fallback;
}

async function evaluateCandidate(session, transcript) {
  const raw = await callGroq(
    `You are a hiring manager. Evaluate the interview transcript.
Return ONLY valid JSON (no markdown):
{\"communication\":<1-10>,\"technical_depth\":<1-10>,\"problem_solving\":<1-10>,\"confidence\":<1-10>,\"overall_score\":<1-10>,\"summary\":\"...\",\"strengths\":\"...\",\"weaknesses\":\"...\",\"decision\":\"PASS|FAIL|REVIEW\"}`,
    `RESUME:\n${session.resumeText || "Not provided"}\n\nJOB DESCRIPTION:\n${session.jdText || "Not provided"}\n\nTRANSCRIPT:\n${transcript}`,
    500
  );
  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    return {
      communication: 7,
      technical_depth: 7,
      problem_solving: 7,
      confidence: 7,
      overall_score: 7,
      summary: "Interview completed.",
      strengths: "Good communication.",
      weaknesses: "More specific examples needed.",
      decision: "maybe",
    };
  }
}

async function saveEvaluation(session, evaluation, transcript, recordingUrl = null) {
  if (!DB_READY || !pool) return;

  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE interviews SET
         transcript          = $1,
         ai_summary          = $2,
         interview_score     = $3,
         technical_score     = $4,
         communication_score = $5,
         culture_fit_score   = $6,
         feedback            = $7,
         video_url           = $8,
         status              = 'completed',
         async_completed_at  = NOW()
       WHERE async_token = $9`,
      [
        transcript,
        evaluation.summary || "",
        evaluation.overall_score || 0,
        evaluation.technical_depth || 0,
        evaluation.communication || 0,
        evaluation.confidence || 0,
        JSON.stringify({ strengths: evaluation.strengths, weaknesses: evaluation.weaknesses, decision: evaluation.decision }),
        recordingUrl,
        session.asyncToken,
      ]
    );

    if (session.email) {
      await client.query(
        `UPDATE candidates SET
           interview_transcript          = $1,
           interview_ai_summary          = $2,
           interview_technical_score     = $3,
           interview_communication_score = $4,
           interview_culture_fit_score   = $5,
           stage                         = $6,
           stage_updated_at              = NOW()
         WHERE email = $7`,
        [
          transcript,
          evaluation.summary || "",
          evaluation.technical_depth || 0,
          evaluation.communication || 0,
          evaluation.confidence || 0,
          evaluation.decision === "PASS" ? "INTERVIEW_PASSED" : evaluation.decision === "FAIL" ? "INTERVIEW_FAILED" : "INTERVIEW_REVIEW",
          session.email,
        ]
      );
    }
  } catch (e) {
    console.error("Failed to save evaluation:", e.message);
  } finally {
    client.release();
  }
}

async function processWebhook(body) {
  try {
    const messageType = body?.message?.type || body?.type;
    const callId = body?.message?.call?.id || body?.call?.id || "default";

    const session = getSession(callId);

    if (!session.metadataLoaded) {
      const data = extractCandidateData(body);
      if (data.candidateName || data.resume) {
        session.resumeText = data.resume || "";
        session.jdText = data.jobDescription || "";
        session.candidateName = data.candidateName || "there";
        session.email = data.email || "";
        session.jobRole = data.jobRole || "";
        session.agencyId = data.agencyId || "";
        session.userId = data.userId || "";
        session.candidateId = data.candidateId || "";
        session.jobId = data.jobId || "";
        session.metadataLoaded = true;
      }
    }

    if (messageType === "assistant-request") return;
    if (messageType === "tool-calls") return;

    if (messageType === "transcript") {
      const role = body?.message?.role || "unknown";
      const text = body?.message?.transcript || "";
      if (text.trim()) session.conversationHistory.push({ role, content: text });
      return;
    }

    if (messageType === "end-of-call-report") {
      const vapiMessages = body?.message?.artifact?.messages || [];
      const transcript = vapiMessages.length
        ? vapiMessages
            .filter(m => m.message && m.message.trim().length > 0)
            .map(m => `${m.role.toUpperCase()}: ${m.message}`).join("\n\n")
        : session.conversationHistory.map(e => `${e.role.toUpperCase()}: ${e.content}`).join("\n\n");

      const asyncToken =
        body?.message?.call?.assistantOverrides?.variableValues?.session ||
        body?.message?.call?.assistantOverrides?.variableValues?.sessionToken ||
        body?.message?.call?.metadata?.sessionToken || "";
      if (asyncToken) session.asyncToken = asyncToken;

      if (asyncToken && DB_READY && pool) {
        try {
          const { rows } = await pool.query(
            `SELECT candidate_name, email, resume_text, job_role, jd_text FROM interview_sessions WHERE session_token = $1`,
            [asyncToken]
          );
          if (rows.length) {
            session.resumeText = rows[0].resume_text || session.resumeText || "";
            session.jdText = rows[0].jd_text || session.jdText || "";
            session.candidateName = rows[0].candidate_name || session.candidateName || "";
            session.email = rows[0].email || session.email || "";
            session.jobRole = rows[0].job_role || session.jobRole || "";
          }
        } catch (e) {
          console.warn("Could not load session from DB:", e.message);
        }
      }

      const recordingUrl = body?.message?.artifact?.recordingUrl || null;
      if (recordingUrl && asyncToken && DB_READY && pool) {
        pool.query(
          `UPDATE interview_sessions SET vapi_recording_url = $1 WHERE session_token = $2`,
          [recordingUrl, asyncToken]
        ).catch(e => console.warn("Could not save vapi_recording_url:", e.message));
      }

      const evaluation = await evaluateCandidate(session, transcript);
      await saveEvaluation(session, evaluation, transcript, recordingUrl);

      delete sessions[callId];
    }
  } catch (e) {
    console.error("Webhook processing failed:", e.message, e.stack);
  }
}

export { processWebhook, generateInterviewQuestions };
'@ | Set-Content -LiteralPath (Join-Path $nextApp "src\lib\vapi.js")

function Write-Route([string]$path, [string]$content) {
  $dir = Split-Path -Parent $path
  New-Item -ItemType Directory -Force $dir | Out-Null
  $content | Set-Content -LiteralPath $path
}

Write-Route (Join-Path $nextApp "src\app\api\booking-token\[token]\route.js") @'
import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";

export const runtime = "nodejs";

export async function GET(request, { params }) {
  const token = params?.token || "";
  if (!token.trim()) {
    return NextResponse.json({ success: false, error: "Token is required" }, { status: 400 });
  }
  if (!DB_READY || !pool) {
    return NextResponse.json({ success: false, error: "Database not available" }, { status: 503 });
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT payload, agency_id, candidate_id, job_id, user_id
       FROM notification_workflow_tokens
       WHERE token = $1 AND is_active = true AND expires_at > NOW()`,
      [token]
    );
    if (!rows.length) {
      return NextResponse.json({ success: false, error: "Token invalid, expired, or already used" }, { status: 404 });
    }
    const { payload, agency_id, candidate_id, job_id, user_id } = rows[0];
    return NextResponse.json({
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
    });
  } catch (e) {
    console.error("booking-token error:", e.message);
    return NextResponse.json({ success: false, error: "Failed to resolve token" }, { status: 500 });
  } finally {
    client.release();
  }
}
'@

Write-Route (Join-Path $nextApp "src\app\api\available-slots\route.js") @'
import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { deletePastSlots, generateSlots, generateInMemorySlots, localDateStr, addDays, localTimeStr } from "@/lib/slots.js";

export const runtime = "nodejs";

export async function GET() {
  if (DB_READY && pool) {
    const client = await pool.connect();
    try {
      await deletePastSlots();
      await generateSlots();
      const { rows: timeRows } = await client.query("SELECT NOW() AT TIME ZONE 'Asia/Kolkata' AS now");
      const now = new Date(timeRows[0].now + '+05:30');
      const todayStr = localDateStr(now);
      const day1Str = localDateStr(addDays(now, 1));
      const day2Str = localDateStr(addDays(now, 2));
      const currentTime = localTimeStr(now);

      const { rows } = await client.query(
        `SELECT id, slot_date::text, slot_time, max_concurrent, current_bookings
         FROM interview_slots
         WHERE current_bookings < max_concurrent
           AND (
             (slot_date = $1 AND slot_time >= $4)
             OR slot_date = $2
             OR slot_date = $3
           )
         ORDER BY slot_date, slot_time`,
        [todayStr, day1Str, day2Str, currentTime]
      );

      return NextResponse.json({
        success: true,
        mode: "db",
        slots: rows.map(r => ({
          slot_id: r.id,
          slot_date: r.slot_date,
          slot_time: r.slot_time.slice(0, 5),
          available: r.max_concurrent - r.current_bookings,
        })),
      });
    } catch (e) {
      console.error("DB slots error:", e.message);
      return NextResponse.json({ success: false, error: "Failed to fetch slots" }, { status: 500 });
    } finally {
      client.release();
    }
  }

  return NextResponse.json({ success: true, mode: "memory", slots: generateInMemorySlots() });
}
'@

Write-Route (Join-Path $nextApp "src\app\api\book-slot\route.js") @'
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { pool, DB_READY } from "@/lib/db.js";
import { buildInterviewLink, parseSlotStart, sendConfirmationEmail } from "@/lib/slots.js";

export const runtime = "nodejs";

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const {
    slot_id, email, name, bookingToken,
    resume = "", jobDescription = "", jobRole = "", agencyId = "", userId = "", jobId = "", candidateId = "",
    async_questions = [], asyncQuestions, interviewQuestions,
  } = body;

  if (!slot_id || !email || !name) {
    return NextResponse.json({ success: false, error: "slot_id, email, and name are required" }, { status: 400 });
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
        return NextResponse.json({ success: false, error: "Slot not available" }, { status: 400 });
      }
      const slot = rows[0];
      const slotStart = parseSlotStart(slot.slot_date, slot.slot_time);
      if (slotStart && slotStart.getTime() <= Date.now()) {
        await client.query("ROLLBACK");
        return NextResponse.json({ success: false, error: "Slot has already started" }, { status: 400 });
      }

      slotDate = new Date(slot.slot_date).toISOString().slice(0, 10);
      slotTime = slot.slot_time.slice(0, 5);

      const candidateUUID = uuidv4();
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
          finalResume = finalResume || cRows[0].resume_text || "";
          finalJD = finalJD || cRows[0].jd_text || "";
          finalJobRole = finalJobRole || cRows[0].job_title || "";
        }
      }

      sessionToken = uuidv4();
      const { rows: sr } = await client.query(
        `INSERT INTO interview_sessions (agency_id, job_id, candidate_id, user_id, slot_id, candidate_name, email, job_role, jd_text, resume_text, session_token, interview_questions, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'scheduled')
         RETURNING id, session_token`,
        [
          agencyId && agencyId.length === 36 ? agencyId : null,
          jobId && jobId.length === 36 ? jobId : null,
          actualCandidateId,
          userId && userId.length === 36 ? userId : null,
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

      await client.query("COMMIT");

      await client.query(
        `UPDATE notification_workflow_tokens SET is_active = false, consumed_at = NOW() WHERE token = $1`,
        [bookingToken || ""]
      ).catch(() => {});
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("book-slot DB error:", e.message);
      return NextResponse.json({ success: false, error: e.message }, { status: 500 });
    } finally {
      client.release();
    }
  } else {
    slotDate = slot_id.split("-").slice(1, 4).join("-");
    slotTime = slot_id.split("-")[4]?.replace(/(\d{2})(\d{2})/, "$1:$2") || "09:00";
    sessionId = uuidv4();
  }

  const interviewLink = buildInterviewLink(sessionToken || sessionId);
  sendConfirmationEmail(name, email, slotDate, slotTime, interviewLink);

  return NextResponse.json({
    success: true,
    message: "Slot booked successfully",
    session_id: sessionId,
    interview_link: interviewLink,
    slot_date: slotDate,
    slot_time: slotTime,
  });
}
'@

Write-Route (Join-Path $nextApp "src\app\api\session-info\[sessionToken]\route.js") @'
import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { parseSlotStart } from "@/lib/slots.js";

export const runtime = "nodejs";

export async function GET(request, { params }) {
  const sessionToken = params?.sessionToken || "";
  if (!sessionToken.trim()) {
    return NextResponse.json({ success: false, error: "Session token is required" }, { status: 400 });
  }
  if (!DB_READY || !pool) {
    return NextResponse.json({ success: false, error: "Database not available" }, { status: 503 });
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
      return NextResponse.json({ success: false, error: "Session not found" }, { status: 404 });
    }

    const d = rows[0];
    let asyncQuestions = [];
    if (d.async_questions) {
      try {
        asyncQuestions = typeof d.async_questions === "string" ? JSON.parse(d.async_questions) : d.async_questions;
      } catch {
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
        return NextResponse.json({
          success: false,
          error: "Interview link expired for the selected slot",
          slot_date: slotDateStr,
          slot_time: slotTimeStr,
        }, { status: 410 });
      }
    }

    return NextResponse.json({
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
    console.error("session-info error:", e.message);
    return NextResponse.json({ success: false, error: "Failed to fetch session info" }, { status: 500 });
  } finally {
    client.release();
  }
}
'@

Write-Route (Join-Path $nextApp "src\app\api\session-heartbeat\route.js") @'
import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";

export const runtime = "nodejs";

export async function POST(request) {
  const { session_token, transcript_so_far } = await request.json().catch(() => ({}));
  if (session_token && DB_READY && pool) {
    pool.query(
      `UPDATE interview_sessions SET last_transcript_snapshot = $1 WHERE session_token = $2`,
      [transcript_so_far || "", session_token]
    ).catch(e => console.warn("Heartbeat save failed:", e.message));
  }
  return NextResponse.json({ ok: true });
}
'@

Write-Route (Join-Path $nextApp "src\app\api\save-recording-url\route.js") @'
import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";

export const runtime = "nodejs";

export async function POST(request) {
  const { recordingUrl, sessionToken } = await request.json().catch(() => ({}));
  if (!recordingUrl) return NextResponse.json({ success: false }, { status: 400 });

  if (sessionToken && DB_READY && pool) {
    pool.query(
      `UPDATE interview_sessions SET vapi_recording_url = $1 WHERE session_token = $2`,
      [recordingUrl, sessionToken]
    ).catch(e => console.warn("Could not save vapi_recording_url:", e.message));
  }

  return NextResponse.json({ success: true });
}
'@

Write-Route (Join-Path $nextApp "src\app\api\save-recording\route.js") @'
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { pool, DB_READY } from "@/lib/db.js";

export const runtime = "nodejs";

export async function POST(request) {
  const formData = await request.formData();
  const file = formData.get("recording");
  const sessionToken = formData.get("sessionToken") || "";

  if (!file || typeof file.arrayBuffer !== "function") {
    return NextResponse.json({ success: false, message: "No file" }, { status: 400 });
  }

  const recordingsDir = path.join(process.cwd(), "recordings");
  if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir);

  const filename = `${sessionToken || Date.now()}.webm`;
  const fullPath = path.join(recordingsDir, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(fullPath, buffer);

  const relativePath = `recordings/${filename}`;
  const sizeBytes = buffer.length;

  if (sessionToken && DB_READY && pool) {
    try {
      await pool.query(
        `UPDATE interview_sessions SET recording_path = $1, recording_size_bytes = $2, recording_data = $3 WHERE session_token = $4`,
        [relativePath, sizeBytes, buffer, sessionToken]
      );
    } catch (e) {
      console.warn("Could not save recording to DB:", e.message);
    }
  }

  return NextResponse.json({ success: true, file: filename, size: sizeBytes });
}
'@

Write-Route (Join-Path $nextApp "src\app\api\recording\[sessionToken]\route.js") @'
import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";

export const runtime = "nodejs";

export async function GET(request, { params }) {
  const sessionToken = params?.sessionToken || "";
  if (!DB_READY || !pool) {
    return NextResponse.json({ error: "DB not available" }, { status: 503 });
  }
  try {
    const { rows } = await pool.query(
      `SELECT recording_data, recording_path FROM interview_sessions WHERE session_token = $1`,
      [sessionToken]
    );
    if (!rows.length || !rows[0].recording_data) {
      return NextResponse.json({ error: "Recording not found" }, { status: 404 });
    }
    const headers = new Headers();
    headers.set("Content-Type", "video/webm");
    headers.set("Content-Disposition", `inline; filename="${sessionToken}.webm"`);
    return new Response(rows[0].recording_data, { headers });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
'@

Write-Route (Join-Path $nextApp "src\app\api\vapi-webhook\route.js") @'
import { NextResponse } from "next/server";
import { processWebhook } from "@/lib/vapi.js";

export const runtime = "nodejs";

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  processWebhook(body).catch(e => console.error("Webhook error:", e));
  return NextResponse.json({ received: true });
}
'@

# Pages
New-Item -ItemType Directory -Force (Join-Path $nextApp "src\app\booking") | Out-Null
@'
import { redirect } from "next/navigation";

export default function BookingRedirect() {
  redirect("/booking.html");
}
'@ | Set-Content -LiteralPath (Join-Path $nextApp "src\app\booking\page.js")

New-Item -ItemType Directory -Force (Join-Path $nextApp "src\app\interview") | Out-Null
@'
import { redirect } from "next/navigation";

export default function InterviewRedirect() {
  redirect("/interview/index.html");
}
'@ | Set-Content -LiteralPath (Join-Path $nextApp "src\app\interview\page.js")

@'
export default function Home() {
  return (
    <main style={{ fontFamily: "Segoe UI, Arial, sans-serif", padding: "48px" }}>
      <h1 style={{ marginBottom: "8px" }}>Pontis Next.js</h1>
      <p style={{ marginTop: 0, color: "#475569" }}>
        Unified frontend and backend stack.
      </p>
      <ul style={{ marginTop: "24px", paddingLeft: "18px" }}>
        <li><a href="/booking">Booking</a></li>
        <li><a href="/interview">Interview</a></li>
      </ul>
    </main>
  );
}
'@ | Set-Content -LiteralPath (Join-Path $nextApp "src\app\page.js")

# Update dependencies
$pkg = Get-Content (Join-Path $nextApp "package.json") | ConvertFrom-Json
$deps = $pkg.dependencies
$deps | Add-Member -NotePropertyName pg -NotePropertyValue "^8.20.0" -Force
$deps | Add-Member -NotePropertyName resend -NotePropertyValue "^6.9.4" -Force
$deps | Add-Member -NotePropertyName uuid -NotePropertyValue "^9.0.0" -Force
$pkg.dependencies = $deps
$pkg | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $nextApp "package.json")

Write-Host "Installing dependencies in next-app"
cmd /c npm install
