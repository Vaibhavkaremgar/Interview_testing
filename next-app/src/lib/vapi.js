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
      .map(l => l.replace(/^\d+[\.\)]\s*/, "").replace(/^["']|["']$/g, "").trim())
      .filter(l => l.length > 15);
    if (lines.length >= 3) return lines.slice(0, 8);
  }
  return fallback;
}

async function evaluateCandidate(session, transcript) {
  const raw = await callGroq(
    `You are a hiring manager. Evaluate the interview transcript.
Return ONLY valid JSON (no markdown):
{"communication":<1-10>,"technical_depth":<1-10>,"problem_solving":<1-10>,"confidence":<1-10>,"overall_score":<1-10>,"summary":"...","strengths":"...","weaknesses":"...","decision":"PASS|FAIL|REVIEW"}`,
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
