import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";
import { enqueueRecordingRetry, startRecordingRetryLoop } from "@/lib/recordingRetry.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request) {
  const formData = await request.formData();
  const file = formData.get("recording");
  const sessionToken = formData.get("sessionToken") || "";

  startRecordingRetryLoop();

  if (!file || typeof file.arrayBuffer !== "function") {
    return withCors(NextResponse.json({ success: false, message: "No file" }, { status: 400 }));
  }

  const recordingsDir = path.join(process.cwd(), "recordings");
  if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir);

  const filename = `${sessionToken || Date.now()}.webm`;
  const fullPath = path.join(recordingsDir, filename);
  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(fullPath, buffer);

  const relativePath = filename;
  const sizeBytes = buffer.length;

  if (sessionToken && DB_READY && pool) {
    try {
      await pool.query(
        `UPDATE interview_sessions SET recording_path = $1, recording_size_bytes = $2, recording_data = NULL WHERE session_token = $3`,
        [relativePath, sizeBytes, sessionToken]
      );
    } catch (e) {
      console.warn("Could not save recording to DB, enqueuing retry:", e.message);
      await enqueueRecordingRetry(sessionToken, relativePath, e.message);
    }
  }

  return withCors(NextResponse.json({ success: true, file: filename, size: sizeBytes }));
}
