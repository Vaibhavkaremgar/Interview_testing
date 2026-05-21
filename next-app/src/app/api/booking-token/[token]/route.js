import { NextResponse } from "next/server";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

function parsePayload(rawPayload) {
  if (!rawPayload) return {};
  if (typeof rawPayload === "string") {
    try {
      return JSON.parse(rawPayload);
    } catch {
      return {};
    }
  }
  return rawPayload;
}

function firstNonEmpty(values = [], fallback = "") {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return fallback;
}

function normalizeKey(key = "") {
  return String(key).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function findValueDeep(node, keys = [], seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return undefined;
  seen.add(node);

  const normalizedKeys = new Set(keys.map(normalizeKey));

  if (Array.isArray(node)) {
    for (const item of node) {
      const value = findValueDeep(item, keys, seen);
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        return value;
      }
    }
    return undefined;
  }

  for (const [rawKey, rawValue] of Object.entries(node)) {
    if (normalizedKeys.has(normalizeKey(rawKey)) && rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== "") {
      return rawValue;
    }
  }

  for (const value of Object.values(node)) {
    const deepValue = findValueDeep(value, keys, seen);
    if (deepValue !== undefined && deepValue !== null && String(deepValue).trim() !== "") {
      return deepValue;
    }
  }

  return undefined;
}

function pickDeep(payload, keys = [], fallback = "") {
  const containers = [
    payload,
    payload?.candidate,
    payload?.candidate_details,
    payload?.candidateDetails,
    payload?.job,
    payload?.job_details,
    payload?.jobDetails,
    payload?.metadata,
    payload?.data,
  ].filter(Boolean);

  for (const container of containers) {
    for (const key of keys) {
      const value = container?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        return value;
      }
    }
  }

  const nestedValue = findValueDeep(payload, keys);
  if (nestedValue !== undefined && nestedValue !== null && String(nestedValue).trim() !== "") {
    return nestedValue;
  }

  return fallback;
}

export async function GET(request, { params }) {
  const url = new URL(request.url);
  const tokenFromQuery = url.searchParams.get("token");
  const tokenFromPath = params?.token || url.pathname.split("/").pop();
  const token = (tokenFromQuery || tokenFromPath || "").trim();
  if (!token.trim()) {
    return withCors(NextResponse.json({ success: false, error: "Token is required" }, { status: 400 }));
  }
  if (!DB_READY || !pool) {
    return withCors(NextResponse.json({ success: false, error: "Database not available" }, { status: 503 }));
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT payload, agency_id, candidate_id, job_id, user_id,
              is_active, expires_at, consumed_at
       FROM notification_workflow_tokens
       WHERE token = $1`
      , [token]
    );
    if (!rows.length) {
      console.warn("[booking-token] token not found", { token });
      return withCors(NextResponse.json({ success: false, error: "Token invalid, expired, or already used" }, { status: 404 }));
    }

    const row = rows[0];
    const isActive = row.is_active === null || row.is_active === undefined ? true : row.is_active === true;
    const isExpired = row.expires_at ? new Date(row.expires_at).getTime() <= Date.now() : false;
    const isConsumed = !!row.consumed_at;

    if (!isActive || isExpired || isConsumed) {
      const linkedSession = await client.query(
        `SELECT s.candidate_name, s.email, s.resume_text, s.job_role, s.jd_text,
                s.agency_id, s.candidate_id, s.job_id, s.user_id, s.session_token,
                slot.slot_date, slot.slot_time
         FROM interview_sessions s
         LEFT JOIN interview_slots slot ON slot.id = s.slot_id
         WHERE ($1::uuid IS NULL OR s.candidate_id = $1)
           AND ($2::uuid IS NULL OR s.job_id = $2)
           AND ($3::uuid IS NULL OR s.user_id = $3)
         ORDER BY s.created_at DESC
         LIMIT 1`,
        [row.candidate_id || null, row.job_id || null, row.user_id || null]
      ).catch(() => ({ rows: [] }));

      if (linkedSession.rows?.length) {
        const s = linkedSession.rows[0];
        return withCors(NextResponse.json({
          success: true,
          already_booked: true,
          session_token: s.session_token,
          name: s.candidate_name || "",
          email: s.email || "",
          resume_text: s.resume_text || "",
          job_title: s.job_role || "",
          job_description: s.jd_text || "",
          agency_id: s.agency_id || "",
          candidate_id: s.candidate_id || "",
          job_id: s.job_id || "",
          user_id: s.user_id || "",
          slot_date: s.slot_date || null,
          slot_time: s.slot_time ? s.slot_time.toString().slice(0, 8) : null,
          interview_questions: [],
        }));
      }

      console.warn("[booking-token] token rejected", {
        token,
        isActive,
        isExpired,
        isConsumed,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
      });
      return withCors(NextResponse.json({ success: false, error: "Token invalid, expired, or already used" }, { status: 404 }));
    }

    const payload = parsePayload(row.payload);
    const { agency_id, candidate_id, job_id, user_id } = row;
    const fallbackData = { name: "", email: "", resume_text: "", job_title: "", job_description: "" };

    if (candidate_id || job_id) {
      const fallback = await client.query(
        `SELECT c.name, c.email, c.resume_text, jd.title AS job_title, jd.description AS job_description
         FROM candidates c
         LEFT JOIN job_descriptions jd ON jd.id = $2
         WHERE c.id = $1
         LIMIT 1`,
        [candidate_id || null, job_id || null]
      ).catch(() => ({ rows: [] }));

      if (fallback.rows?.length) {
        fallbackData.name = fallback.rows[0].name || "";
        fallbackData.email = fallback.rows[0].email || "";
        fallbackData.resume_text = fallback.rows[0].resume_text || "";
        fallbackData.job_title = fallback.rows[0].job_title || "";
        fallbackData.job_description = fallback.rows[0].job_description || "";
      }
    }

    return withCors(NextResponse.json({
      success: true,
      name: pickDeep(payload, ["candidate_name", "candidateName", "name", "full_name", "fullName"], fallbackData.name),
      email: pickDeep(payload, ["email", "candidate_email", "candidateEmail", "mail"], fallbackData.email),
      resume_text: pickDeep(payload, ["resume_text", "resume", "resumeText"], fallbackData.resume_text),
      job_title: pickDeep(payload, ["job_title", "job_role", "jobRole", "role", "title"], fallbackData.job_title),
      job_description: pickDeep(payload, ["job_description", "jobDescription", "jd_text", "jd", "description"], fallbackData.job_description),
      agency_id: pickDeep(payload, ["agency_id", "agencyId"], agency_id || ""),
      candidate_id: pickDeep(payload, ["candidate_id", "candidateId"], candidate_id || ""),
      job_id: pickDeep(payload, ["job_id", "jobId"], job_id || ""),
      user_id: pickDeep(payload, ["user_id", "userId"], user_id || ""),
      interview_questions: firstNonEmpty([
        payload.interview_questions,
        payload.async_questions,
        payload.asyncQuestions,
        payload?.job?.interview_questions,
        payload?.jobDetails?.interview_questions,
      ], []),
    }));
  } catch (e) {
    console.error("booking-token error:", e.message);
    return withCors(NextResponse.json({ success: false, error: "Failed to resolve token" }, { status: 500 }));
  } finally {
    client.release();
  }
}
