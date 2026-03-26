import VapiSDK from "@vapi-ai/web";

const Vapi = VapiSDK.default || VapiSDK;

const PUBLIC_KEY   = "86f389eb-e146-4c6b-815f-c938e49865d1";
const ASSISTANT_ID = "ea94243f-bbf4-45c2-90c3-22d89e017aed";
const API_BASE     = import.meta.env.VITE_API_BASE || "";
const IS_DEV       = import.meta.env.DEV;


// ── URL PARAMS ────────────────────────────────────────────────
function getParam(key) {
  return new URLSearchParams(window.location.search).get(key) || null;
}

// ── FETCH SESSION METADATA ────────────────────────────────────
async function fetchSessionMetadata(sessionToken) {
  try {
    const res = await fetch(`${API_BASE}/api/session-info/${encodeURIComponent(sessionToken)}`);
    if (!res.ok) {
      console.warn("Session fetch failed:", res.status);
      return null;
    }
    const data = await res.json();
    if (!data.success) {
      console.warn("Session error:", data.error);
      return null;
    }
    return data;
  } catch (err) {
    console.error("Session fetch error:", err);
    return null;
  }
}

// ── INITIALIZE CONFIG ─────────────────────────────────────────
async function initializeConfig() {
  const sessionToken = getParam("session");
  let variableValues = {
    candidateName:  getParam("candidateName")  || "Candidate",
    email:          getParam("email")          || "",
    resume:         getParam("resume")         || "",
    jobDescription: getParam("jobDescription") || "",
    jobRole:        getParam("jobRole")        || "",
    agencyId:       getParam("agencyId")       || "",
    userId:         getParam("userId")         || "",
    candidateId:    getParam("candidateId")    || "",
    jobId:          getParam("jobId")          || "",
  };

  // If session token provided, fetch metadata from backend
  if (sessionToken) {
    const sessionData = await fetchSessionMetadata(sessionToken);
    if (sessionData) {
      variableValues = {
        candidateName:  sessionData.name || variableValues.candidateName,
        email:          sessionData.email || variableValues.email,
        resume:         sessionData.resume_text || variableValues.resume,
        jobDescription: sessionData.job_description || variableValues.jobDescription,
        jobRole:        sessionData.job_title || variableValues.jobRole,
        agencyId:       sessionData.agency_id || variableValues.agencyId,
        candidateId:    sessionData.candidate_id || variableValues.candidateId,
        userId:         variableValues.userId,
        jobId:          variableValues.jobId,
      };
      
      // Add optional interview_questions if available
      if (sessionData.interview_questions) {
        variableValues.interviewQuestions = sessionData.interview_questions;
      }
      if (sessionData.resumed && sessionData.lastTranscript) {
        variableValues.resuming = "true";
        variableValues.previousContext = sessionData.lastTranscript.slice(-2000);
      }
    }
  }

  return variableValues;
}

// ── DOM REFS ──────────────────────────────────────────────────
const statusOverlay   = document.getElementById("statusOverlay");
const statusText      = document.getElementById("statusText");
const permError       = document.getElementById("permError");
const endedScreen     = document.getElementById("endedScreen");
const endedName       = document.getElementById("endedName");
const callInfo        = document.getElementById("callInfo");
const timerEl         = document.getElementById("timer");
const candidateVideo  = document.getElementById("candidateVideo");
const camOffOverlay   = document.getElementById("camOffOverlay");
const candidateLabel  = document.getElementById("candidateLabel");
const candidateAvatar = document.getElementById("candidateAvatar");
const candidateTile   = document.getElementById("candidateTile");
const agentTile       = document.getElementById("agentTile");
const transcriptFeed  = document.getElementById("transcriptFeed");
const liveIndicator   = document.getElementById("liveIndicator");
const micBtn          = document.getElementById("micBtn");
const camBtn          = document.getElementById("camBtn");
const endBtn          = document.getElementById("endBtn");

