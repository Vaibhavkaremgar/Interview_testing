import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";
import { startRecordingRetryLoop } from "@/lib/recordingRetry.js";
import { startRecordingConversionWorker, queueConversion } from "@/lib/recordingConversionWorker.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

const AUTO_FINALIZE_MS = 45000; // auto-finish if no chunks arrive for 45s

startRecordingConversionWorker();

export async function POST(request) {
  const formData = await request.formData();
  const chunk = formData.get("chunk");
  const sessionToken = (formData.get("sessionToken") || "").toString();
  const chunkIndexRaw = (formData.get("chunkIndex") || "").toString();
  const isFinal = (formData.get("final") || "").toString() === "1";

  if (!sessionToken) {
    return withCors(NextResponse.json({ success: false, message: "Invalid session" }, { status: 400 }));
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
    catch { return { nextIndex: 0, lastChunkAt: 0, finalized: false, conversionAttempts: 0 }; }
  };
  const saveState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));

  if (chunk && typeof chunk.arrayBuffer === "function") {
    const buffer = Buffer.from(await chunk.arrayBuffer());
    const idx = Number.isFinite(Number(chunkIndexRaw)) ? Number(chunkIndexRaw) : null;
    if (idx === null || Number.isNaN(idx)) {
      return withCors(NextResponse.json({ success: false, message: "Missing chunk index" }, { status: 400 }));
    }
    try {
      fs.writeFileSync(path.join(partsDir, `chunk-${idx}.webm`), buffer);
    } catch (err) {
      console.error(`Failed to write chunk ${idx}:`, err.message);
      throw err;
    }
  }

  const state = loadState();
  let appendedBytes = 0;
  let appendedChunks = 0;
  while (true) {
    const partPath = path.join(partsDir, `chunk-${state.nextIndex}.webm`);
    if (!fs.existsSync(partPath)) break;
    const buf = fs.readFileSync(partPath);
    fs.appendFileSync(webmPath, buf);
    fs.unlinkSync(partPath);
    appendedBytes += buf.length;
    appendedChunks += 1;
    state.nextIndex += 1;
    state.lastChunkAt = Date.now();
    saveState(state);
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

  let converted = false;
  let finalFormat = null;

  const shouldAutoFinalize = !isFinal
    && state.lastChunkAt
    && Date.now() - state.lastChunkAt > AUTO_FINALIZE_MS
    && !state.finalized
    && fs.existsSync(webmPath);

  const finalizeNow = (isFinal || shouldAutoFinalize) && fs.existsSync(webmPath);

  if (finalizeNow) {
    state.finalized = true;
    saveState(state);
    console.log("[recording] finalize triggered", { sessionToken, reason: isFinal ? "client-final" : "auto-timeout" });
    queueConversion(sessionToken);
  } else if (shouldAutoFinalize) {
    // We expected to auto-finalize but webm isn't present; mark as finalized to avoid loops.
    state.finalized = true;
    saveState(state);
  } else if (isFinal) {
    console.warn("isFinal=true but webm file does not exist at:", webmPath);
  }

  console.log("[recording-chunk] Append result", {
    sessionToken,
    appendedChunks,
    appendedBytes,
    hasWebm: fs.existsSync(webmPath),
    hasMp4: fs.existsSync(path.join(recordingsDir, `${sessionToken}.mp4`)),
    isFinal,
    shouldAutoFinalize,
    converted,
    format: finalFormat,
  });

  return withCors(NextResponse.json({
    success: true,
    appendedChunks,
    appendedBytes,
    nextIndex: state.nextIndex,
    final: isFinal,
    converted,
    format: finalFormat,
  }));
}
