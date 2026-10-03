const BOT_URL = "http://localhost:7860";
const WORKER_URL = "http://localhost:8787";

let pc = null;  // RTCPeerConnection
let dc = null;  // RTCDataChannel
let pingInterval = null;
let micStream = null;

// Status helper 
function setStatus(msg, type = "") {
    const el = document.getElementById("status");
    el.textContent = msg;
    el.className = type;
}

// Microphone stream manager (cached to prevent repeated browser permission prompts)
async function getOrCreateMicStream() {
    const isLive = micStream && micStream.active && micStream.getAudioTracks().some(t => t.readyState === "live");
    if (!isLive) {
        setStatus("Requesting microphone...");
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            }
        });
    }
    // Ensure tracks are active
    micStream.getAudioTracks().forEach(track => {
        track.enabled = true;
    });
    return micStream;
}

// Start call 
async function startCall() {
    try {
        await getOrCreateMicStream();

        pc = new RTCPeerConnection();

        // Create data channel (required by SmallWebRTC for keepalive + messaging)
        dc = pc.createDataChannel("data");
        dc.onopen = () => {
            console.log("[WebRTC] Data channel open");
            if (pingInterval) clearInterval(pingInterval);
            pingInterval = setInterval(() => {
                if (dc && dc.readyState === "open") {
                    dc.send("ping");
                }
            }, 1000);
        };
        dc.onclose = () => {
            console.log("[WebRTC] Data channel closed");
        };
        dc.onerror = (e) => {
            console.warn("[WebRTC] Data channel error:", e);
        };
        dc.onmessage = (e) => {
            console.log("[WebRTC] Data channel message:", e.data);
        };

        // Send mic audio to bot & receive audio back
        // Clone mic tracks before adding to PeerConnection so pc.close() doesn't kill the cached master tracks
        micStream.getAudioTracks().forEach(track => {
            const clone = track.clone();
            pc.addTrack(clone, micStream);
        });

        // Play bot audio back
        pc.ontrack = (e) => {
            console.log("[WebRTC] Received remote track:", e.track.kind);
            const audio = document.getElementById("remoteAudio");
            if (audio) {
                audio.muted = false;
                audio.volume = 1.0;
                audio.srcObject = (e.streams && e.streams[0]) ? e.streams[0] : new MediaStream([e.track]);
                audio.play().catch(err => console.warn("Audio play() blocked:", err));
            }
        };

        // Create WebRTC offer and send to bot's signaling server
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Wait for ICE gathering to complete
        await new Promise(resolve => {
            if (pc.iceGatheringState === "complete") return resolve();
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === "complete") resolve();
            };
        });

        setStatus("Connecting to bot...");

        const voice = document.getElementById("voiceSelect")?.value || "asteria";
        const voiceSelect = document.getElementById("voiceSelect");
        if (voiceSelect) voiceSelect.disabled = true;

        const res = await fetch(`${BOT_URL}/offer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                sdp: pc.localDescription.sdp,
                type: pc.localDescription.type,
                voice: voice,
            }),
        });

        if (!res.ok) {
            throw new Error(`Bot signaling error: ${res.status}`);
        }

        const answer = await res.json();
        await pc.setRemoteDescription(answer);

        setStatus("In call — speak now", "active");
        document.getElementById("startBtn").disabled = true;
        document.getElementById("endBtn").style.display = "inline-block";

    } catch (err) {
        setStatus(`Error: ${err.message}`, "error");
        console.error("startCall error:", err);
        endCall();
    }
}

// End call 
function endCall() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    if (dc) {
        try { dc.close(); } catch (e) {}
        dc = null;
    }
    if (micStream) {
        // Mute mic tracks instead of destroying them to avoid re-prompting for permission
        micStream.getAudioTracks().forEach(track => track.enabled = false);
    }
    if (pc) {
        try {
            pc.getSenders().forEach(sender => {
                if (sender.track) {
                    try { sender.track.stop(); } catch (e) {}
                }
            });
            pc.close();
        } catch (e) {}
        pc = null;
    }
    setStatus("Call ended. Saving...");
    document.getElementById("startBtn").disabled = false;
    document.getElementById("endBtn").style.display = "none";
    const voiceSelect = document.getElementById("voiceSelect");
    if (voiceSelect) voiceSelect.disabled = false;

    // Refresh call list after a short delay (bot needs time to POST to worker)
    setTimeout(loadCalls, 1200);
    setTimeout(loadCalls, 3000);
}

// Load call list 
async function loadCalls() {
    try {
        const res = await fetch(`${WORKER_URL}/calls`);
        const calls = await res.json();
        const list = document.getElementById("callList");

        if (!calls.length) {
            list.innerHTML = '<div class="empty">No calls yet.</div>';
            return;
        }

        list.innerHTML = calls.map(c => `
      <div class="call-item" onclick="openCall('${c.id}')">
        <div>
          <div>Call ${c.id.slice(0, 8)}…</div>
          <div class="meta">${new Date(c.start_time).toLocaleString()}</div>
        </div>
        <span class="badge">${c.duration}s</span>
      </div>
    `).join("");

        setStatus("Idle");
    } catch (err) {
        console.error("Failed to load calls:", err);
    }
}

// Open call detail modal 
async function openCall(id) {
    const res = await fetch(`${WORKER_URL}/calls/${id}`);
    const call = await res.json();

    document.getElementById("modalTitle").textContent =
        `Call — ${new Date(call.start_time).toLocaleString()} (${call.duration}s)`;

    const transcript = (call.transcript || []).map(t => `
    <div class="transcript-turn ${t.role}">
      <div class="turn-role">${t.role === "user" ? "You" : "Bot"}</div>
      ${t.content}
    </div>
  `).join("");

    const avgLLM = avg(call.metrics, "llm_latency");
    const avgTTS = avg(call.metrics, "tts_latency");

    document.getElementById("modalBody").innerHTML = `
    <div class="section-label">Transcript</div>
    ${transcript || '<div class="empty">No transcript.</div>'}

    <div class="section-label">Metrics</div>
    <div class="metrics-grid">
      <div class="metric-box">
        <div class="val">${call.duration}s</div>
        <div class="lbl">Duration</div>
      </div>
      <div class="metric-box">
        <div class="val">${avgLLM}ms</div>
        <div class="lbl">Avg LLM latency</div>
      </div>
      <div class="metric-box">
        <div class="val">${avgTTS}ms</div>
        <div class="lbl">Avg TTS latency</div>
      </div>
    </div>
  `;

    document.getElementById("modal").classList.add("open");
}

function closeModal() {
    document.getElementById("modal").classList.remove("open");
}

function avg(arr, key) {
    if (!arr || !arr.length) return "—";
    const vals = arr.map(m => m[key]).filter(Boolean);
    if (!vals.length) return "—";
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

// Clean up microphone hardware tracks when tab is closed
window.addEventListener("beforeunload", () => {
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
    }
});

// Load calls on page open
loadCalls();