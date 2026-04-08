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
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return null;
  }

  const ranges = rangeHeader.substring(6).split(",");
  if (ranges.length !== 1) {
    return null;
  }

  const range = ranges[0].trim();
  const parts = range.split("-");
  if (parts.length !== 2) {
    return null;
  }

  let start = parseInt(parts[0], 10);
  let end = parseInt(parts[1], 10);

  if (isNaN(start)) {
    start = fileSize - end;
    end = fileSize - 1;
  } else if (isNaN(end)) {
    end = fileSize - 1;
  }

  if (start >= fileSize || end >= fileSize || start > end) {
    return null;
  }

  return { start, end };
}

export async function GET(request, { params }) {
  const sessionToken = params?.sessionToken || "";
  if (!DB_READY || !pool) {
    return withCors(NextResponse.json({ error: "DB not available" }, { status: 503 }));
  }

  try {
    console.log("[recording] GET", { sessionToken });

    const { rows } = await pool.query(
      `SELECT recording_path, recording_size_bytes, recording_format, recording_duration_seconds, recording_data
       FROM interview_sessions
       WHERE session_token = $1`,
      [sessionToken]
    );

    if (!rows.length || (!rows[0].recording_path && !rows[0].recording_data)) {
      return withCors(NextResponse.json({ error: "Recording not found" }, { status: 404 }));
    }

    const { recording_path, recording_size_bytes, recording_format, recording_duration_seconds, recording_data } = rows[0];
    console.log("[recording] DB row", { recording_path, size: recording_size_bytes, format: recording_format });

    if (recording_data) {
      const headers = new Headers();
      headers.set("Content-Type", recording_format === "mp4" ? "video/mp4" : "video/webm");
      headers.set("Accept-Ranges", "bytes");
      headers.set("Content-Length", recording_data.length.toString());

      if (recording_duration_seconds) {
        headers.set("X-Duration-Seconds", recording_duration_seconds.toString());
      }

      applyCors(headers);

      return new Response(recording_data, { headers });
    }

    const recordingsDir = process.env.RECORDINGS_DIR || path.join(process.cwd(), "recordings");
    const fullPath = path.join(recordingsDir, recording_path);
    // Debug: log which instance is serving and which path it's using
    console.log("[recording] host:", process.env.HOSTNAME || "unknown",
                "cwd:", process.cwd(),
                "file:", fullPath,
                "exists:", fs.existsSync(fullPath));

    console.log("[recording] file check", { fullPath, exists: fs.existsSync(fullPath) });

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
        const chunkSize = end - start + 1;

        headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);
        headers.set("Content-Length", chunkSize.toString());

        const stream = fs.createReadStream(fullPath, { start, end });
        return new Response(stream, {
          status: 206,
          headers
        });
      }
    }

    const stream = fs.createReadStream(fullPath);
    return new Response(stream, { headers });

  } catch (e) {
    console.error("Error serving recording:", e);
    return withCors(NextResponse.json({ error: e.message }, { status: 500 }));
  }
}
