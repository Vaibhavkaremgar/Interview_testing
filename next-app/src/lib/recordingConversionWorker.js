import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { pool, DB_READY } from "./db.js";

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), "recordings");
const FINALIZE_INACTIVE_MS = 30000;
const FINALIZE_SWEEP_MS = 60000;
const CONVERT_SWEEP_MS = 30000;
const MAX_CONVERT_RETRIES = 10;
const FFMPEG_ENV = process.env.FFMPEG_BIN || process.env.FFMPG_BIN || "";
const FFPROBE_ENV = process.env.FFPROBE_BIN || "";

let workerStarted = false;
let converting = false;
let resolvedFFmpeg = null;
let resolvedFFprobe = null;
const pending = new Set();

function detectBinary(candidates = [], name = "binary") {
  for (const bin of candidates.filter(Boolean)) {
    try {
      const res = spawnSync(bin, ["-version"], { stdio: "pipe" });
      if (res.status === 0) return bin;
    } catch {
      // ignore and try next
    }
  }
  return null;
}

function ensureBinaries() {
  if (!resolvedFFmpeg) {
    resolvedFFmpeg = detectBinary([FFMPEG_ENV, "ffmpeg"], "ffmpeg");
    if (!resolvedFFmpeg) {
      console.error("[recording] FFmpeg not available. Set FFMPEG_BIN or install system ffmpeg.");
    } else {
      const v = spawnSync(resolvedFFmpeg, ["-version"], { stdio: "pipe", encoding: "utf8" });
      console.info("[recording] FFmpeg detected:", resolvedFFmpeg, (v?.stdout || "").split("\n")[0] || "");
    }
  }
  if (!resolvedFFprobe) {
    resolvedFFprobe = detectBinary([FFPROBE_ENV, "ffprobe"], "ffprobe");
    if (!resolvedFFprobe) {
      console.warn("[recording] ffprobe not available; duration metadata will be zero. Set FFPROBE_BIN or install ffprobe.");
    } else {
      const v = spawnSync(resolvedFFprobe, ["-version"], { stdio: "pipe", encoding: "utf8" });
      console.info("[recording] ffprobe detected:", resolvedFFprobe, (v?.stdout || "").split("\n")[0] || "");
    }
  }
}

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
  if (!resolvedFFmpeg) throw new Error("FFmpeg unavailable");
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(resolvedFFmpeg, [
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
  if (!resolvedFFprobe) return 0;
  return new Promise((resolve) => {
    const ffprobe = spawn(resolvedFFprobe, ["-v", "quiet", "-print_format", "json", "-show_format", filePath]);
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
    const webmDuration = await getVideoDuration(paths.webm);
    await convertToMp4(paths.webm, paths.mp4);
    if (!fs.existsSync(paths.mp4)) throw new Error("mp4 missing after ffmpeg");

    const mp4Duration = await getVideoDuration(paths.mp4);
    const mp4Stats = fs.statSync(paths.mp4);
    const webmStats = fs.statSync(paths.webm);

    const durationsClose = webmDuration === 0 || mp4Duration === 0
      ? true
      : Math.abs(mp4Duration - webmDuration) <= 2;

    const useMp4 = durationsClose && mp4Duration >= Math.max(webmDuration - 2, 0);
    const chosenPath = useMp4 ? paths.mp4 : paths.webm;
    const chosenFormat = useMp4 ? "mp4" : "webm";
    const chosenStats = useMp4 ? mp4Stats : webmStats;
    const chosenDuration = useMp4 ? mp4Duration : webmDuration;

    if (!useMp4) {
      console.warn("[recording] mp4 shorter than webm; keeping webm", { sessionToken, mp4Duration, webmDuration });
    }

    if (DB_READY && pool) {
      await pool.query(
        `UPDATE interview_sessions
           SET recording_path = $1,
               recording_size_bytes = $2,
               recording_duration_seconds = $3,
               recording_format = $4,
               recording_data = NULL,
               recording_created_at = COALESCE(recording_created_at, NOW())
         WHERE session_token = $5`,
        [path.basename(chosenPath), chosenStats.size, chosenDuration, chosenFormat, sessionToken]
      );
    }

    console.log("[recording] conversion success", { sessionToken, chosenFormat, duration: chosenDuration, size: chosenStats.size });
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
  ensureBinaries();
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