// ── STATE ─────────────────────────────────────────────────────
let localStream        = null;
let isMuted            = false;
let isCamOff           = false;
let callStartTime      = null;
let timerInterval      = null;
let vapi               = null;
let variableValues     = null;
let camWarningInterval = null;
let heartbeatInterval  = null;
let mediaRecorder      = null;
let recordingChunks    = [];
let vapiRecordingUrl   = null;

let audioCtx = null;
let vapiAudioCaptured = false;
const tappedElements = new WeakSet();

// ── DEBUG OVERLAY (dev only) ───────────────────────────────────
let debugEl = null;
if (IS_DEV) {
  debugEl = document.createElement("div");
  debugEl.style.cssText = "position:fixed;bottom:12px;left:12px;background:rgba(0,0,0,0.75);color:#4ade80;font:12px monospace;padding:10px 14px;border-radius:8px;z-index:9999;line-height:1.8;pointer-events:none";
  document.body.appendChild(debugEl);
}

function updateDebug() {
  if (!IS_DEV || !debugEl) return;
  const micActive   = localStream?.getAudioTracks()?.[0]?.enabled ? "ACTIVE" : "SILENT";
  const vapiStatus  = vapiAudioCaptured ? "CAPTURED" : "NOT FOUND";
  const recStatus   = mediaRecorder?.state === "recording" ? "RUNNING" : "STOPPED";
  const sizeKB      = recordingChunks.reduce((a, c) => a + c.size, 0) / 1024;
  debugEl.innerHTML =
    `🎤 Candidate mic: <b>${micActive}</b><br>` +
    `🤖 Vapi AI audio: <b style="color:${vapiAudioCaptured?'#4ade80':'#f87171'}">${vapiStatus}</b><br>` +
    `⏺️ Recording: <b>${recStatus}</b><br>` +
    `💾 Size est: <b>${sizeKB.toFixed(1)} KB</b>`;
}

// ── RECORDING — Web Audio mixer (mic + Vapi AI audio + video) ────────────
async function startRecording() {
  if (!localStream || !window.MediaRecorder) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: "interactive" });
    window._audioCtx = audioCtx;
    if (audioCtx.state === "suspended") await audioCtx.resume();
    console.log("▶️ AudioContext state:", audioCtx.state);
    const dest = audioCtx.createMediaStreamDestination();

    // Candidate mic → mixer
    audioCtx.createMediaStreamSource(localStream).connect(dest);

    // Vapi <audio> → mixer with retry loop
    let vapiAudio = null;
    for (let i = 0; i < 10; i++) {
      vapiAudio = document.querySelector("audio[autoplay]") || document.querySelector("audio");
      if (vapiAudio) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (vapiAudio) {
      vapiAudio.muted  = false;
      vapiAudio.volume = 1.0;

      if (!tappedElements.has(vapiAudio)) {
        tappedElements.add(vapiAudio);
        try {
          const vapiStream = vapiAudio.srcObject instanceof MediaStream
            ? vapiAudio.srcObject
            : null;

          if (vapiStream) {
            // Tap stream directly — audio element plays to speakers untouched
            const vapiSource = audioCtx.createMediaStreamSource(vapiStream);
            vapiSource.connect(dest); // recorder only, NOT audioCtx.destination
            console.log("🎤 Vapi stream tapped via srcObject:", {
              tracks: vapiStream.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled })),
            });
          } else {
            console.warn("⚠️ vapiAudio.srcObject is not a MediaStream — audio capture skipped");
          }
        } catch (e) {
          console.warn("⚠️ Vapi audio tap failed:", e.message);
        }
      }

      vapiAudioCaptured = true;
    } else {
      vapiAudioCaptured = false;
      console.warn("⚠️ Vapi audio element not found after retries");
    }

    // Video track + mixed audio → MediaRecorder
    const videoTrack = localStream.getVideoTracks()[0];
    const mixed = new MediaStream([
      ...dest.stream.getAudioTracks(),
      ...(videoTrack ? [videoTrack] : []),
    ]);

    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      .find(m => MediaRecorder.isTypeSupported(m)) || "";
    mediaRecorder = new MediaRecorder(mixed, mimeType ? { mimeType } : {});
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) { recordingChunks.push(e.data); updateDebug(); } };
    mediaRecorder.start(5000);
    updateDebug();
    console.log("🔴 Recording started — mimeType:", mimeType || "default");
  } catch (e) {
    console.error("❌ Recording setup failed:", e.message);
  }
}

