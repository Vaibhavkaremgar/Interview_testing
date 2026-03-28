import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { pool, DB_READY } from "@/lib/db.js";
import { corsHeaders, withCors } from "@/lib/cors.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

async function convertToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", inputPath,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-y",
      outputPath
    ]);

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on("error", (err) => {
      reject(err);
    });
  });
}

async function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      filePath
    ]);

    let output = "";
    ffprobe.stdout.on("data", (data) => {
      output += data.toString();
    });

    ffprobe.on("close", (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(output);
          const duration = parseFloat(data.format.duration);
          resolve(Math.round(duration));
        } catch (e) {
          resolve(0);
        }
      } else {
        resolve(0);
      }
    });

    ffprobe.on("error", (err) => {
      resolve(0);
    });
  });
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

  const webmFilename = `${sessionToken}.webm`;
  const mp4Filename = `${sessionToken}.mp4`;
  const webmPath = path.join(recordingsDir, webmFilename);
  const mp4Path = path.join(recordingsDir, mp4Filename);
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
    fs.appendFileSync(webmPath, buf);
    fs.unlinkSync(partPath);
    appendedBytes += buf.length;
    appendedChunks += 1;
    state.nextIndex += 1;
    saveState(state);
  }

  let converted = false;
  let finalFormat = null;

  // If this is the final chunk, convert WebM to MP4 and update database
  if (isFinal && fs.existsSync(webmPath)) {
    let converted = false;
    let finalPath = webmPath;
    let finalFormat = 'webm';
    let duration = 0;

    try {
      console.log(`Attempting to convert ${webmPath} to ${mp4Path}`);
      await convertToMp4(webmPath, mp4Path);
      
      if (fs.existsSync(mp4Path)) {
        const stats = fs.statSync(mp4Path);
        duration = await getVideoDuration(mp4Path);
        finalPath = mp4Path;
        finalFormat = 'mp4';
        converted = true;
        console.log(`Converted recording: ${stats.size} bytes, ${duration}s duration`);
        
        // Clean up WebM file
        fs.unlinkSync(webmPath);
      }
    } catch (e) {
      console.warn("FFmpeg conversion failed, keeping WebM format:", e.message);
      // Keep WebM format if conversion fails
      const stats = fs.statSync(webmPath);
      duration = await getVideoDuration(webmPath);
      finalFormat = 'webm';
      converted = true;
    }
    
    if (converted) {
      if (DB_READY && pool) {
        await pool.query(
          `UPDATE interview_sessions
           SET recording_path = $1,
               recording_size_bytes = $2,
               recording_duration_seconds = $3,
               recording_format = $4,
               recording_created_at = NOW()
           WHERE session_token = $5`,
          [`recordings/${path.basename(finalPath)}`, fs.statSync(finalPath).size, duration, finalFormat, sessionToken]
        );
      }
    }
    
    // Clean up parts directory
    if (fs.existsSync(partsDir)) {
      fs.rmSync(partsDir, { recursive: true, force: true });
    }
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  }

  return withCors(NextResponse.json({
    success: true,
    appendedChunks,
    appendedBytes,
    nextIndex: state.nextIndex,
    final: isFinal,
    converted: converted || false,
    format: finalFormat || null
  }));
}
