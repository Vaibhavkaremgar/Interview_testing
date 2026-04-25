import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";
import { startRecordingRetryLoop } from "@/lib/recordingRetry.js";
import { startRecordingConversionWorker, finalizeSession } from "@/lib/recordingConversionWorker.js";
import { validateInterviewSessionToken } from "@/lib/sessionAuth.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

startRecordingConversionWorker();

export async function POST(request) {
  let formData = null;
  try {
    formData = await request.formData();
  } catch (e) {
    console.log("[Recording] no formData on request");
  }

  const { searchParams } = new URL(request.url);

  const chunk = formData?.get("chunk");
  const sessionToken = ((formData?.get("sessionToken")) || searchParams.get("sessionToken") || "").toString();
  const chunkIndexRaw = (formData?.get("chunkIndex") || "").toString();
  const isFinal = (formData?.get("final") || searchParams.get("final") || "").toString() === "1";

  const validation = await validateInterviewSessionToken(sessionToken, { allowEnded: true });
  if (!validation.ok) {
    return withCors(NextResponse.json({ success: false, message: validation.error }, { status: validation.status }));
  }

  startRecordingRetryLoop();

  const recordingsDir = process.env.RECORDINGS_DIR || path.join(process.cwd(), "recordings");
  if (!fs.existsSync(recordingsDir)) {
    try { fs.mkdirSync(recordingsDir); } catch (err) { console.error("Failed to create recordings directory:", err.message); }
  }

  const webmPath = path.join(recordingsDir, `${sessionToken}.webm`);
  const partsDir = path.join(recordingsDir, `${sessionToken}.parts`);
  if (!fs.existsSync(partsDir)) fs.mkdirSync(partsDir);

  const statePath = path.join(recordingsDir, `${sessionToken}.state.json`);
  const loadState = () => {
    try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
    catch { return { nextIndex: 0, lastChunkAt: 0, finalized: false, conversionAttempts: 0, merging: false }; }
  };
  const saveState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));

  const state = loadState();
  if (typeof state.merging !== "boolean") state.merging = false;
  if (typeof state.finalizing !== "boolean") state.finalizing = false;

  if ((state.finalizing || state.finalized) && !isFinal) {
    return withCors(NextResponse.json({ success: false, message: "Recording has been finalized", finalized: true }, { status: 409 }));
  }

  if (isFinal) {
    state.finalizing = true;
    saveState(state);
  }

  if (chunk && typeof chunk.arrayBuffer === "function") {
    const buffer = Buffer.from(await chunk.arrayBuffer());
    const idx = Number.isFinite(Number(chunkIndexRaw)) ? Number(chunkIndexRaw) : null;
    if (idx === null || Number.isNaN(idx)) {
      return withCors(NextResponse.json({ success: false, message: "Missing chunk index" }, { status: 400 }));
    }
    try {
      fs.writeFileSync(path.join(partsDir, `chunk-${idx}.webm`), buffer);
      state.lastChunkAt = Date.now();
      saveState(state);
      console.log("[Recording] chunk received", { sessionToken, index: idx, size: buffer.length });
    } catch (err) {
      console.error(`Failed to write chunk ${idx}:`, err.message);
      throw err;
    }
  } else if (!isFinal) {
    return withCors(NextResponse.json({ success: true, appendedChunks: 0, appendedBytes: 0, nextIndex: state.nextIndex, final: isFinal }));
  }

  const canMerge = !state.merging;
  if (canMerge) {
    state.merging = true;
    saveState(state);
  } else {
    console.log("[Recording] merge skipped because another merge is active", { sessionToken });
  }

  let appendedBytes = 0;
  let appendedChunks = 0;
  if (canMerge) {
    try {
      const files = fs.readdirSync(partsDir)
        .filter(f => f.startsWith("chunk-") && f.endsWith(".webm"))
        .map(f => {
          const match = f.match(/chunk-(\d+)\.webm/);
          return match ? { name: f, index: parseInt(match[1], 10) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.index - b.index);

      for (const file of files) {
        const partPath = path.join(partsDir, file.name);
        if (!fs.existsSync(partPath)) continue;
        const buf = fs.readFileSync(partPath);
        console.log("[Recording] merging chunk", { sessionToken, index: file.index, size: buf.length });
        fs.appendFileSync(webmPath, buf);
        fs.unlinkSync(partPath);
        appendedBytes += buf.length;
        appendedChunks += 1;
        state.nextIndex = Math.max(state.nextIndex, file.index + 1);
      }
      if (appendedChunks > 0 && !state.lastChunkAt) state.lastChunkAt = Date.now();
    } finally {
      state.merging = false;
      saveState(state);
    }
  }

  console.log("[recording-chunk] Recording append:", {
    sessionToken,
    appendedChunks,
    appendedBytes,
    fileExists: fs.existsSync(webmPath),
  });

  // Persist recording_path as soon as we have a merged file, so a missed final request won't leave DB null.
  if (DB_READY && pool && fs.existsSync(webmPath) && appendedChunks > 0) {
    try {
      const stats = fs.statSync(webmPath);
      console.log("[recording-chunk] DB update triggered");
      await pool.query(
        `UPDATE interview_sessions
           SET recording_path = $1,
               recording_size_bytes = COALESCE(recording_size_bytes, $2),
               recording_format = COALESCE(recording_format, 'webm'),
               recording_created_at = COALESCE(recording_created_at, NOW())
         WHERE session_token = $3`,
        [path.basename(webmPath), stats.size, sessionToken]
      );
      console.log("[recording-chunk] Recording path persisted early", {
        sessionToken,
        file: path.basename(webmPath),
        size: stats.size,
      });
    } catch (err) {
      console.warn("[recording-chunk] Early recording_path persist failed:", err.message);
    }
  }

  if (isFinal) {
    if (fs.existsSync(webmPath)) {
      console.log("[Recording] finalize triggered", { sessionToken, reason: "client-final" });
      await finalizeSession(sessionToken, "client-final");
    } else {
      console.warn("isFinal=true but webm file does not exist at:", webmPath);
    }
  }

  console.log("[recording-chunk] Append result", {
    sessionToken,
    appendedChunks,
    appendedBytes,
    hasWebm: fs.existsSync(webmPath),
    hasMp4: fs.existsSync(path.join(recordingsDir, `${sessionToken}.mp4`)),
    isFinal,
  });

  return withCors(NextResponse.json({
    success: true,
    appendedChunks,
    appendedBytes,
    nextIndex: state.nextIndex,
    final: isFinal,
  }));
}
