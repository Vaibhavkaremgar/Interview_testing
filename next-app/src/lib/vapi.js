import { pool, DB_READY } from "./db.js";

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const sessionsByToken = new Map();
const callToToken = new Map();
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 45000);

function normalizeRole(role) {
  return (role || "").toString().trim().toLowerCase();
}

function isTranscriptRoleAllowed(role) {
  const r = normalizeRole(role);
  return r === "user" || r === "assistant" || r === "bot";
}

function getSessionByToken(token) {
  const t = token || "default";
  if (!sessionsByToken.has(t)) {
    sessionsByToken.set(t, {
      resumeText: "",
      jdText: "",
      candidateName: "there",
      email: "",
      jobRole: "",
      agencyId: "",
      userId: "",
      candidateId: "",
      jobId: "",
      asyncToken: token || "",
      transcript: [],
      metadataLoaded: false,
      lastTranscriptAt: 0,
      pendingEnd: false,
      finalizeTimer: null,
      recordingUrl: null,
    });
  }
  return sessionsByToken.get(t);
}

function attachCallToToken(callId, token) {
  if (!callId || !token) return;
  const existingToken = callToToken.get(callId);
  if (existingToken && existingToken !== token) {
    // Merge old session into new token to keep transcripts continuous.
    const oldSession = sessionsByToken.get(existingToken);
    const newSession = getSessionByToken(token);
    if (oldSession && newSession && oldSession !== newSession) {
      newSession.transcript.push(...oldSession.transcript);
      newSession.lastTranscriptAt = Math.max(newSession.lastTranscriptAt, oldSession.lastTranscriptAt || 0);
      newSession.resumeText = newSession.resumeText || oldSession.resumeText;
      newSession.jdText = newSession.jdText || oldSession.jdText;
      newSession.candidateName = newSession.candidateName || oldSession.candidateName;
      newSession.email = newSession.email || oldSession.email;
      newSession.jobRole = newSession.jobRole || oldSession.jobRole;
      newSession.agencyId = newSession.agencyId || oldSession.agencyId;
      newSession.userId = newSession.userId || oldSession.userId;
      newSession.candidateId = newSession.candidateId || oldSession.candidateId;
      newSession.jobId = newSession.jobId || oldSession.jobId;
      newSession.asyncToken = newSession.asyncToken || oldSession.asyncToken;
      if (oldSession.finalizeTimer) {
        clearTimeout(oldSession.finalizeTimer);
        newSession.finalizeTimer = oldSession.finalizeTimer;
      }
      sessionsByToken.delete(existingToken);
    }
  }
  callToToken.set(callId, token);
}