async function stopAndUpload() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  return new Promise(resolve => {
    mediaRecorder.onstop = async () => {
      if (audioCtx) { audioCtx.close(); audioCtx = null; }
      if (!recordingChunks.length) { resolve(); return; }
      updateDebug();
      const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || "video/webm" });
      recordingChunks = [];
      console.log("💾 Recording blob:", (blob.size / 1024 / 1024).toFixed(2), "MB");
      try {
        const fd = new FormData();
        fd.append("recording", blob, "interview.webm");
        fd.append("sessionToken", getParam("session") || "");
        const res = await fetch(`${API_BASE}/api/save-recording`, { method: "POST", body: fd });
        const data = await res.json();
        console.log("✅ Upload:", data.file);
      } catch (e) {
        console.error("❌ Upload failed:", e.message);
      }
      resolve();
    };
    mediaRecorder.stop();
  });
}


// ── CAMERA + MIC SETUP ────────────────────────────────────────
async function setupCamera() {
  statusText.textContent = "Requesting camera & microphone...";
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    candidateVideo.srcObject = localStream;
    candidateVideo.style.display = "block";
    camOffOverlay.style.display  = "none";
    return true;
  } catch (err) {
    console.warn("Camera failed:", err.name);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      return true;
    } catch (audioErr) {
      console.error("Mic also failed:", audioErr.name);
      showPermError();
      return false;
    }
  }
}

function showPermError() {
  statusOverlay.style.display = "none";
  permError.style.display     = "flex";
}

