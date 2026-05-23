import { pool, DB_READY } from "./db.js";
import { finalizeSession, startRecordingConversionWorker } from "./recordingConversionWorker.js";

const DISCONNECT_EXPIRE_MS = 90_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const WORKER_INTERVAL_MS = 10_000;
const NO_SHOW_GRACE_MS = Number(process.env.NO_SHOW_GRACE_MS || 30 * 60 * 1000);

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

async function markMissedInterviewsAsNoShow() {
  if (!DB_READY || !pool) return;
  await ensureColumns();

  const graceInterval = `${Math.max(1, Math.floor(NO_SHOW_GRACE_MS / 1000))} seconds`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT i.async_token AS session_token, i.candidate_id
         FROM interviews i
         JOIN interview_sessions s ON s.session_token = i.async_token
        WHERE LOWER(COALESCE(i.status, 'scheduled')) = 'scheduled'
          AND i.async_completed_at IS NULL
          AND s.started_at IS NULL
          AND s.ended_at IS NULL
          AND i.scheduled_at IS NOT NULL
          AND i.scheduled_at < NOW() - ($1::INTERVAL)
        FOR UPDATE OF i, s`,
      [graceInterval]
    );

    if (!rows.length) {
      await client.query("COMMIT");
      return;
    }

    const sessionTokens = rows.map((row) => row.session_token).filter(Boolean);
    const candidateIds = rows.map((row) => row.candidate_id).filter(Boolean);

    await client.query(
      `UPDATE interviews
          SET status = 'no_show',
              async_completed_at = NOW()
        WHERE async_token = ANY($1::text[])`,
      [sessionTokens]
    );

    await client.query(
      `UPDATE interview_sessions
          SET status = 'no_show',
              connection_status = 'no_show',
              ended_at = NOW()
        WHERE session_token = ANY($1::text[])`,
      [sessionTokens]
    );

    if (candidateIds.length) {
      await client.query(
        `UPDATE candidates
            SET stage = 'NO_SHOW',
                stage_updated_at = NOW()
          WHERE id = ANY($1::uuid[])`,
        [candidateIds]
      );
    }

    await client.query("COMMIT");
    console.log("[session] no-show marked", { count: sessionTokens.length });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[session] no-show sweep failed:", e.message);
  } finally {
    client.release();
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
    markMissedInterviewsAsNoShow();
  }, WORKER_INTERVAL_MS).unref?.();
}

export {
  startSessionWorker,
  ensureColumns,
  DISCONNECT_EXPIRE_MS,
};
