import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { pool, DB_READY } from "./db.js";

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), "recordings");
const FINALIZE_INACTIVE_MS = 30000;
const FINALIZE_SWEEP_MS = 60000;
const CONVERT_SWEEP_MS = 30000;
const MAX_CONVERT_RETRIES = 10;
const FFMPG_BIN = ffmpegStatic || "ffmpeg";
const FFPROBE_BIN = (ffprobeStatic && (ffprobeStatic.path || ffprobeStatic.ffprobePath)) || "ffprobe";

let workerStarted = false;
let converting = false;
const pending = new Set();

function ensureDir() {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    try { fs.mkdirSync(RECORDINGS_DIR); } catch (e) { console.error("[recording] Failed to create recordings dir:", e.message); }
  }
}

function sessionPaths(sessionToken) {
  ensureDir();
  return {
    webm: path.join(RECORDINGS_DIR, `${sessionToken}.webm`),
    mp4: path.join(RECORDINGS_DIR, `${sessionToken}.mp4`),
    parts: path.join(RECORDINGS_DIR, `${sessionToken}.parts`),
    state: path.join(RECORDINGS_DIR, `${sessionToken}.state.json`),
  };
}

function loadState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return { nextIndex: 0, lastChunkAt: 0, finalized: false, conversionAttempts: 0 }; }
}

function saveState(statePath, state) {
  try { fs.writeFileSync(statePath, JSON.stringify(state)); } catch (e) { console.warn("[recording] Could not persist state:", e.message); }
}

async function convertToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPG_BIN, [
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
    const ffprobe = spawn(FFPROBE_BIN, ["-v", "quiet", "-print_format", "json", "-show_format", filePath]);
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

function mergeAvailableParts(sessionToken) {
  const { webm, parts, state: statePath } = sessionPaths(sessionToken);
  const state = loadState(statePath);
  let merged = 0;

  // If state got reset but parts exist, start from 0.
  if (!fs.existsSync(webm) && state.nextIndex > 0 && !fs.existsSync(path.join(parts, `chunk-${state.nextIndex}.webm`))) {
    state.nextIndex = 0;
  }

  while (true) {
    const partPath = path.join(parts, `chunk-${state.nextIndex}.webm`);
    if (!fs.existsSync(partPath)) break;
    const buf = fs.readFileSync(partPath);
    fs.appendFileSync(webm, buf);
    fs.unlinkSync(partPath);
    merged += 1;
    state.nextIndex += 1;
    state.lastChunkAt = state.lastChunkAt || Date.now();
  }

  if (merged > 0) saveState(statePath, state);
  return { merged, state };
}

async function finalizeSession(sessionToken, reason = "idle") {
  const paths = sessionPaths(sessionToken);
  const state = loadState(paths.state);
  const now = Date.now();
  const last = state.lastChunkAt || 0;

  if (state.finalized) return;
  const inactive = !last || now - last > FINALIZE_INACTIVE_MS;
  if (!inactive && (reason === "idle" || reason === "sweep")) return;

  const { merged } = mergeAvailableParts(sessionToken);
  if (!fs.existsSync(paths.webm) && merged === 0) return;

  state.finalized = true;
  saveState(paths.state, state);
  console.log("[recording] finalize triggered", { sessionToken, reason, merged });
  queueConversion(sessionToken);
}

async function convertSession(sessionToken) {
  const paths = sessionPaths(sessionToken);
  const state = loadState(paths.state);

  // Skip if mp4 already exists
  if (fs.existsSync(paths.mp4)) {
    cleanup(sessionToken);
    return;
  }

  // Ensure webm exists; try merge pending parts before converting.
  mergeAvailableParts(sessionToken);

  if (!fs.existsSync(paths.webm)) return;

  if (state.conversionAttempts >= MAX_CONVERT_RETRIES) {
    console.warn("[recording] Max conversion retries reached", { sessionToken });
    return;
  }

  state.conversionAttempts = (state.conversionAttempts || 0) + 1;
  saveState(paths.state, state);
  console.log("[recording] conversion retry", { sessionToken, attempt: state.conversionAttempts });

  try {
    await convertToMp4(paths.webm, paths.mp4);
    if (!fs.existsSync(paths.mp4)) throw new Error("mp4 missing after ffmpeg");

    const duration = await getVideoDuration(paths.mp4);
    const stats = fs.statSync(paths.mp4);
    const fileName = path.basename(paths.mp4);

    if (DB_READY && pool) {
      await pool.query(
        `UPDATE interview_sessions
           SET recording_path = $1,
               recording_size_bytes = $2,
               recording_duration_seconds = $3,
               recording_format = 'mp4',
               recording_data = NULL,
               recording_created_at = COALESCE(recording_created_at, NOW())
         WHERE session_token = $4`,
        [fileName, stats.size, duration, sessionToken]
      );
    }

    console.log("[recording] conversion success", { sessionToken, duration, size: stats.size });
    cleanup(sessionToken);
  } catch (err) {
    console.warn("[recording] conversion failed", { sessionToken, error: err.message });
    // Leave webm for retry; state already incremented.
  }
}

function cleanup(sessionToken) {
  const paths = sessionPaths(sessionToken);
  if (fs.existsSync(paths.parts)) fs.rmSync(paths.parts, { recursive: true, force: true });
  if (fs.existsSync(paths.state)) fs.unlinkSync(paths.state);
  if (fs.existsSync(paths.webm)) fs.unlinkSync(paths.webm);
}

function gatherSessionTokens() {
  ensureDir();
  const entries = fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true });
  const tokens = new Set();

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith(".parts")) {
      tokens.add(entry.name.replace(/\.parts$/, ""));
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".webm") || entry.name.endsWith(".mp4") || entry.name.endsWith(".state.json")) {
        tokens.add(entry.name.replace(/\.(webm|mp4|state\.json)$/i, ""));
      }
    }
  }
  return Array.from(tokens);
}

async function finalizeSweep() {
  const tokens = gatherSessionTokens();
  for (const token of tokens) {
    await finalizeSession(token, "sweep");
  }
}

async function convertSweep() {
  const tokens = gatherSessionTokens();
  for (const token of tokens) {
    const paths = sessionPaths(token);
    if (
      fs.existsSync(paths.mp4) &&
      !fs.existsSync(paths.webm) &&
      !fs.existsSync(paths.parts) &&
      !fs.existsSync(paths.state)
    ) {
      continue;
    }
    queueConversion(token);
  }
}

function processQueue() {
  if (converting) return;
  converting = true;
  const next = pending.values().next().value;
  if (!next) { converting = false; return; }
  pending.delete(next);
  convertSession(next)
    .catch((e) => console.error("[recording] conversion crash", e))
    .finally(() => { converting = false; setImmediate(processQueue); });
}

function queueConversion(sessionToken) {
  pending.add(sessionToken);
  console.log("[recording] conversion queued", { sessionToken });
  setImmediate(processQueue);
}

function startRecordingConversionWorker() {
  if (workerStarted) return;
  workerStarted = true;
  ensureDir();
  // Startup sweep
  finalizeSweep().catch(() => {});
  convertSweep().catch(() => {});
  setInterval(() => finalizeSweep().catch(() => {}), FINALIZE_SWEEP_MS).unref?.();
  setInterval(() => convertSweep().catch(() => {}), CONVERT_SWEEP_MS).unref?.();
}

export {
  startRecordingConversionWorker,
  queueConversion,
  finalizeSession,
  mergeAvailableParts,
};
