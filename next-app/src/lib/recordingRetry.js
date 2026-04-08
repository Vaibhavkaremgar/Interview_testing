import fs from "fs";
import path from "path";
import { pool, DB_READY } from "./db.js";
import { recoverMissingRecordings } from "./recordingRecovery.js";

const RETRY_INTERVAL_MS = 30000;
const MAX_BATCH = 10;

let ensureTablePromise = null;
let loopStarted = false;

async function ensureRetryTable() {
  if (!DB_READY || !pool) return;
  if (!ensureTablePromise) {
    ensureTablePromise = pool.query(`
      CREATE TABLE IF NOT EXISTS recording_retry_queue (
        id SERIAL PRIMARY KEY,
        session_token TEXT NOT NULL,
        file_name TEXT NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch((e) => {
      console.error("recording_retry_queue init failed:", e.message);
      ensureTablePromise = null;
    });
  }
  return ensureTablePromise;
}

async function enqueueRecordingRetry(sessionToken, fileName, errorMsg = "") {
  if (!DB_READY || !pool || !sessionToken || !fileName) return;
  try {
    await ensureRetryTable();
    await pool.query(
      `INSERT INTO recording_retry_queue (session_token, file_name, last_error)
       VALUES ($1, $2, $3)`,
      [sessionToken, fileName, errorMsg?.toString().slice(0, 500)]
    );
  } catch (e) {
    console.error("Failed to enqueue recording retry:", e.message);
  }
}

async function runRetryCycle() {
  if (!DB_READY || !pool) return;
  try {
    await ensureRetryTable();
    await recoverMissingRecordings();
    const { rows } = await pool.query(
      `SELECT id, session_token, file_name, attempts FROM recording_retry_queue
       ORDER BY created_at ASC
       LIMIT $1`,
      [MAX_BATCH]
    );
    for (const row of rows) {
      const recordingsDir = process.env.RECORDINGS_DIR || path.join(process.cwd(), "recordings");
      const fullPath = path.join(recordingsDir, row.file_name);
      const stats = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;
      if (!stats) {
        await pool.query(
          `UPDATE recording_retry_queue
             SET attempts = attempts + 1,
                 last_error = $1
           WHERE id = $2`,
          ["file not found on disk", row.id]
        );
        continue;
      }

      try {
        const format = path.extname(row.file_name).toLowerCase() === ".mp4" ? "mp4" : "webm";
        await pool.query(
          `UPDATE interview_sessions
             SET recording_path = $1,
                 recording_size_bytes = COALESCE(recording_size_bytes, $2),
                 recording_format = COALESCE(recording_format, $3),
                 recording_created_at = COALESCE(recording_created_at, NOW())
           WHERE session_token = $4`,
          [row.file_name, stats.size, format, row.session_token]
        );

        await pool.query(`DELETE FROM recording_retry_queue WHERE id = $1`, [row.id]);
      } catch (err) {
        await pool.query(
          `UPDATE recording_retry_queue
             SET attempts = attempts + 1,
                 last_error = $1
           WHERE id = $2`,
          [err.message?.slice(0, 500) || "update failed", row.id]
        );
      }
    }
  } catch (e) {
    console.error("Recording retry cycle failed:", e.message);
  }
}

function startRecordingRetryLoop() {
  if (!DB_READY || !pool) return;
  if (loopStarted) return;
  loopStarted = true;
  ensureRetryTable()
    .then(() => {
      const timer = setInterval(runRetryCycle, RETRY_INTERVAL_MS);
      // Avoid holding the event loop open in serverless-like environments
      if (typeof timer.unref === "function") timer.unref();
    })
    .catch(() => {
      loopStarted = false; // allow retry on next call
    });
}

export { enqueueRecordingRetry, startRecordingRetryLoop };
