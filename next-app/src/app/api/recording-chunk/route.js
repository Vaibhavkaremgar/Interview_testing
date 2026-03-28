import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
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

  const recordingsDir = path.join(process.cwd(), "recordings");
  if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir);

  const filename = `${sessionToken}.webm`;
  const fullPath = path.join(recordingsDir, filename);
  const partsDir = path.join(recordingsDir, `${sessionToken}.parts`);
  if (!fs.existsSync(partsDir)) fs.mkdirSync(partsDir);

  const statePath = path.join(recordingsDir, `${sessionToken}.state.json`);
  const loadState = () => {
    try {
      return JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      return { nextIndex: 0 };
    }
  };
  const saveState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));

  // If a chunk is provided, store it by index first.
  if (chunk && typeof chunk.arrayBuffer === "function") {
    const buffer = Buffer.from(await chunk.arrayBuffer());
    const idx = Number.isFinite(Number(chunkIndexRaw)) ? Number(chunkIndexRaw) : null;
    if (idx === null || Number.isNaN(idx)) {
      return withCors(NextResponse.json({ success: false, message: "Missing chunk index" }, { status: 400 }));
    }
    const partPath = path.join(partsDir, `chunk-${idx}.webm`);
    fs.writeFileSync(partPath, buffer);
  }

  // Append any contiguous chunks in order to the single file.
  const state = loadState();
  let appendedBytes = 0;
  let appendedChunks = 0;
  while (true) {
    const partPath = path.join(partsDir, `chunk-${state.nextIndex}.webm`);
    if (!fs.existsSync(partPath)) break;
    const buf = fs.readFileSync(partPath);
    fs.appendFileSync(fullPath, buf);
    fs.unlinkSync(partPath);
    appendedBytes += buf.length;
    appendedChunks += 1;

    const relativePath = `recordings/${filename}`;
    if (DB_READY && pool) {
      pool.query(
        `UPDATE interview_sessions
         SET recording_path = $1,
             recording_size_bytes = COALESCE(recording_size_bytes, 0) + $2,
             recording_data = COALESCE(recording_data, ''::bytea) || $3
         WHERE session_token = $4`,
        [relativePath, buf.length, buf, sessionToken]
      ).catch(e => console.warn("Could not append recording chunk to DB:", e.message));
    }

    state.nextIndex += 1;
    saveState(state);
  }

  return withCors(NextResponse.json({
    success: true,
    appendedChunks,
    appendedBytes,
    nextIndex: state.nextIndex,
    final: isFinal,
  }));
}