// ── TIMER ─────────────────────────────────────────────────────
function startTimer() {
  callStartTime = Date.now();
  timerInterval = setInterval(() => {
    const s  = Math.floor((Date.now() - callStartTime) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    timerEl.textContent = `${mm}:${ss}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
}

// ── TRANSCRIPT ────────────────────────────────────────────────
let lastRole  = null;
let lastEntry = null;

function addTranscript(role, text) {
  if (!text.trim()) return;
  if (role === lastRole && lastEntry) {
    lastEntry.querySelector(".text").textContent += " " + text.trim();
  } else {
    const div = document.createElement("div");
    div.className = `transcript-entry ${role}`;
    div.innerHTML = `
      <span class="speaker">${role === "agent" ? "AI Interviewer" : variableValues.candidateName}</span>
      <span class="text">${text.trim()}</span>`;
    transcriptFeed.appendChild(div);
    lastEntry = div;
    lastRole  = role;
  }
  transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
}

function setLiveIndicator(text) {
  liveIndicator.innerHTML = text;
}

// ── SPEAKING INDICATORS ───────────────────────────────────────
function setAgentSpeaking(speaking) {
  agentTile.classList.toggle("speaking", speaking);
  document.getElementById("agentMicIcon").textContent = speaking ? "🔊" : "🎙️";
}

function setCandidateSpeaking(speaking) {
  candidateTile.classList.toggle("speaking", speaking);
  document.getElementById("candidateMicIcon").textContent = speaking ? "🔊" : "🎙️";
}

// ── CAMERA WARNING (Vapi voice) ──────────────────────────────────
let camOffSince = null;

function warnCameraOff(secondsOff) {
  if (!vapi || !isCamOff) return;
  const msg = secondsOff >= 60
    ? "The candidate camera has been off for over a minute. End the interview now and inform the candidate their session is terminated due to camera violation."
    : "The candidate camera is off. Stop and firmly ask them to turn it back on before continuing. This is required.";
  vapi.send({ type: "add-message", message: { role: "system", content: msg } });
}

function startCamWarning() {
  camOffSince = Date.now();
  warnCameraOff(0);
  camWarningInterval = setInterval(() => {
    if (!isCamOff) { stopCamWarning(); return; }
    const secondsOff = Math.floor((Date.now() - camOffSince) / 1000);
    warnCameraOff(secondsOff);
    if (secondsOff >= 60) {
      console.warn('Camera off 60s - terminating');
      setTimeout(() => { stopCamWarning(); if (vapi) vapi.stop(); endCall(); }, 3000);
    }
  }, 30000);
}

function stopCamWarning() {
  clearInterval(camWarningInterval);
  camWarningInterval = null;
  camOffSince = null;
}



// ── STATUS ────────────────────────────────────────────────────
function setStatus(msg) { statusText.textContent = msg; }
function hideOverlay()  { statusOverlay.style.display = "none"; }

// ── CONTROLS ──────────────────────────────────────────────────
micBtn.addEventListener("click", async () => {
  if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume();
  if (!vapi) return;
  isMuted = !isMuted;
  vapi.setMuted(isMuted);
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  micBtn.textContent = isMuted ? "🔇" : "🎙️";
  micBtn.classList.toggle("off", isMuted);
  micBtn.classList.toggle("active", !isMuted);
});

camBtn.addEventListener("click", () => {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  candidateVideo.style.display = isCamOff ? "none" : "block";
  camOffOverlay.style.display  = isCamOff ? "flex"  : "none";
  camBtn.textContent = isCamOff ? "🚫" : "📷";
  camBtn.classList.toggle("off", isCamOff);
  camBtn.classList.toggle("active", !isCamOff);
  if (isCamOff) startCamWarning();
  else stopCamWarning();
});

endBtn.addEventListener("click", () => {
  if (vapi) vapi.stop();
  endCall();
});

async function endCall() {
  stopTimer();
  stopCamWarning();
  await stopAndUpload();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  endedName.textContent     = variableValues?.candidateName || "Candidate";
  endedScreen.style.display = "flex";
}

// ── VAPI ──────────────────────────────────────────────────────
async function startInterview() {
  // Initialize config (fetch session metadata if available)
  setStatus("Loading interview details...");
  variableValues = await initializeConfig();

  // Update UI with candidate name
  const initials = variableValues.candidateName.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  candidateAvatar.textContent = initials || "?";
  candidateLabel.textContent  = variableValues.candidateName;

  // Setup camera
  const camOk = await setupCamera();
  if (!camOk) return;

  // Debug: verify metadata loaded
  console.log("📋 Interview config:", {
    name: variableValues.candidateName,
    role: variableValues.jobRole,
    resumeChars: variableValues.resume?.length || 0,
    jdChars: variableValues.jobDescription?.length || 0,
  });

  setStatus("Connecting to AI interviewer...");
  vapi = new Vapi(PUBLIC_KEY);

  vapi.on("call-start", async () => {
    hideOverlay();
    callInfo.textContent = `Interview · ${variableValues.candidateName}`;
    startTimer();
    setLiveIndicator("Interview started — AI is speaking...");
    if (audioCtx && audioCtx.state === "suspended") {
      await audioCtx.resume();
      console.log("▶️ AudioContext resumed:", audioCtx.state);
    }
    requestFullscreen();
    startRecording();
    updateDebug();
    const sessionToken = getParam("session");
    heartbeatInterval = setInterval(() => {
      const transcript = Array.from(document.querySelectorAll(".transcript-entry .text"))
        .map(el => el.textContent).join("\n");
      fetch(`${API_BASE}/api/session-heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_token: sessionToken, transcript_so_far: transcript }),
      }).catch(() => {});
    }, 30000);
  });

  vapi.on("call-end", (callData) => {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    // Capture Vapi's server-side recording URL if available
    vapiRecordingUrl = callData?.recordingUrl || callData?.artifact?.recordingUrl || null;
    if (vapiRecordingUrl) {
      console.log("🎥 Vapi recording URL:", vapiRecordingUrl);
      fetch(`${API_BASE}/api/save-recording-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingUrl: vapiRecordingUrl, sessionToken: getParam("session") || "" }),
      }).catch(() => {});
    }
    endCall();
  });

  vapi.on("speech-start", () => {
    setAgentSpeaking(true);
    setCandidateSpeaking(false);
    setLiveIndicator(`<span>AI Interviewer</span> is speaking...`);
  });

  vapi.on("speech-end", () => {
    setAgentSpeaking(false);
    setLiveIndicator("Your turn to speak...");
  });

  vapi.on("message", (msg) => {
    if (msg.type === "transcript") {
      const role = msg.role === "assistant" ? "agent" : "user";
      if (msg.transcriptType === "partial") {
        setLiveIndicator(`<span>${role === "agent" ? "AI" : variableValues.candidateName}</span>: ${msg.transcript}`);
        if (role === "user") setCandidateSpeaking(true);
      } else if (msg.transcriptType === "final") {
        addTranscript(role, msg.transcript);
        setLiveIndicator(role === "agent" ? "Your turn to speak..." : "AI is processing...");
        if (role === "user") setCandidateSpeaking(false);
      }
    }
  });

  vapi.on("error", (err) => {
    console.error("Vapi error:", err);
    setStatus("Connection error: " + (err.message || JSON.stringify(err)));
    statusOverlay.style.display = "flex";
  });

  try {
    await vapi.start(ASSISTANT_ID, {
      recordingEnabled: true,
      firstMessage: `Hello ${variableValues.candidateName}! I'm your AI interviewer from Pontis. I'll be conducting your interview for the ${variableValues.jobRole || "position"} today. Are you ready to begin?`,
      maxDurationSeconds: 1800,
      silenceTimeoutSeconds: 30,
      variableValues: {
        candidateName:  variableValues.candidateName,
        jobRole:        variableValues.jobRole,
        resume:         variableValues.resume,
        jobDescription: variableValues.jobDescription,
        email:          variableValues.email,
        agencyId:       variableValues.agencyId,
        candidateId:    variableValues.candidateId,
        userId:         variableValues.userId,
        jobId:          variableValues.jobId,
        session:        getParam("session") || "",
        resuming:        variableValues.resuming        || "false",
        previousContext: variableValues.previousContext || "",
      },
    });
  } catch (err) {
    console.error("Start failed:", err);
    setStatus("Failed to start: " + (err.message || JSON.stringify(err)));
  }
}

// startInterview() is called by consent screen button in index.html

// ── TAB SWITCH PROCTORING ─────────────────────────────────────
let tabSwitchCount = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || !vapi) return;
  tabSwitchCount++;
  console.warn('Tab switch #' + tabSwitchCount);
  const msg = tabSwitchCount === 1
    ? 'The candidate just switched tabs. Stop and warn them tab switching is not allowed and is being recorded.'
    : 'The candidate has switched tabs ' + tabSwitchCount + ' times. Firmly warn them repeated switching may result in disqualification.';
  vapi.send({ type: 'add-message', message: { role: 'system', content: msg } });
  fetch(API_BASE + '/api/session-heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_token: getParam('session') || '', transcript_so_far: '[PROCTORING] Tab switch #' + tabSwitchCount + ' at ' + new Date().toISOString() }),
  }).catch(() => {});
});

// ── FULLSCREEN ENFORCEMENT ────────────────────────────────────
function requestFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen();
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
}

document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement || !vapi) return;
  console.warn('Fullscreen exited');
  vapi.send({ type: 'add-message', message: { role: 'system', content: 'The candidate has exited fullscreen mode. Stop and instruct them to return to fullscreen immediately to continue the interview.' } });
});

// ── CONSENT BUTTON ─────────────────────────────────────────
document.getElementById('consentBtn').addEventListener('click', () => {
  document.getElementById('consentScreen').style.display = 'none';
  startInterview();
});
