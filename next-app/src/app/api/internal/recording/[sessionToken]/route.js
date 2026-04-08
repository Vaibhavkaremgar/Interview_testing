import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { pool, DB_READY } from "@/lib/db.js";
import { applyCors, corsHeaders, withCors } from "@/lib/cors.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

function parseRange(rangeHeader, fileSize) {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) return null;
  const ranges = rangeHeader.substring(6).split(",");
  if (ranges.length !== 1) return null;
  const [startStr, endStr] = ranges[0].trim().split("-");
  let start = parseInt(startStr, 10);
  let end = parseInt(endStr, 10);
  if (isNaN(start)) {
    start = fileSize - end;
    end = fileSize - 1;
  } else if (isNaN(end)) {
    end = fileSize - 1;
  }
  if (start >= fileSize || end >= fileSize || start > end) return null;
  return { start, end };
}

function unauthorized() {
  return withCors(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
}

export async function GET(request, { params }) {
  // Service token auth
  const expectedToken = process.env.INTERNAL_SERVICE_TOKEN || "";
  const auth = request.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!expectedToken || token !== expectedToken) {
    return unauthorized();
  }

  const sessionToken = params?.sessionToken || "";
  if (!sessionToken) {
    return withCors(NextResponse.json({ error: "Session token required" }, { status: 400 }));
  }

  if (!DB_READY || !pool) {
    return withCors(NextResponse.json({ error: "DB not available" }, { status: 503 }));
  }

  try {
    const { rows } = await pool.query(
      `SELECT recording_path, recording_format, recording_duration_seconds
         FROM interview_sessions
        WHERE session_token = $1`,
      [sessionToken]
    );

    if (!rows.length || !rows[0].recording_path) {
      return withCors(NextResponse.json({ error: "Recording not found" }, { status: 404 }));
    }

    const { recording_path, recording_format, recording_duration_seconds } = rows[0];
    const recordingsDir =
      process.env.RECORDINGS_DIR || "/app/next-app/recordings";
    const fullPath = path.join(recordingsDir, recording_path);

    if (!fs.existsSync(fullPath)) {
      return withCors(NextResponse.json({ error: "Recording file not found" }, { status: 404 }));
    }

    const stat = fs.statSync(fullPath);
    const fileSize = stat.size;
    const rangeHeader = request.headers.get("range");

    const headers = new Headers();
    headers.set("Content-Type", recording_format === "mp4" ? "video/mp4" : "video/webm");
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Length", fileSize.toString());
    if (recording_duration_seconds) {
      headers.set("X-Duration-Seconds", recording_duration_seconds.toString());
    }
    applyCors(headers);

    if (rangeHeader) {
      const range = parseRange(rangeHeader, fileSize);
      if (range) {
        const { start, end } = range;
        headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);
        headers.set("Content-Length", (end - start + 1).toString());
        const stream = fs.createReadStream(fullPath, { start, end });
        return new Response(stream, { status: 206, headers });
      }
    }

    const stream = fs.createReadStream(fullPath);
    return new Response(stream, { headers });
  } catch (e) {
    console.error("[internal recording] error:", e);
    return withCors(NextResponse.json({ error: "Failed to stream recording" }, { status: 500 }));
  }
}
