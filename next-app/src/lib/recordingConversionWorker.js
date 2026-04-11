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
  throw new Error("FFmpeg conversion disabled");
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

  // Ensure webm exists; try merge pending parts before "finalizing".
  mergeAvailableParts(sessionToken);

  if (!fs.existsSync(paths.webm)) return;

  const webmDuration = await getVideoDuration(paths.webm);
  const webmStats = fs.statSync(paths.webm);

  if (DB_READY && pool) {
    try {
      await pool.query(
        `UPDATE interview_sessions
           SET recording_path = $1,
               recording_size_bytes = $2,
               recording_duration_seconds = $3,
               recording_format = 'webm',
               recording_data = NULL,
               recording_created_at = COALESCE(recording_created_at, NOW())
         WHERE session_token = $4`,
        [path.basename(paths.webm), webmStats.size, webmDuration, sessionToken]
      );
    } catch (e) {
      console.warn("[recording] DB update failed", { sessionToken, error: e.message });
    }
  }

  console.log("[recording] webm finalized", { sessionToken, duration: webmDuration, size: webmStats.size });
  cleanup(sessionToken);
}

function cleanup(sessionToken) {
  const paths = sessionPaths(sessionToken);
  if (fs.existsSync(paths.parts)) fs.rmSync(paths.parts, { recursive: true, force: true });
  if (fs.existsSync(paths.state)) fs.unlinkSync(paths.state);
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
