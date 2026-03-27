require("dotenv").config();
const express  = require("express");
const path     = require("path");
const fs       = require("fs");
const multer   = require("multer");

const RECORDINGS_DIR = path.join(__dirname, "recordings");
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR);

const upload = multer({
  storage: multer.diskStorage({
    destination: RECORDINGS_DIR,
    filename: (req, file, cb) => cb(null, `${req.body.sessionToken || Date.now()}.webm`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

const { DB_READY, pool } = require("./db");
const slotsRouter = require("./slots");
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));
app.use("/interview", express.static(path.join(__dirname, "public", "interview")));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const sessions = {};

function getSession(callId) {
  if (!sessions[callId]) {
    sessions[callId] = {
      resumeText:    "",
      jdText:        "",
      candidateName: "there",
      email:         "",
      jobRole:       "",
      agencyId:      "",
      userId:        "",
      candidateId:   "",
      jobId:         "",
      asyncToken:    "",
      conversationHistory: [],
      metadataLoaded: false,
    };
  }
  return sessions[callId];
}

// Extract candidate data — variableValues is the correct location
function extractCandidateData(body) {
  // PRIMARY: vapi.start({ variableValues }) lands here
  const v = body?.message?.call?.assistantOverrides?.variableValues || {};
  if (v.candidateName || v.resume) {
    console.log("✅ Found data in assistantOverrides.variableValues");
    return v;
  }

  // SECONDARY: tool call arguments
  const toolCalls = body?.message?.toolCallList || body?.message?.toolCalls || [];
  for (const tc of toolCalls) {
    let args = tc?.function?.arguments || {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    if (args.candidateName || args.resume) {
      console.log("✅ Found data in tool call arguments");
      return args;
    }
  }

  // FALLBACK: legacy metadata
  const meta = body?.message?.call?.metadata || body?.call?.metadata || {};
  if (meta.candidateName || meta.resume) {
    console.log("✅ Found data in call.metadata");
    return meta;
  }

  return {};
}

// ── GROQ ──────────────────────────────────────────────────────
async function callGroq(systemPrompt, userMessage, maxTokens = 800) {
  if (!GROQ_API_KEY) { console.error("❌ GROQ_API_KEY not set"); return null; }
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
    if (!res.ok) { console.error("❌ Groq error:", res.status, await res.text()); return null; }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) { console.error("❌ Groq fetch failed:", e.message); return null; }
}

async function generateInterviewQuestions(resumeText, jdText) {
  console.log("🤖 Generating questions via Groq...");
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

  if (!response) { console.log("⚠️ Groq failed, using fallback"); return fallback; }

  try {
    const parsed = JSON.parse(response.replace(/```json|```/g, "").trim());
    if (Array.isArray(parsed) && parsed.length > 0) {
      console.log(`✅ Generated ${parsed.length} personalized questions`);
      return parsed;
    }
  } catch {
    const lines = response.split("\n")
      .map(l => l.replace(/^\d+[\.\)]\s*/, "").replace(/^[\"']|[\"']$/g, "").trim())
      .filter(l => l.length > 15);
    if (lines.length >= 3) return lines.slice(0, 8);
  }
  return fallback;
}

async function evaluateCandidate(session, transcript) {
  console.log("📊 Generating evaluation...");
  const raw = await callGroq(
    `You are a hiring manager. Evaluate the interview transcript.
Return ONLY valid JSON (no markdown):
{"communication":<1-10>,"technical_depth":<1-10>,"problem_solving":<1-10>,"confidence":<1-10>,"overall_score":<1-10>,"summary":"...","strengths":"...","weaknesses":"...","decision":"PASS|FAIL|REVIEW"}`,
    `RESUME:\n${session.resumeText || "Not provided"}\n\nJOB DESCRIPTION:\n${session.jdText || "Not provided"}\n\nTRANSCRIPT:\n${transcript}`,
    500
  );
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { return { communication:7, technical_depth:7, problem_solving:7, confidence:7, overall_score:7, summary:"Interview completed.", strengths:"Good communication.", weaknesses:"More specific examples needed.", decision:"maybe" }; }
}

// ── SAVE EVALUATION TO DATABASE ────────────────────────────────
async function saveEvaluation(session, evaluation, transcript, recordingUrl = null) {
  if (!DB_READY || !pool) { console.warn("⚠️  DB not available"); return; }

  const client = await pool.connect();
  try {
    // 1. Update interviews table by async_token (= session_token)
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
        evaluation.summary        || "",
        evaluation.overall_score  || 0,
        evaluation.technical_depth|| 0,
        evaluation.communication  || 0,
        evaluation.confidence     || 0,
        JSON.stringify({ strengths: evaluation.strengths, weaknesses: evaluation.weaknesses, decision: evaluation.decision }),
        recordingUrl,
        session.asyncToken,
      ]
    );

    // 2. Update candidates table — find by email
    if (session.email) {
      await client.query(
        `UPDATE candidates SET
           interview_transcript        = $1,
           interview_ai_summary        = $2,
           interview_technical_score   = $3,
           interview_communication_score = $4,
           interview_culture_fit_score = $5,
           stage                       = $6,
           stage_updated_at            = NOW()
         WHERE email = $7`,
        [
          transcript,
          evaluation.summary         || "",
          evaluation.technical_depth || 0,
          evaluation.communication   || 0,
          evaluation.confidence      || 0,
          evaluation.decision === "PASS" ? "INTERVIEW_PASSED" : evaluation.decision === "FAIL" ? "INTERVIEW_FAILED" : "INTERVIEW_REVIEW",
          session.email,
        ]
      );
    }

    console.log("✅ Evaluation saved — token:", session.asyncToken, "| decision:", evaluation.decision);
  } catch (e) {
    console.error("❌ Failed to save evaluation:", e.message);
  } finally {
    client.release();
  }
}

// ── WEBHOOK ───────────────────────────────────────────────────
async function processWebhook(body) {
  try {
  const messageType = body?.message?.type || body?.type;
  const callId = body?.message?.call?.id || body?.call?.id || "default";

  console.log("\n" + "=".repeat(50));
  console.log("📥 Type:", messageType, "| Call:", callId);

  const session = getSession(callId);

  // Try to load candidate data on every request
  if (!session.metadataLoaded) {
    const data = extractCandidateData(body);
    console.log("🔍 Extracted data keys:", Object.keys(data));
    if (data.candidateName || data.resume) {
      session.resumeText    = data.resume || "";
      session.jdText        = data.jobDescription || "";
      session.candidateName = data.candidateName || "there";
      session.email         = data.email || "";
      session.jobRole       = data.jobRole || "";
      session.agencyId      = data.agencyId || "";
      session.userId        = data.userId || "";
      session.candidateId   = data.candidateId || "";
      session.jobId         = data.jobId || "";
      session.metadataLoaded = true;
      console.log("✅ Candidate:", session.candidateName, "| Role:", session.jobRole);
      console.log("   Resume:", session.resumeText.length, "chars | JD:", session.jdText.length, "chars");
      console.log("   agencyId:", session.agencyId, "| userId:", session.userId);
    } else {
      console.log("⚠️  No candidate data found — full body:", JSON.stringify(body).slice(0, 500));
    }
  }

  // ── ASSISTANT-REQUEST ──────────────────────────────────────
  if (messageType === "assistant-request") {
    console.log("🎤 assistant-request received");
    return;
  }

  // ── TOOL-CALLS ─────────────────────────────────────────────
  if (messageType === "tool-calls") {
    console.log("🔧 tool-calls received (no-op with fixed assistant)");
    return;
  }

  // ── TRANSCRIPT ─────────────────────────────────────────────
  if (messageType === "transcript") {
    const role = body?.message?.role || "unknown";
    const text = body?.message?.transcript || "";
    if (text.trim()) {
      session.conversationHistory.push({ role, content: text });
      console.log(`📝 [${role}]: ${text.slice(0, 100)}`);
    }
    return;
  }

  // ── END-OF-CALL-REPORT ─────────────────────────────────────
  if (messageType === "end-of-call-report") {
    console.log("📋 Call ended — evaluating...");

    const callDuration = body?.message?.durationSeconds;
    console.log("⏱️ Call duration:", callDuration, "seconds");

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

    // Always load from DB using session token — most reliable source
    if (asyncToken && DB_READY && pool) {
      try {
        const { rows } = await pool.query(
          `SELECT candidate_name, email, resume_text, job_role, jd_text FROM interview_sessions WHERE session_token = $1`,
          [asyncToken]
        );
        if (rows.length) {
          session.resumeText    = rows[0].resume_text    || session.resumeText    || "";
          session.jdText        = rows[0].jd_text        || session.jdText        || "";
          session.candidateName = rows[0].candidate_name || session.candidateName || "";
          session.email         = rows[0].email          || session.email         || "";
          session.jobRole       = rows[0].job_role       || session.jobRole       || "";
          console.log(`✅ Session loaded from DB: ${session.candidateName} | resume: ${session.resumeText.length} chars`);
        }
      } catch (e) { console.warn("Could not load session from DB:", e.message); }
    }

    // Save Vapi's CDN recording URL to its own column
    const recordingUrl = body?.message?.artifact?.recordingUrl || null;
    if (recordingUrl && asyncToken && DB_READY && pool) {
      pool.query(
        `UPDATE interview_sessions SET vapi_recording_url = $1 WHERE session_token = $2`,
        [recordingUrl, asyncToken]
      ).catch(e => console.warn("Could not save vapi_recording_url:", e.message));
      console.log("🎙️ Vapi recording URL saved:", recordingUrl);
    }

    const evaluation = await evaluateCandidate(session, transcript);
    console.log("📊 Evaluation:", evaluation.decision, "| Score:", evaluation.overall_score);

    await saveEvaluation(session, evaluation, transcript, recordingUrl);

    delete sessions[callId];
  }

  console.log("⚠️  Unhandled type:", messageType);
  } catch (e) {
    console.error("❌ Webhook processing failed:", e.message, e.stack);
  }
}

app.post("/vapi-webhook", (req, res) => {
  res.json({ received: true });
  processWebhook(req.body).catch(e => console.error("❌ Webhook error:", e));
});

// ── SESSION HEARTBEAT ───────────────────────────────────────────
app.post("/api/session-heartbeat", async (req, res) => {
  const { session_token, transcript_so_far } = req.body;
  if (session_token && DB_READY && pool) {
    pool.query(
      `UPDATE interview_sessions SET last_transcript_snapshot = $1 WHERE session_token = $2`,
      [transcript_so_far || "", session_token]
    ).catch(e => console.warn("Heartbeat save failed:", e.message));
  }
  return res.json({ ok: true });
});

// ── SAVE VAPI RECORDING URL (from client-side call-end event) ───────────
app.post("/api/save-recording-url", async (req, res) => {
  const { recordingUrl, sessionToken } = req.body;
  if (!recordingUrl) return res.status(400).json({ success: false });
  console.log("🎥 Vapi recording URL received:", recordingUrl);
  if (sessionToken && DB_READY && pool) {
    pool.query(
      `UPDATE interview_sessions SET vapi_recording_url = $1 WHERE session_token = $2`,
      [recordingUrl, sessionToken]
    ).catch(e => console.warn("Could not save vapi_recording_url:", e.message));
  }
  return res.json({ success: true });
});

// ── SAVE RECORDING ───────────────────────────────────────────
app.post("/api/save-recording", upload.single("recording"), async (req, res) => {
  const { sessionToken } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ success: false, message: "No file" });
  const relativePath = `recordings/${file.filename}`;
  const sizeBytes = fs.statSync(file.path).size;
  console.log(`📹 Recording saved: ${file.filename} (${(sizeBytes / 1024 / 1024).toFixed(2)} MB)`);
  if (sessionToken && DB_READY && pool) {
    try {
      const fileBuffer = fs.readFileSync(file.path);
      await pool.query(
        `UPDATE interview_sessions SET recording_path = $1, recording_size_bytes = $2, recording_data = $3 WHERE session_token = $4`,
        [relativePath, sizeBytes, fileBuffer, sessionToken]
      );
      console.log(`✅ Recording stored in DB: ${(sizeBytes/1024/1024).toFixed(2)} MB`);
    } catch (e) {
      console.warn("Could not save recording to DB:", e.message);
    }
  }
  return res.json({ success: true, file: file.filename, size: sizeBytes });
});

// ── SERVE RECORDINGS ───────────────────────────────────────────
app.use("/recordings", express.static(path.join(__dirname, "recordings")));

app.get("/api/recording/:sessionToken", async (req, res) => {
  if (!DB_READY || !pool) return res.status(503).json({ error: "DB not available" });
  try {
    const { rows } = await pool.query(
      `SELECT recording_data, recording_path FROM interview_sessions WHERE session_token = $1`,
      [req.params.sessionToken]
    );
    if (!rows.length || !rows[0].recording_data) return res.status(404).json({ error: "Recording not found" });
    res.setHeader("Content-Type", "video/webm");
    res.setHeader("Content-Disposition", `inline; filename="${req.params.sessionToken}.webm"`);
    res.send(rows[0].recording_data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "✅ Pontis Backend Running",
    groq: GROQ_API_KEY ? "✅ Configured" : "❌ Missing",
    activeSessions: Object.keys(sessions).length,
    timestamp: new Date().toISOString(),
  });
});

// ── SLOT BOOKING ROUTES ──────────────────────────────────────
app.use("/api", slotsRouter);

// SPA fallback — serve interview app for /interview/* routes
app.get("/interview/*path", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "interview", "index.html"));
});

app.listen(PORT, async () => {
  console.log("=".repeat(50));
  console.log("🚀 Pontis Backend on port", PORT);
  console.log("📡 Webhook: http://localhost:" + PORT + "/vapi-webhook");
  console.log("⚡ Groq:", GROQ_API_KEY ? "✅ Ready" : "❌ GROQ_API_KEY missing!");
  console.log("🗄️  DB:", DB_READY ? "✅ Connected" : "⚠️  DATABASE_URL not set");
  
  // Test database connection
  if (DB_READY && pool) {
    try {
      const result = await pool.query("SELECT NOW() as current_time");
      console.log("✅ Railway PostgreSQL verified:", result.rows[0].current_time);
    } catch (e) {
      console.error("❌ Railway PostgreSQL connection failed:", e.message);
    }
  }
  
  console.log("=".repeat(50));
});
