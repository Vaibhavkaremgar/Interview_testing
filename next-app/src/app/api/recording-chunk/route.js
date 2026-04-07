import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";
import { enqueueRecordingRetry, startRecordingRetryLoop } from "@/lib/recordingRetry.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

async function convertToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", inputPath,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ]);
    ffmpeg.on("close", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`)));
    ffmpeg.on("error", reject);
  });
}

async function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    const ffprobe = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", filePath]);
    let output = "";
    ffprobe.stdout.on("data", (data) => { output += data.toString(); });
    ffprobe.on("close", (code) => {
      if (code === 0) {
        try { resolve(Math.round(parseFloat(JSON.parse(output).format.duration))); } catch { resolve(0); }
      } else {
        resolve(0);
      }
    });
    ffprobe.on("error", () => resolve(0));
  });
}

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

  const recordingsDir = path.join(process.cwd(), "recordings");
  if (!fs.existsSync(recordingsDir)) {
    try { fs.mkdirSync(recordingsDir); } catch (err) { console.error("Failed to create recordings directory:", err.message); }
  }

  const webmPath = path.join(recordingsDir, `${sessionToken}.webm`);
  const mp4Path = path.join(recordingsDir, `${sessionToken}.mp4`);
  const partsDir = path.join(recordingsDir, `${sessionToken}.parts`);
  if (!fs.existsSync(partsDir)) fs.mkdirSync(partsDir);

  const statePath = path.join(recordingsDir, `${sessionToken}.state.json`);
  const loadState = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { nextIndex: 0 }; } };
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
    saveState(state);
  }

  let converted = false;
  let finalFormat = null;

  if (isFinal && fs.existsSync(webmPath)) {
    let finalPath = webmPath;
    let finalFormatLocal = "webm";
    let duration = 0;

    try {
      await convertToMp4(webmPath, mp4Path);
      if (fs.existsSync(mp4Path)) {
        duration = await getVideoDuration(mp4Path);
        finalPath = mp4Path;
        finalFormatLocal = "mp4";
        converted = true;
        fs.unlinkSync(webmPath);
      }
    } catch (e) {
      console.warn("FFmpeg conversion failed, keeping WebM:", e.message);
      duration = await getVideoDuration(webmPath);
      finalFormatLocal = "webm";
      converted = true;
    }

    if (converted) {
      const stats = fs.statSync(finalPath);
      const fileName = path.basename(finalPath);
      try {
        if (DB_READY && pool) {
          await pool.query(
            `UPDATE interview_sessions
             SET recording_path = $1,
                 recording_size_bytes = $2,
                 recording_duration_seconds = $3,
                 recording_format = $4,
                 recording_data = NULL,
                 recording_created_at = NOW()
             WHERE session_token = $5`,
            [fileName, stats.size, duration, finalFormatLocal, sessionToken]
          );
        }
      } catch (err) {
        console.error("Failed to save recording metadata, enqueuing retry:", err.message);
        await enqueueRecordingRetry(sessionToken, fileName, err.message);
      }
      finalFormat = finalFormatLocal;
    } else if (fs.existsSync(webmPath)) {
      const stats = fs.statSync(webmPath);
      const dur = await getVideoDuration(webmPath);
      const fileName = path.basename(webmPath);
      try {
        if (DB_READY && pool) {
          await pool.query(
            `UPDATE interview_sessions
             SET recording_path = $1,
                 recording_size_bytes = $2,
                 recording_duration_seconds = $3,
                 recording_format = $4,
                 recording_data = NULL,
                 recording_created_at = NOW()
             WHERE session_token = $5`,
            [fileName, stats.size, dur, "webm", sessionToken]
          );
        }
      } catch (err) {
        console.error("Failed to save recording metadata, enqueuing retry:", err.message);
        await enqueueRecordingRetry(sessionToken, fileName, err.message);
      }
      finalFormat = "webm";
    }

    if (fs.existsSync(partsDir)) fs.rmSync(partsDir, { recursive: true, force: true });
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  } else if (isFinal) {
    console.warn("isFinal=true but webm file does not exist at:", webmPath);
  }

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
