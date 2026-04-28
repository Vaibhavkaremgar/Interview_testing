import fs from "fs";
import path from "path";
import { pool, DB_READY } from "./db.js";

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), "recordings");

async function recoverMissingRecordings() {
  if (!DB_READY || !pool) return;

  let dirEntries;
  try {
    dirEntries = await fs.promises.readdir(RECORDINGS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("[recording-recovery] Could not read recordings dir:", err.message);
    }
    return;
  }

  const files = dirEntries
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => /\.(mp4|webm)$/i.test(name));

  const bestBySession = new Map();
  for (const file of files) {
    const basename = path.basename(file);
    const sessionToken = basename.replace(/\.(mp4|webm)$/i, "");
    const format = basename.toLowerCase().endsWith(".mp4") ? "mp4" : "webm";
    const existing = bestBySession.get(sessionToken);
    if (!existing || (existing.format !== "mp4" && format === "mp4")) {
      bestBySession.set(sessionToken, { basename, format });
    }
  }

  for (const { basename, format } of bestBySession.values()) {
    try {
      const { rowCount } = await pool.query(
        "SELECT 1 FROM interview_sessions WHERE recording_path = $1 LIMIT 1",
        [basename]
      );
      if (rowCount && rowCount > 0) continue;

      const sessionToken = basename.replace(/\.(mp4|webm)$/i, "");
      const fullPath = path.join(RECORDINGS_DIR, basename);
      const stats = await fs.promises.stat(fullPath).catch(() => null);
      if (!stats) continue;
      const res = await pool.query(
        `UPDATE interview_sessions
           SET recording_path = $1,
               recording_size_bytes = $2,
               recording_format = $3,
               recording_created_at = COALESCE(recording_created_at, NOW())
         WHERE session_token = $4`,
        [basename, stats.size, format, sessionToken]
      );

      if (res.rowCount > 0) {
        console.log("[recording-recovery] Restored recording_path", {
          sessionToken,
          file: basename,
          size: stats.size,
          format,
        });
      }
    } catch (err) {
      console.warn("[recording-recovery] Recovery attempt failed:", err.message);
    }
  }
}

export { recoverMissingRecordings };
