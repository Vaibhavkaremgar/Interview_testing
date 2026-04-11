import fs from "fs";
import path from "path";
import { spawn, spawnSync, execSync } from "child_process";
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
const convertingSessions = new Set();
let resolvedFFmpeg = null;
let resolvedFFprobe = null;
const pending = new Set();

function getFFmpegPath() {
  return process.env.FFMPEG_BIN || "ffmpeg";
}

function checkFFmpeg() {
  try {
    const version = execSync(`${getFFmpegPath()} -version`, { stdio: "pipe" }).toString();
    const first = (version || "").split("\n")[0] || "";
    console.log("✅ FFmpeg available", first);
  } catch (err) {
    console.error("❌ FFmpeg not found", err?.message || err);
  }
}

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

  if (!resolvedFFmpeg) {
    resolvedFFmpeg = detectBinary([getFFmpegPath()], "ffmpeg");
    if (!resolvedFFmpeg) {
      console.warn("[recording] ffmpeg not available; mp4 conversion will be skipped. Set FFMPEG_BIN or install ffmpeg.");
    } else {
      const v = spawnSync(resolvedFFmpeg, ["-version"], { stdio: "pipe", encoding: "utf8" });
      console.info("[recording] ffmpeg detected:", resolvedFFmpeg, (v?.stdout || "").split("\n")[0] || "");
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
  catch { return { nextIndex: 0, lastChunkAt: 0, finalized: false, conversionAttempts: 0, merging: false }; }
}

function saveState(statePath, state) {
  try { fs.writeFileSync(statePath, JSON.stringify(state)); } catch (e) { console.warn("[recording] Could not persist state:", e.message); }
}

async function convertToMp4(inputPath, outputPath) {
  const ffmpegPath = resolvedFFmpeg || getFFmpegPath();
  if (!ffmpegPath) throw new Error("ffmpeg not available");
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-y",
      "-i", inputPath,
      "-r", "30",
      "-c:v", "libx264",
      "-c:a", "aac",
      outputPath,
    ], { stdio: "inherit" });

    ff.on("error", (err) => reject(err));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
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
  if (typeof state.merging !== "boolean") state.merging = false;
  if (state.merging) return { merged: 0, state };

  let merged = 0;

  // If state got reset but parts exist, start from 0.
  if (!fs.existsSync(webm) && state.nextIndex > 0 && !fs.existsSync(path.join(parts, `chunk-${state.nextIndex}.webm`))) {
    state.nextIndex = 0;
  }

  state.merging = true;
  saveState(statePath, state);

  try {
    const files = fs.existsSync(parts)
      ? fs.readdirSync(parts)
        .filter(f => f.startsWith("chunk-") && f.endsWith(".webm"))
        .map(f => {
          const match = f.match(/chunk-(\d+)\.webm/);
          return match ? { name: f, index: parseInt(match[1], 10) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.index - b.index)
      : [];

    for (const file of files) {
      const partPath = path.join(parts, file.name);
      if (!fs.existsSync(partPath)) continue;
      const buf = fs.readFileSync(partPath);
      console.log("[Recording] merging chunk", { sessionToken, index: file.index, size: buf.length, worker: true });
      fs.appendFileSync(webm, buf);
      fs.unlinkSync(partPath);
      merged += 1;
      state.nextIndex = Math.max(state.nextIndex, file.index + 1);
    }
  } finally {
    state.merging = false;
    if (merged > 0 && !state.lastChunkAt) state.lastChunkAt = Date.now();
    saveState(statePath, state);
  }

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
  console.log("[Recording] finalize triggered", { sessionToken, reason, merged });
  queueConversion(sessionToken);
}

async function convertSession(sessionToken) {
  if (convertingSessions.has(sessionToken)) return;
  convertingSessions.add(sessionToken);
  console.log("starting conversion", sessionToken);
  try {
    const paths = sessionPaths(sessionToken);
    const state = loadState(paths.state);

    // Ensure webm exists; try merge pending parts before "finalizing".
    mergeAvailableParts(sessionToken);

    if (!fs.existsSync(paths.webm)) return;

    const webmDuration = await getVideoDuration(paths.webm);
    const webmStats = fs.statSync(paths.webm);
    let mp4Stats = null;
    let mp4Duration = 0;
    console.log("webm created:", paths.webm);

    if (!fs.existsSync(paths.mp4) || fs.statSync(paths.mp4).mtimeMs < webmStats.mtimeMs) {
      try {
        console.log("converting to mp4", { sessionToken });
        await convertToMp4(paths.webm, paths.mp4);
        mp4Stats = fs.existsSync(paths.mp4) ? fs.statSync(paths.mp4) : null;
        if (mp4Stats) mp4Duration = await getVideoDuration(paths.mp4);
        if (mp4Stats) console.log("mp4 created:", paths.mp4);
      } catch (e) {
        console.error("[recording] mp4 conversion failed", { sessionToken, error: e.message });
      }
    } else {
      mp4Stats = fs.statSync(paths.mp4);
      mp4Duration = await getVideoDuration(paths.mp4);
    }

    const finalPath = mp4Stats ? path.basename(paths.mp4) : path.basename(paths.webm);
    const finalSize = mp4Stats ? mp4Stats.size : webmStats.size;
    const finalDuration = mp4Stats ? (mp4Duration || webmDuration) : webmDuration;
    const finalFormat = mp4Stats ? "mp4" : "webm";

    if (DB_READY && pool) {
      try {
        await pool.query(
          `UPDATE interview_sessions
             SET recording_path = $1,
                 recording_size_bytes = $2,
                 recording_duration_seconds = $3,
                 recording_format = $4,
                 recording_data = NULL,
                 recording_created_at = COALESCE(recording_created_at, NOW())
           WHERE session_token = $5`,
          [finalPath, finalSize, finalDuration, finalFormat, sessionToken]
        );
      } catch (e) {
        console.warn("[recording] DB update failed", { sessionToken, error: e.message });
      }
    }

    console.log("conversion completed", sessionToken);
    console.log("[recording] webm finalized", {
      sessionToken,
      webmDuration,
      webmSize: webmStats.size,
      mp4Duration,
      mp4Size: mp4Stats?.size || null,
      format: finalFormat,
    });
    cleanup(sessionToken);
  } finally {
    convertingSessions.delete(sessionToken);
  }
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
  checkFFmpeg();
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
