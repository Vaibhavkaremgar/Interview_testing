import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { pool, DB_READY } from "@/lib/db.js";
import { applyCors, corsHeaders, withCors } from "@/lib/cors.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

function unauthorized() {
  return withCors(
    NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  );
}

function validateAuth(request) {
  const expectedToken =
    process.env.RECORDING_SERVICE_TOKEN ||
    process.env.INTERNAL_SERVICE_TOKEN ||
    "";

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader
    .toLowerCase()
    .startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";

  console.log("[recording-auth]", {
    hasExpected: !!expectedToken,
    hasAuthHeader: !!authHeader,
    tokenMatch: token === expectedToken,
  });

  if (!expectedToken) {
    console.warn(
      "[recording] Missing RECORDING_SERVICE_TOKEN/INTERNAL_SERVICE_TOKEN"
    );
    return { ok: false, response: unauthorized() };
  }

  if (token !== expectedToken) {
    return { ok: false, response: unauthorized() };
  }

  return { ok: true };
}

function parseRange(rangeHeader, fileSize) {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return null;
  }

  const ranges = rangeHeader.substring(6).split(",");
  if (ranges.length !== 1) return null;

  const range = ranges[0].trim();
  const parts = range.split("-");

  if (parts.length !== 2) return null;

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

export async function GET(request, context) {

  const params = await context.params;
  const sessionToken = params?.sessionToken || "";

  console.log("========== RECORDING DEBUG START ==========");
  console.log("params:", params);
  console.log("sessionToken:", sessionToken);
  console.log("request.url:", request.url);
  console.log("===========================================");

  const authResult = validateAuth(request);
  if (!authResult.ok) return authResult.response;

  if (!sessionToken) {
    console.log("[recording] sessionToken missing");
    return withCors(
      NextResponse.json(
        { error: "Session token required" },
        { status: 400 }
      )
    );
  }

  if (!DB_READY || !pool) {
    console.log("[recording] DB not ready");
    return withCors(
      NextResponse.json({ error: "DB not available" }, { status: 503 })
    );
  }

  try {
    console.log("[recording] GET", { sessionToken });

    const { rows } = await pool.query(
      `SELECT recording_path, recording_size_bytes, recording_format, recording_duration_seconds, recording_data
       FROM interview_sessions
       WHERE session_token = $1`,
      [sessionToken]
    );

    console.log("[recording] DB rows count:", rows.length);

    if (!rows.length || (!rows[0].recording_path && !rows[0].recording_data)) {
      console.log("[recording] recording not found in DB");
      return withCors(
        NextResponse.json(
          { error: "Recording not found" },
          { status: 404 }
        )
      );
    }

    const {
      recording_path,
      recording_size_bytes,
      recording_format,
      recording_duration_seconds,
      recording_data,
    } = rows[0];

    console.log("[recording] DB row", {
      recording_path,
      size: recording_size_bytes,
      format: recording_format,
    });

    // DB binary recording
    if (recording_data) {
      console.log("[recording] streaming from DB");

      const headers = new Headers();
      headers.set(
        "Content-Type",
        recording_format === "mp4" ? "video/mp4" : "video/webm"
      );
      headers.set("Accept-Ranges", "bytes");
      headers.set("Content-Length", recording_data.length.toString());

      applyCors(headers);

      return new Response(recording_data, { headers });
    }

    const recordingsDir =
      process.env.RECORDINGS_DIR || "/app/next-app/recordings";

    console.log("[recording] recordingsDir:", recordingsDir);

    const recordingsRoot = path.resolve(recordingsDir);

    const safeResolve = (relativePath) => {
      if (!relativePath) return null;

      const resolved = path.resolve(recordingsRoot, relativePath);

      if (
        !resolved.startsWith(recordingsRoot + path.sep) &&
        resolved !== recordingsRoot
      )
        return null;

      return resolved;
    };

    const candidates = [
      `${sessionToken}.mp4`,
      `${sessionToken}.webm`,
      recording_path,
    ];

    console.log("[recording] candidates:", candidates);

    let fullPath = null;

    for (const candidate of candidates) {
      const resolved = safeResolve(candidate);

      console.log("[recording] checking:", resolved);

      if (resolved && fs.existsSync(resolved)) {
        fullPath = resolved;
        break;
      }
    }

    if (!fullPath) {
      console.log("[recording] file not found on disk");
      return withCors(
        NextResponse.json(
          { error: "Recording not available or not ready yet" },
          { status: 404 }
        )
      );
    }

    console.log("[recording] file found:", fullPath);

    const stat = fs.statSync(fullPath);
    const fileSize = stat.size;

    const rangeHeader = request.headers.get("range");

    const headers = new Headers();
    headers.set(
      "Content-Type",
      fullPath.endsWith(".mp4") ? "video/mp4" : "video/webm"
    );
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Length", fileSize.toString());

    applyCors(headers);

    if (rangeHeader) {
      const range = parseRange(rangeHeader, fileSize);

      if (range) {
        const { start, end } = range;

        headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);

        const stream = fs.createReadStream(fullPath, { start, end });

        return new Response(stream, {
          status: 206,
          headers,
        });
      }
    }

    headers.set("Content-Range", `bytes 0-${fileSize - 1}/${fileSize}`);

    const stream = fs.createReadStream(fullPath);

    return new Response(stream, { headers });

  } catch (e) {
    console.error("Error serving recording:", e);
    return withCors(
      NextResponse.json({ error: e.message }, { status: 500 })
    );
  }
}

export async function HEAD(request, context) {
  return GET(request, context);
}