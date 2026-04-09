import { pool, DB_READY } from "./db.js";
import { finalizeSession, startRecordingConversionWorker } from "./recordingConversionWorker.js";

const DISCONNECT_EXPIRE_MS = 90_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const WORKER_INTERVAL_MS = 10_000;

let workerStarted = false;
let ensurePromise = null;

async function ensureColumns() {
  if (!DB_READY || !pool) return;
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    const alters = [
      "ALTER TABLE interview_sessions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ",
      "ALTER TABLE interview_sessions ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ",
      "ALTER TABLE interview_sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ",
      "ALTER TABLE interview_sessions ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ",
      "ALTER TABLE interview_sessions ADD COLUMN IF NOT EXISTS connection_status TEXT",
      "ALTER TABLE interview_sessions ADD COLUMN IF NOT EXISTS vapi_call_id TEXT",
      "ALTER TABLE interview_sessions ADD COLUMN IF NOT EXISTS vapi_conversation_state JSONB",
    ];
    for (const sql of alters) {
      try { await pool.query(sql); }
      catch (e) { console.warn("[session] column ensure failed:", e.message); }
    }
  })();
  return ensurePromise;
}

async function expireDisconnectedSessions() {
  if (!DB_READY || !pool) return;
  await ensureColumns();
  try {
    const { rows } = await pool.query(
      `UPDATE interview_sessions
         SET connection_status = 'expired',
             ended_at = NOW()
       WHERE connection_status = 'disconnected'
         AND disconnected_at IS NOT NULL
         AND disconnected_at < NOW() - ($1::INTERVAL)
       RETURNING session_token`,
      [`${DISCONNECT_EXPIRE_MS / 1000} seconds`]
    );
    for (const row of rows) {
      console.log("[session] expired", { sessionToken: row.session_token });
      startRecordingConversionWorker();
      finalizeSession(row.session_token, "expiry").catch(() => {});
    }
  } catch (e) {
    console.error("[session] expire check failed:", e.message);
  }
}

async function markSilentDisconnects() {
  if (!DB_READY || !pool) return;
  await ensureColumns();
  try {
    const { rowCount } = await pool.query(
      `UPDATE interview_sessions
         SET connection_status = 'disconnected',
             disconnected_at = NOW()
       WHERE connection_status IN ('active','resumed')
         AND last_activity_at IS NOT NULL
         AND last_activity_at < NOW() - ($1::INTERVAL)`,
      [`${HEARTBEAT_TIMEOUT_MS / 1000} seconds`]
    );
    if (rowCount > 0) {
      console.log("[session] disconnected", { count: rowCount, reason: "heartbeat-timeout" });
    }
  } catch (e) {
    console.error("[session] silent disconnect check failed:", e.message);
  }
}

function startSessionWorker() {
  if (!DB_READY || !pool) return;
  if (workerStarted) return;
  workerStarted = true;
  ensureColumns().catch(() => {});
  startRecordingConversionWorker();
  setInterval(() => {
    markSilentDisconnects();
    expireDisconnectedSessions();
  }, WORKER_INTERVAL_MS).unref?.();
}

export {
  startSessionWorker,
  ensureColumns,
  DISCONNECT_EXPIRE_MS,
};