function resolveToken(body, callId) {
  const v =
    body?.message?.call?.assistantOverrides?.variableValues ||
    body?.message?.call?.metadata ||
    body?.call?.metadata ||
    {};
  const token = v.session || v.sessionToken || v.asyncToken || body?.sessionToken || "";
  return token || callId || "default";
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
      .map(l => l.replace(/^\d+[\.\)]\s*/, "").replace(/^["']|["']$/g, "").trim())
      .filter(l => l.length > 15);
    if (lines.length >= 3) return lines.slice(0, 8);
  }
  return fallback;
}

function buildInsufficientDataEvaluation(transcriptWordCount = 0) {
  return {
    communication: 0,
    technical_depth: 0,
    problem_solving: 0,
    confidence: 0,
    overall_score: 0,
    summary: transcriptWordCount === 0
      ? "No usable interview answers were captured; scoring skipped."
      : "Transcript is too short to evaluate; scoring skipped.",
    strengths: "Insufficient transcript content.",
    weaknesses: "No substantive answers to evaluate.",
    decision: "REVIEW",
  };
}

async function evaluateCandidate(session, transcript) {
  const transcriptWordCount = (transcript || "").trim().split(/\s+/).filter(Boolean).length;
  const userWordCount = session.transcript
    .filter(e => normalizeRole(e.role) === "user")
    .map(e => e.content || "")
    .join(" ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

  if (userWordCount === 0) return buildInsufficientDataEvaluation(0);
  if (transcriptWordCount < 20) {
    return buildInsufficientDataEvaluation(transcriptWordCount);
  }

  const raw = await callGroq(
    `You are a hiring manager evaluating ONLY the interview transcript.
- Base every score strictly on what the candidate said in the transcript.
- Use resume/JD only as context; do NOT award points for skills not evidenced in the transcript.
- If the transcript lacks evidence for a criterion, keep that score low.
Return ONLY valid JSON (no markdown):
{"communication":<1-10>,"technical_depth":<1-10>,"problem_solving":<1-10>,"confidence":<1-10>,"overall_score":<1-10>,"summary":"...","strengths":"...","weaknesses":"...","decision":"PASS|FAIL|REVIEW"}`,
    `RESUME (context only):\n${session.resumeText || "Not provided"}\n\nJOB DESCRIPTION (context only):\n${session.jdText || "Not provided"}\n\nTRANSCRIPT (primary evidence):\n${transcript}`,
    500
  );
  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    return buildInsufficientDataEvaluation(transcriptWordCount);
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

function buildTranscriptText(session) {
  return session.transcript
    .filter(e => isTranscriptRoleAllowed(e.role) && (e.content || "").trim().length > 0)
    .map(e => `${normalizeRole(e.role === "bot" ? "assistant" : e.role).toUpperCase()}: ${e.content}`)
    .join("\n\n");
}

async function persistSnapshot(session) {
  if (!DB_READY || !pool) return;
  if (!session.asyncToken) return;
  const snapshot = buildTranscriptText(session);
  try {
    await pool.query(
      `UPDATE interview_sessions SET last_transcript_snapshot = $1, last_activity_at = NOW() WHERE session_token = $2`,
      [snapshot, session.asyncToken]
    );
  } catch (e) {
    console.warn("Could not persist transcript snapshot:", e.message);
  }
}

function scheduleFinalize(token, session) {
  if (session.finalizeTimer) clearTimeout(session.finalizeTimer);
  session.finalizeTimer = setTimeout(() => finalizeSession(token).catch(() => {}), RECONNECT_GRACE_MS);
  session.finalizeTimer.unref?.();
}

async function finalizeSession(token) {
  const session = sessionsByToken.get(token);
  if (!session || !session.pendingEnd) return;

  const transcript = buildTranscriptText(session);
  const evaluation = await evaluateCandidate(session, transcript);
  await saveEvaluation(session, evaluation, transcript, session.recordingUrl);

  if (session.finalizeTimer) clearTimeout(session.finalizeTimer);
  sessionsByToken.delete(token);
  // Clean up any call mappings for this token
  for (const [cid, t] of Array.from(callToToken.entries())) {
    if (t === token) callToToken.delete(cid);
  }
}

function pushTranscript(session, roleRaw, text) {
  const role = normalizeRole(roleRaw) === "user" ? "user" : "assistant";
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  const now = Date.now();
  const last = session.transcript[session.transcript.length - 1];
  const withinSameUtterance = last && last.role === role && now - (session.lastTranscriptAt || 0) < 5000;
  if (withinSameUtterance) {
    last.content = `${last.content} ${trimmed}`.replace(/\s+/g, " ").trim();
  } else {
    session.transcript.push({ role, content: trimmed });
  }
  session.lastTranscriptAt = now;
}

async function processWebhook(body) {
  try {
    const messageType = body?.message?.type || body?.type;
    const callId = body?.message?.call?.id || body?.call?.id || "default";
    const token = resolveToken(body, callId);
    attachCallToToken(callId, token);
    const session = getSessionByToken(token);
    session.asyncToken = session.asyncToken || (token !== "default" ? token : "");

    if (!session.metadataLoaded) {
      const data = extractCandidateData(body);
      if (data.candidateName || data.resume) {
        session.resumeText = data.resume || session.resumeText || "";
        session.jdText = data.jobDescription || session.jdText || "";
        session.candidateName = data.candidateName || session.candidateName || "there";
        session.email = data.email || session.email || "";
        session.jobRole = data.jobRole || session.jobRole || "";
        session.agencyId = data.agencyId || session.agencyId || "";
        session.userId = data.userId || session.userId || "";
        session.candidateId = data.candidateId || session.candidateId || "";
        session.jobId = data.jobId || session.jobId || "";
        session.metadataLoaded = true;
      }
    }

    if (messageType === "assistant-request" || messageType === "tool-calls") return;

    if (messageType === "transcript") {
      const role = body?.message?.role || "unknown";
      const text = body?.message?.transcript || "";
      if (isTranscriptRoleAllowed(role)) {
        pushTranscript(session, role, text);
        await persistSnapshot(session);
        if (session.pendingEnd) scheduleFinalize(token, session);
      }
      return;
    }

    if (messageType === "end-of-call-report") {
      const vapiMessages = body?.message?.artifact?.messages || [];
      if (vapiMessages.length) {
        for (const m of vapiMessages) {
          const role = m.role || "unknown";
          const text = m.message || "";
          if (isTranscriptRoleAllowed(role)) {
            pushTranscript(session, role, text);
          }
        }
        await persistSnapshot(session);
      }

      const asyncToken =
        body?.message?.call?.assistantOverrides?.variableValues?.session ||
        body?.message?.call?.assistantOverrides?.variableValues?.sessionToken ||
        body?.message?.call?.metadata?.sessionToken ||
        session.asyncToken ||
        "";
      if (asyncToken) {
        session.asyncToken = asyncToken;
        attachCallToToken(callId, asyncToken);
      }

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

      session.pendingEnd = true;
      session.recordingUrl = recordingUrl || session.recordingUrl;
      scheduleFinalize(token, session);
    }
  } catch (e) {
    console.error("Webhook processing failed:", e.message, e.stack);
  }
}

export { processWebhook, generateInterviewQuestions };
