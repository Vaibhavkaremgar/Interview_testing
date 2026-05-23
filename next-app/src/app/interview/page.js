"use client";
import { useEffect } from "react";
import "./interview.css";

export default function InterviewPage() {
  useEffect(() => {
    import("@vapi-ai/web").then((mod) => {
      const VapiSDK = mod.default || mod;
      const Vapi = VapiSDK.default || VapiSDK;

      const PUBLIC_KEY   = "515511f1-b187-4957-86c2-fcddc3ceca9f";
      const ASSISTANT_ID = "88804242-9889-441f-a384-ed4ec7dcaa07";
      const API_BASE     = "";

      function getParam(key) {
        return new URLSearchParams(window.location.search).get(key) || null;
      }

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

      // Hard stop: a session token is required to enter the interview.
      const sessionTokenParam = getParam("session");
      if (!sessionTokenParam) {
        showExpired("Missing session token. Please open the interview from your unique link.");
        const consentBtn = document.getElementById("consentBtn");
        if (consentBtn) {
          consentBtn.disabled = true;
          consentBtn.textContent = "Invalid link";
        }
        const consentScreen = document.getElementById("consentScreen");
        if (consentScreen) consentScreen.style.display = "none";
        return;
      }

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
      let vapiRecordingUrl   = null;
      let proctoringTerminated = false;
      let tabSwitchCount     = 0;
      let interviewStarting  = false;
      let audioCtx           = null;
      let vapiAudioCaptured  = false;
      let camOffSince        = null;
      let lastRole           = null;
      let lastEntry          = null;
      let gracefulEndTimer   = null;
      let callEnded          = false;
      let completionPromptShown = false;
      const tappedElements   = new WeakSet();
      const PROCTORING_BOOT_DELAY_MS = 3000;
      const GRACEFUL_END_DELAY_MS = 10000;
      const proctoringConfig = {
        enableFacePresence: true,
        enableHeadPose: true,
        enableGaze: true,
        warnCooldownMs: 30000,
        faceMissingWarnSec: 5,
        headAwayWarnSec: 4,
        gazeAwayWarnSec: 6,
        yawThreshold: 0.35,
        pitchThreshold: 0.35,
        gazeThreshold: 0.35,
        detectionIntervalMs: 800,
      };
      let faceDetector = null;
      let faceDetectInterval = null;
      let faceDetectBusy = false;
      let faceMissingSince = null;
      let headAwaySince = null;
      let gazeAwaySince = null;
      let awaitingClosingAck = false;
      let gracefulExitScheduled = false;
      const lastProctoringWarnAt = { face: 0, head: 0, gaze: 0 };
      window.__mediaRecorderRunning = window.__mediaRecorderRunning || false;
      let finalized = false;
      const uploadQueue = [];
      let uploading = false;
      let inFlightUploads = 0;

      function setStatus(msg) { if (statusText) statusText.textContent = msg; }
      function hideOverlay()  { if (statusOverlay) statusOverlay.style.display = "none"; }
      function showExpired(msg) {
        if (statusOverlay) statusOverlay.style.display = "flex";
        setStatus(msg || "Interview link is no longer available.");
      }
      function clearGracefulEndTimer() {
        if (gracefulEndTimer) {
          clearTimeout(gracefulEndTimer);
          gracefulEndTimer = null;
        }
      }
      function showCompletionPrompt() {
        completionPromptShown = true;
        if (callInfo) callInfo.textContent = "Interview complete";
        setLiveIndicator("Interview complete. Please click the Leave button if the call does not end automatically.");
      }
      function showWrappingUpMessage() {
        if (callInfo) callInfo.textContent = "Interview wrapping up";
        setLiveIndicator("Interview complete. The call will end shortly.");
      }
      function stopCallAfterGracePeriod() {
        if (!vapi || callEnded) return;
        try { vapi.stop(); } catch (_) {}
        setTimeout(() => {
          if (!callEnded) showCompletionPrompt();
        }, 3000);
      }
      function scheduleGracefulEnd() {
        if (callEnded) return;
        gracefulExitScheduled = true;
        showWrappingUpMessage();
        clearGracefulEndTimer();
        gracefulEndTimer = setTimeout(() => {
          stopCallAfterGracePeriod();
        }, GRACEFUL_END_DELAY_MS);
      }

      window.addEventListener("beforeunload", () => {
        const sessionToken = getParam("session") || "";
        if (sessionToken) {
          const payload = JSON.stringify({ session_token: sessionToken });
          const url = `${API_BASE}/api/session-disconnect`;
          if (navigator.sendBeacon) {
            const blob = new Blob([payload], { type: "application/json" });
            navigator.sendBeacon(url, blob);
          } else {
            fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true }).catch(() => {});
          }
        }
      });

      async function fetchSessionMetadata(sessionToken) {
        try {
          const res = await fetch(`${API_BASE}/api/session-info/${encodeURIComponent(sessionToken)}`);
          if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            setStatus(payload.error || "Interview link is no longer available.");
            return null;
          }
          const data = await res.json();
          if (!data.success) { setStatus(data.error || "Interview error occurred."); return null; }
          return data;
        } catch (err) {
          setStatus("Something went wrong while loading the interview.");
          return null;
        }
      }

      async function initializeConfig() {
        const sessionToken = getParam("session");
        let vv = {
          candidateName: getParam("candidateName") || "Candidate",
          email: getParam("email") || "",
          resume: getParam("resume") || "",
          jobDescription: getParam("jobDescription") || "",
          jobRole: getParam("jobRole") || "",
          agencyId: getParam("agencyId") || "",
          userId: getParam("userId") || "",
          candidateId: getParam("candidateId") || "",
          jobId: getParam("jobId") || "",
          async_questions: [],
          skills: "",
          agencyName: "",
          expired:false,
          interview_questions: [],
        };
        if (sessionToken) {
          const sd = await fetchSessionMetadata(sessionToken);
          if (!sd) return null;
          const incomingQuestions = sd.interview_questions || sd.async_questions || [];
          vv = {
            candidateName:  sd.name            || vv.candidateName,
            email:          sd.email           || vv.email,
            resume:         sd.resume_text     || vv.resume,
            jobDescription: sd.job_description || vv.jobDescription,
            jobRole:        sd.job_title       || vv.jobRole,
            skills:         sd.skills          || "",
            agencyName:     sd.agency_name     || "",
            agencyId:       sd.agency_id       || vv.agencyId,
            candidateId:    sd.candidate_id    || vv.candidateId,
            userId:         sd.user_id         || vv.userId,
            jobId:          sd.job_id          || vv.jobId,
            async_questions: incomingQuestions,
            interview_questions: incomingQuestions,
            expired: false,
          };
          if (sd.resumed && sd.lastTranscript) {
            vv.resuming = "true";
            vv.previousContext = sd.lastTranscript.slice(-2000);
          }
        }
        return vv;
      }

      function addTranscript(role, text) {
        if (!text.trim()) return;
        const lower = text.toLowerCase();
        // Detect agent closing statements and begin the graceful end countdown.
        if (role === "agent" && (
          lower.includes("recruiter will get in touch") ||
          lower.includes("we will get in touch") ||
          lower.includes("we'll get in touch") ||
          lower.includes("thanks for your time") ||
          lower.includes("thank you for your time") ||
          lower.includes("thank you") ||
          lower.includes("this concludes the interview") ||
          lower.includes("that's all from my side") ||
          lower.includes("that concludes") ||
          lower.includes("we have reached the end")
        )) {
          awaitingClosingAck = true;
          scheduleGracefulEnd();
        }
        // If the candidate responds after the closing line, give them a fresh 10-second window.
        if (role === "user" && awaitingClosingAck) {
          scheduleGracefulEnd();
        }
        // Keep showing the closing prompt if the user responds while the call is wrapping up.
        if (role === "user" && awaitingClosingAck && !completionPromptShown && (
          lower.includes("thank you") ||
          lower.includes("thanks") ||
          lower.includes("bye") ||
          lower.includes("goodbye")
        )) {
          showCompletionPrompt();
        }
        if (role === lastRole && lastEntry) {
          lastEntry.querySelector(".text").textContent += " " + text.trim();
        } else {
          const div = document.createElement("div");
          div.className = `transcript-entry ${role}`;
          div.innerHTML = `<span class="speaker">${role === "agent" ? "AI Interviewer" : variableValues.candidateName}</span><span class="text">${text.trim()}</span>`;
          transcriptFeed.appendChild(div);
          lastEntry = div;
          lastRole  = role;
        }
        transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
      }

      function setLiveIndicator(text) { if (liveIndicator) liveIndicator.innerHTML = text; }
      function setAgentSpeaking(s) { agentTile.classList.toggle("speaking", s); }
      function setCandidateSpeaking(s) { candidateTile.classList.toggle("speaking", s); }

      function warnCameraOff(secondsOff) {
        if (!vapi || !isCamOff) return;
        const msg = secondsOff >= 45
          ? "The candidate camera has been off for over 45 seconds. End the interview now and inform the candidate their session is terminated due to camera violation."
          : "The candidate camera is off. Stop and firmly ask them to turn it back on before continuing. This is required.";
        vapi.send({ type: "add-message", message: { role: "system", content: msg } });
      }

      function stopCamWarning() { clearInterval(camWarningInterval); camWarningInterval = null; camOffSince = null; }

      function startCamWarning() {
        camOffSince = Date.now();
        warnCameraOff(0);
        camWarningInterval = setInterval(() => {
          if (!isCamOff) { stopCamWarning(); return; }
          const secondsOff = Math.floor((Date.now() - camOffSince) / 1000);
          warnCameraOff(secondsOff);
          if (secondsOff >= 45) terminateInterview("Camera was turned off for too long.");
        }, 15000);
      }

      function terminateInterview(reason) {
        if (proctoringTerminated) return;
        proctoringTerminated = true;
        if (vapi) { try { vapi.send({ type: "add-message", message: { role: "system", content: `Interview terminated: ${reason}` } }); } catch (_) {} vapi.stop(); }
        setStatus(`Interview terminated: ${reason}`);
        endCall();
      }

      function logProctoringEvent(message) {
        fetch(`${API_BASE}/api/session-heartbeat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_token: getParam("session") || "",
            transcript_so_far: `[PROCTORING] ${message} at ${new Date().toISOString()}`,
          }),
        }).catch(() => {});
      }

      function sendProctoringWarning(type, message) {
        if (!vapi) return;
        const now = Date.now();
        if (now - (lastProctoringWarnAt[type] || 0) < proctoringConfig.warnCooldownMs) return;
        lastProctoringWarnAt[type] = now;
        vapi.send({ type: "add-message", message: { role: "system", content: message } });
        logProctoringEvent(message);
      }

      function pointFromKeypoints(keypoints, idx) {
        if (!keypoints || !keypoints[idx]) return null;
        const p = keypoints[idx];
        if (Array.isArray(p)) return { x: p[0], y: p[1], z: p[2] || 0 };
        if (typeof p.x === "number" && typeof p.y === "number") return { x: p.x, y: p.y, z: p.z || 0 };
        return null;
      }

      function avgPoints(points) {
        if (!points.length) return null;
        const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + (p.z || 0) }), { x: 0, y: 0, z: 0 });
        return { x: sum.x / points.length, y: sum.y / points.length, z: sum.z / points.length };
      }

      function distance(a, b) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy) || 1;
      }

      function flushFinalChunk() {
        try {
          if (!mediaRecorder) return;
          if (mediaRecorder.state === "recording") {
            mediaRecorder.requestData();
            mediaRecorder.stop();
          }
        } catch (e) {
          console.error("final flush failed", e);
        }
      }

      function waitForUploadQueueToDrain(timeoutMs = 30000) {
        const start = Date.now();
        return new Promise(resolve => {
          const check = () => {
            if (!uploading && uploadQueue.length === 0 && inFlightUploads === 0) {
              resolve();
              return;
            }
            if (Date.now() - start >= timeoutMs) {
              resolve();
              return;
            }
            setTimeout(check, 100);
          };
          check();
        });
      }

      function sendFinalizeSignal() {
        if (finalized) return;
        finalized = true;
      }

      async function uploadChunk(blob, index, retry = 3) {
        const sessionToken = getParam("session") || localStorage.getItem("sessionToken") || "";
        if (!sessionToken) return;
        try { localStorage.setItem("sessionToken", sessionToken); } catch (_) {}
        const fd = new FormData();
        fd.append("chunk", blob, "chunk.webm");
        fd.append("sessionToken", sessionToken);
        fd.append("chunkIndex", String(index));
        uploadQueue.push({ fd, retry });
        processUploadQueue();
      }

      async function sendFinalRecordingMarker() {
        const sessionToken = getParam("session") || localStorage.getItem("sessionToken") || "";
        if (sessionToken) {
          try { localStorage.setItem("sessionToken", sessionToken); } catch (_) {}
          const fd = new FormData();
          fd.append("sessionToken", sessionToken);
          fd.append("final", "1");
          await fetch(`${API_BASE}/api/recording-chunk`, { method: "POST", body: fd, keepalive: true })
            .catch(err => console.error("Finalize upload failed:", err.message));
        }
        sendFinalizeSignal();
      }

      async function processUploadQueue() {
        if (uploading) return;
        uploading = true;
        try {
          while (uploadQueue.length) {
            const { fd, retry } = uploadQueue.shift();
            let attempts = retry;
            inFlightUploads += 1;
            try {
              while (attempts >= 0) {
                try {
                  await fetch(`${API_BASE}/api/recording-chunk`, { method: "POST", body: fd });
                  break;
                } catch (e) {
                  if (attempts === 0) {
                    console.error("Chunk upload failed:", e?.message || e);
                    break;
                  }
                  await new Promise(r => setTimeout(r, 1000));
                  attempts -= 1;
                }
              }
            } finally {
              inFlightUploads -= 1;
            }
          }
        } finally {
          uploading = false;
        }
      }

      async function setupFaceProctoring() {
        if (!proctoringConfig.enableFacePresence && !proctoringConfig.enableHeadPose && !proctoringConfig.enableGaze) return;
        if (!candidateVideo) return;
        try {
          const tf = await import("@tensorflow/tfjs-core");
          await import("@tensorflow/tfjs-backend-webgl");
          await tf.setBackend("webgl");
          await tf.ready();
          const fmd = await import("@tensorflow-models/face-landmarks-detection");
          if (fmd?.createDetector && fmd?.SupportedModels?.MediaPipeFaceMesh) {
            faceDetector = await fmd.createDetector(fmd.SupportedModels.MediaPipeFaceMesh, {
              runtime: "tfjs",
              refineLandmarks: true,
              maxFaces: 1,
            });
          }
        } catch (e) {
          console.warn("Face model load failed, falling back to basic face detection:", e?.message || e);
          setStatus("Proctoring limited: face model failed to load, retrying...");
          setTimeout(() => setupFaceProctoring().catch(() => {}), 5000);
        }
        if (!faceDetector && "FaceDetector" in window) {
          try { faceDetector = new window.FaceDetector({ maxDetectedFaces: 1, fastMode: true }); } catch (_) {}
        }
      }

      function stopFaceProctoring() {
        if (faceDetectInterval) { clearInterval(faceDetectInterval); faceDetectInterval = null; }
        faceDetectBusy = false;
        faceMissingSince = null;
        headAwaySince = null;
        gazeAwaySince = null;
        awaitingClosingAck = false;
        gracefulExitScheduled = false;
        completionPromptShown = false;
        clearGracefulEndTimer();
      }

      function startFaceProctoring() {
        if (!faceDetector || faceDetectInterval) return;
        faceDetectInterval = setInterval(async () => {
          if (faceDetectBusy) return;
          if (proctoringTerminated || isCamOff || !candidateVideo) return;
          if (candidateVideo.readyState < 2) return;
          faceDetectBusy = true;
          try {
            let faces = [];
            if (faceDetector?.estimateFaces) {
              faces = await faceDetector.estimateFaces(candidateVideo, { flipHorizontal: false });
            } else if (faceDetector?.detect) {
              faces = await faceDetector.detect(candidateVideo);
            }
            const now = Date.now();
            if (!faces || faces.length === 0) {
              if (!faceMissingSince) faceMissingSince = now;
              if ((now - faceMissingSince) / 1000 >= proctoringConfig.faceMissingWarnSec) {
                sendProctoringWarning("face", "No face detected for several seconds. Please keep your face centered and visible on camera.");
                faceMissingSince = now;
              }
              headAwaySince = null;
              gazeAwaySince = null;
              return;
            }
            faceMissingSince = null;
            const face = faces[0];
            const keypoints = face?.keypoints || face?.landmarks || face?.scaledMesh;
            if (!keypoints || !Array.isArray(keypoints)) return;

            if (proctoringConfig.enableHeadPose) {
              const leftEyeOuter = pointFromKeypoints(keypoints, 33);
              const rightEyeOuter = pointFromKeypoints(keypoints, 263);
              const noseTip = pointFromKeypoints(keypoints, 1);
              if (leftEyeOuter && rightEyeOuter && noseTip) {
                const eyeMid = { x: (leftEyeOuter.x + rightEyeOuter.x) / 2, y: (leftEyeOuter.y + rightEyeOuter.y) / 2 };
                const eyeDist = distance(leftEyeOuter, rightEyeOuter);
                const yaw = (noseTip.x - eyeMid.x) / eyeDist;
                const pitch = (noseTip.y - eyeMid.y) / eyeDist;
                const headAway = Math.abs(yaw) > proctoringConfig.yawThreshold || Math.abs(pitch) > proctoringConfig.pitchThreshold;
                if (headAway) {
                  if (!headAwaySince) headAwaySince = now;
                  if ((now - headAwaySince) / 1000 >= proctoringConfig.headAwayWarnSec) {
                    sendProctoringWarning("head", "Please face the camera. Turning away for extended periods is not allowed.");
                    headAwaySince = now;
                  }
                } else {
                  headAwaySince = null;
                }
              }
            }

            if (proctoringConfig.enableGaze) {
              const leftEyeInner = pointFromKeypoints(keypoints, 133);
              const leftEyeOuter = pointFromKeypoints(keypoints, 33);
              const rightEyeInner = pointFromKeypoints(keypoints, 362);
              const rightEyeOuter = pointFromKeypoints(keypoints, 263);
              const leftIrisPoints = [468, 469, 470, 471, 472].map(i => pointFromKeypoints(keypoints, i)).filter(Boolean);
              const rightIrisPoints = [473, 474, 475, 476, 477].map(i => pointFromKeypoints(keypoints, i)).filter(Boolean);
              const leftIris = avgPoints(leftIrisPoints);
              const rightIris = avgPoints(rightIrisPoints);
              if (leftEyeInner && leftEyeOuter && rightEyeInner && rightEyeOuter && leftIris && rightIris) {
                const leftCenter = { x: (leftEyeInner.x + leftEyeOuter.x) / 2, y: (leftEyeInner.y + leftEyeOuter.y) / 2 };
                const rightCenter = { x: (rightEyeInner.x + rightEyeOuter.x) / 2, y: (rightEyeInner.y + rightEyeOuter.y) / 2 };
                const leftWidth = distance(leftEyeInner, leftEyeOuter);
                const rightWidth = distance(rightEyeInner, rightEyeOuter);
                const leftOffset = Math.abs(leftIris.x - leftCenter.x) / leftWidth;
                const rightOffset = Math.abs(rightIris.x - rightCenter.x) / rightWidth;
                const gazeAway = leftOffset > proctoringConfig.gazeThreshold && rightOffset > proctoringConfig.gazeThreshold;
                if (gazeAway) {
                  if (!gazeAwaySince) gazeAwaySince = now;
                  if ((now - gazeAwaySince) / 1000 >= proctoringConfig.gazeAwayWarnSec) {
                    sendProctoringWarning("gaze", "Please keep your eyes on the screen and avoid looking away for long periods.");
                    gazeAwaySince = now;
                  }
                } else {
                  gazeAwaySince = null;
                }
              }
            }
          } catch (e) {
            console.warn("Face proctoring error:", e?.message || e);
          } finally {
            faceDetectBusy = false;
          }
        }, proctoringConfig.detectionIntervalMs);
      }

      async function startRecording() {
        if (window.__mediaRecorderRunning) return;
        if (!localStream || !window.MediaRecorder) return;
        window.__mediaRecorderRunning = true;
        finalized = false;
        try {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: "interactive" });
          if (audioCtx.state === "suspended") await audioCtx.resume();
          const dest = audioCtx.createMediaStreamDestination();
          audioCtx.createMediaStreamSource(localStream).connect(dest);
          let vapiAudio = null;
          for (let i = 0; i < 10; i++) {
            vapiAudio = document.querySelector("audio[autoplay]") || document.querySelector("audio");
            if (vapiAudio) break;
            await new Promise(r => setTimeout(r, 500));
          }
          if (vapiAudio) {
            vapiAudio.muted = false; vapiAudio.volume = 1.0;
            if (!tappedElements.has(vapiAudio)) {
              tappedElements.add(vapiAudio);
              const vapiStream = vapiAudio.srcObject instanceof MediaStream ? vapiAudio.srcObject : null;
              if (vapiStream) { const src = audioCtx.createMediaStreamSource(vapiStream); src.connect(dest); }
            }
            vapiAudioCaptured = true;
          }
          const videoTrack = localStream.getVideoTracks()[0];
          const mixed = new MediaStream([...dest.stream.getAudioTracks(), ...(videoTrack ? [videoTrack] : [])]);
          const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(m => MediaRecorder.isTypeSupported(m)) || "";
          mediaRecorder = new MediaRecorder(mixed, mimeType ? { mimeType } : {});
          mediaRecorder.ondataavailable = e => {
            if (!e.data || e.data.size === 0) return;
            const sessionToken = getParam("session") || localStorage.getItem("sessionToken") || "";
            if (!sessionToken) return;
            try { localStorage.setItem("sessionToken", sessionToken); } catch (_) {}
            const idxKey = `recChunk:${sessionToken}`;
            const nextIndex = Number(localStorage.getItem(idxKey) || "0");
            localStorage.setItem(idxKey, String(nextIndex + 1));
            uploadChunk(e.data, nextIndex)
              .catch(err => console.error("Chunk upload failed:", err.message));
          };
          mediaRecorder.onstop = () => { window.__mediaRecorderRunning = false; };
          mediaRecorder.start(5000);
        } catch (e) { console.error("Recording setup failed:", e.message); window.__mediaRecorderRunning = false; }
      }

      async function stopAndUpload() {
        if (!mediaRecorder || mediaRecorder.state === "inactive") {
          await waitForUploadQueueToDrain();
          await sendFinalRecordingMarker();
          return;
        }
        return new Promise(resolve => {
          mediaRecorder.onstop = async () => {
            window.__mediaRecorderRunning = false;
            if (audioCtx) { audioCtx.close(); audioCtx = null; }
            await waitForUploadQueueToDrain();
            await sendFinalRecordingMarker();
            resolve();
          };
          flushFinalChunk();
        });
      }

      async function setupCamera() {
        setStatus("Requesting camera & microphone...");
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          candidateVideo.srcObject = localStream;
          candidateVideo.style.display = "block";
          camOffOverlay.style.display = "none";
          return true;
        } catch (err) {
          try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
            return true;
          } catch (_) {
            statusOverlay.style.display = "none";
            permError.style.display = "flex";
            return false;
          }
        }
      }

      function startTimer() {
        callStartTime = Date.now();
        timerInterval = setInterval(() => {
          const s = Math.floor((Date.now() - callStartTime) / 1000);
          timerEl.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
        }, 1000);
      }

      async function endCall() {
        if (callEnded) return;
        callEnded = true;
        clearGracefulEndTimer();
        clearInterval(timerInterval);
        stopCamWarning();
        stopFaceProctoring();
        if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
        await stopAndUpload();
        if (localStream) localStream.getTracks().forEach(t => t.stop());
        if (endedName) endedName.textContent = variableValues?.candidateName || "Candidate";
        if (endedScreen) endedScreen.style.display = "flex";
      }

      function requestFullscreen() {
        const el = document.documentElement;
        if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      }

      micBtn.addEventListener("click", async () => {
        if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume();
        if (!vapi) return;
        isMuted = !isMuted;
        vapi.setMuted(isMuted);
        if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
        micBtn.classList.toggle("off", isMuted);
        micBtn.classList.toggle("active", !isMuted);
      });

      camBtn.addEventListener("click", () => {
        if (!localStream) return;
        isCamOff = !isCamOff;
        localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
        candidateVideo.style.display = isCamOff ? "none" : "block";
        camOffOverlay.style.display  = isCamOff ? "flex" : "none";
        camBtn.classList.toggle("off", isCamOff);
        camBtn.classList.toggle("active", !isCamOff);
        if (isCamOff) startCamWarning(); else stopCamWarning();
      });

      endBtn.addEventListener("click", () => {
        if (vapi) {
          try { vapi.stop(); } catch (_) {}
        }
        endCall();
      });

      function handleTabSwitch() {
        if (!vapi) return;
        tabSwitchCount++;
        const msg = tabSwitchCount === 1
          ? "The candidate just switched tabs. Stop and warn them tab switching is not allowed and is being recorded."
          : `The candidate has switched tabs ${tabSwitchCount} times. Firmly warn them repeated switching may result in disqualification.`;
        vapi.send({ type: "add-message", message: { role: "system", content: msg } });
        fetch(`${API_BASE}/api/session-heartbeat`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_token: getParam("session") || "", transcript_so_far: `[PROCTORING] Tab switch #${tabSwitchCount} at ${new Date().toISOString()}` }),
        }).catch(() => {});
        if (tabSwitchCount > 3) terminateInterview("Repeated tab switching detected.");
      }

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") handleTabSwitch();
      });
      window.addEventListener("blur", () => handleTabSwitch());

      document.addEventListener("fullscreenchange", () => {
        if (document.fullscreenElement || !vapi) return;
        vapi.send({ type: "add-message", message: { role: "system", content: "The candidate has exited fullscreen mode. Stop and instruct them to return to fullscreen immediately to continue the interview." } });
      });

      async function startInterview() {
        if (interviewStarting) return;
        interviewStarting = true;
        setStatus("Loading interview details...");
        variableValues = await initializeConfig();
        if (!variableValues) { interviewStarting = false; return; }

        tabSwitchCount = 0;
        proctoringTerminated = false;
        awaitingClosingAck = false;
        gracefulExitScheduled = false;
        callEnded = false;
        completionPromptShown = false;
        clearGracefulEndTimer();
        const sessionToken = getParam("session") || "";
        let resumeData = null;
        if (sessionToken) {
          const resumeResp = await fetch(`${API_BASE}/api/session-resume/${encodeURIComponent(sessionToken)}`).catch(() => null);
          resumeData = resumeResp && resumeResp.ok ? await resumeResp.json().catch(() => null) : null;
          const allowResume = resumeData?.allowResume === true;
          if (!allowResume && resumeData) {
            showExpired("Session closed: reconnect window (90s) passed. Please contact support for a new link.");
            interviewStarting = false;
            return;
          }
          if (allowResume) {
            variableValues = variableValues || {};
            variableValues.resuming = "true";
            if (resumeData.vapi_conversation_state) {
              variableValues.previousContext = JSON.stringify(resumeData.vapi_conversation_state);
            }
          }
        }
        if (sessionToken) {
          try {
            const idxKey = "recChunk:" + sessionToken;
            if (!localStorage.getItem(idxKey)) localStorage.setItem(idxKey, "0");
          } catch (_) {}
        }
        const initials = variableValues.candidateName.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
        if (candidateAvatar) candidateAvatar.textContent = initials || "?";
        if (candidateLabel) candidateLabel.textContent = variableValues.candidateName;
        const camOk = await setupCamera();
        if (!camOk) return;
        setStatus("Connecting to AI interviewer...");
        vapi = new Vapi(PUBLIC_KEY);

        vapi.on("call-start", async (callData) => {
          console.log("[interview] vapi call-start", {
            sessionToken,
            callId: callData?.id || callData?.callId || null,
            rawCallData: callData,
          });
          hideOverlay();
          if (callInfo) callInfo.textContent = `Interview · ${variableValues.candidateName}`;
          startTimer();
          setLiveIndicator("Interview started — AI is speaking...");
          if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume();
          startRecording();
          if (sessionToken) {
            const callId = callData?.id || callData?.callId || null;
            const convState = callData?.state || callData?.conversationState || resumeData?.vapi_conversation_state || null;
            console.log("[interview] posting session-start", {
              sessionToken,
              callId,
              hasConversationState: !!convState,
            });
            fetch(`${API_BASE}/api/session-start`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                session_token: sessionToken,
                vapi_call_id: callId,
                conversation_state: convState,
              }),
            })
              .then(async (res) => {
                const text = await res.text().catch(() => "");
                console.log("[interview] session-start response", {
                  status: res.status,
                  ok: res.ok,
                  body: text,
                });
              })
              .catch((err) => {
                console.error("[interview] session-start request failed", err);
              });
          }
          setTimeout(async () => {
            await setupFaceProctoring();
            startFaceProctoring();
          }, PROCTORING_BOOT_DELAY_MS);
          heartbeatInterval = setInterval(() => {
            const transcript = Array.from(document.querySelectorAll(".transcript-entry .text")).map(el => el.textContent).join("\n");
            fetch(`${API_BASE}/api/session-heartbeat`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ session_token: sessionToken, transcript_so_far: transcript }),
            }).catch(() => {});
          }, 5000);
        });

        vapi.on("call-end", (callData) => {
          if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
          vapiRecordingUrl = callData?.recordingUrl || callData?.artifact?.recordingUrl || null;
          if (vapiRecordingUrl) {
            fetch(`${API_BASE}/api/save-recording-url`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ recordingUrl: vapiRecordingUrl, sessionToken: getParam("session") || "" }),
            }).catch(() => {});
          }
          if (sessionToken) {
            fetch(`${API_BASE}/api/session-disconnect`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ session_token: sessionToken }),
            }).catch(() => {});
          }
          endCall();
        });

        vapi.on("speech-start", () => { setAgentSpeaking(true); setCandidateSpeaking(false); setLiveIndicator("<span>AI Interviewer</span> is speaking..."); });
        vapi.on("speech-end", () => { setAgentSpeaking(false); setLiveIndicator("Your turn to speak..."); });

        vapi.on("message", (msg) => {
          if (msg.type === "transcript") {
            const role = msg.role === "user" ? "user" : "agent";
            if (msg.transcriptType === "partial") {
              setLiveIndicator(`<span>${role === "agent" ? "AI" : variableValues.candidateName}</span>: ${msg.transcript}`);
              if (role === "user") setCandidateSpeaking(true);
            } else if (msg.transcriptType === "final") {
              addTranscript(role, msg.transcript);
              setLiveIndicator(role === "agent" ? "Your turn to speak..." : "AI is processing...");
              if (role === "user") setCandidateSpeaking(false);
              const lower = (msg.transcript || "").toLowerCase();
              if (role === "user" && (lower.includes("hang up") || lower.includes("end the call") || lower.includes("end call") || lower.includes("disconnect") || lower.includes("terminate the call"))) {
                if (vapi) vapi.stop();
                endCall();
              }
            }
          }
        });

        vapi.on("error", (err) => {
          if (gracefulExitScheduled || completionPromptShown || callEnded) {
            showCompletionPrompt();
            return;
          }
          setStatus("Connection error: " + (err.message || JSON.stringify(err)));
          if (statusOverlay) statusOverlay.style.display = "flex";
          if (sessionToken) {
            fetch(`${API_BASE}/api/session-disconnect`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ session_token: sessionToken }),
            }).catch(() => {});
          }
          // simple retry once after 3s
          setTimeout(() => {
            setStatus("Reconnecting...");
            startInterview();
          }, 3000);
        });

        try {
          await vapi.start(ASSISTANT_ID, {
            recordingEnabled: true,
            firstMessage: `Hello ${variableValues.candidateName}! I'm your AI interviewer from Pontis. I'll be conducting your interview for the ${variableValues.jobRole || "position"} today. Are you ready to begin?`,
            maxDurationSeconds: 1800,
            silenceTimeoutSeconds: 30,
            variableValues: {
              candidateName:   variableValues.candidateName,
              jobRole:         variableValues.jobRole,
              resume:          variableValues.resume,
              jobDescription:  variableValues.jobDescription,
              email:           variableValues.email,
              agencyId:        variableValues.agencyId,
              candidateId:     variableValues.candidateId,
              userId:          variableValues.userId,
              jobId:           variableValues.jobId,
              async_questions: variableValues.async_questions || [],
              skills:          variableValues.skills || "",
              agencyName:      variableValues.agencyName || "",
              session:         getParam("session") || "",
              resuming:        variableValues.resuming || "false",
            previousContext: variableValues.previousContext || "",
            interview_questions: variableValues.interview_questions || variableValues.async_questions || [],
          },
        });
      } catch (err) {
        setStatus("Failed to start: " + (err.message || JSON.stringify(err)));
        interviewStarting = false;
      }
      }

      document.getElementById("consentBtn").addEventListener("click", async () => {
        document.getElementById("consentScreen").style.display = "none";
        requestFullscreen();
        await startInterview();
      });
    });
  }, []);

  return (
    <>
      <div id="consentScreen">
        <div className="consent-logo">Pontis AI Interview</div>
        <div className="consent-body">
          Before you begin, please read and agree to the following:
          <ul className="consent-list">
            <li>This interview is conducted by an <strong>AI assistant</strong>, not a human.</li>
            <li>Your <strong>video, audio and screen activity</strong> will be recorded and analyzed.</li>
            <li>AI-based <strong>proctoring</strong> is active — tab switching and camera-off are monitored.</li>
            <li>Data is stored securely and used only for <strong>hiring evaluation</strong>.</li>
          </ul>
        </div>
        <button id="consentBtn">I Agree &amp; Continue</button>
      </div>

      <div id="statusOverlay">
        <div className="logo-big">Pontis</div>
        <div className="spinner"></div>
        <p id="statusText">Requesting camera access...</p>
      </div>

      <div id="permError">
        <h2>Camera / Mic Blocked</h2>
        <p>Please allow camera and microphone access in your browser settings, then refresh the page.</p>
        <button onClick={() => location.reload()}>Retry</button>
      </div>
      <div id="expiredScreen">
        <h2>Interview Link Expired</h2>
        <p>This interview slot has already passed. Please book a new time.</p>
        <a href="/booking" style={{marginTop:"8px",display:"inline-block"}}>Go to booking</a>
      </div>

      <div id="endedScreen">
        <h2>Interview Completed</h2>
        <p>Thank you for attending the interview.</p>
        <p>You may close this window now.</p>
        <p id="endedName" style={{color:"#a78bfa",fontWeight:600}}></p>
      </div>

      <div id="topbar">
        <div className="brand">
          <div className="brand-icon">P</div>
          <div className="brand-text">
            <div className="brand-name">Pontis AI</div>
            <div className="brand-sub">AI Interview Portal</div>
          </div>
        </div>
        <div className="top-meta">
          <span className="pill live">● LIVE</span>
          <span className="pill role" id="callInfo">Connecting...</span>
          <span className="pill timer" id="timer">00:00</span>
        </div>
      </div>

      <div id="main">
        <div id="stage">
          <div className="stage-center" id="agentTile">
            <div className="avatar-shell">
              <div className="avatar-circle" id="agentAvatar">
                <svg viewBox="0 0 32 32" aria-hidden="true">
                  <path d="M16 20a4 4 0 0 0 4-4v-6a4 4 0 0 0-8 0v6a4 4 0 0 0 4 4zm6-4a6 6 0 0 1-12 0h-2a8 8 0 0 0 16 0h-2zm-6 9v-3h-2v3h2z" fill="currentColor"/>
                </svg>
              </div>
            </div>
            <div className="waveform" aria-hidden="true">
              <span style={{"--h":"10px"}}></span>
              <span style={{"--h":"18px"}}></span>
              <span style={{"--h":"26px"}}></span>
              <span style={{"--h":"34px"}}></span>
              <span style={{"--h":"28px"}}></span>
              <span style={{"--h":"20px"}}></span>
              <span style={{"--h":"14px"}}></span>
              <span style={{"--h":"22px"}}></span>
              <span style={{"--h":"30px"}}></span>
            </div>
            <div className="agent-name">AI Interviewer</div>
            <div className="agent-status">Speaking...</div>
          </div>

          <div className="self-tile" id="candidateTile">
            <video id="candidateVideo" autoPlay muted playsInline style={{display:"none"}}></video>
            <div className="cam-off-overlay" id="camOffOverlay">
              <div className="tile-avatar" id="candidateAvatar">?</div>
              <span className="cam-off-text">Camera off</span>
            </div>
            <div className="tile-label">
              <span id="candidateLabel">You</span>
              <span className="mic-icon" id="candidateMicIcon"></span>
            </div>
          </div>
        </div>

        <div id="transcriptPanel">
          <div className="panel-header">
            <span>Live Transcript</span>
            <span className="status-dot">Connected</span>
          </div>
          <div id="transcriptFeed" className="chat-feed"></div>
          <div id="liveIndicator" className="live-indicator">Waiting for speech...</div>
        </div>
      </div>

      <div id="controls">
        <button className="ctrl-btn active" id="micBtn" title="Mute/Unmute">
          <svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 14 0h-2zm-5 9v-3h-2v3h2z"/></svg>
        </button>
        <button className="ctrl-btn active" id="camBtn" title="Camera on/off">
          <svg viewBox="0 0 24 24"><path d="M17 10.5V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5l4 4v-11l-4 4z"/></svg>
        </button>
        <button className="ctrl-btn danger" id="endBtn" title="Leave call">
          <svg viewBox="0 0 24 24"><path d="M4.51 15.48c1.69-1.69 4.26-2.48 6.99-2.48 2.73 0 5.3.79 6.99 2.48l2.12-2.12C18.13 11.03 14.93 10 11.5 10s-6.63 1.03-9.11 3.36l2.12 2.12z"/></svg>
        </button>
      </div>
    </>
  );
}
