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

// Start call 
async function startCall() {
    try {
        setStatus("Requesting microphone...");
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

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
        micStream.getAudioTracks().forEach(track => {
            pc.addTrack(track, micStream);
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

        const res = await fetch(`${BOT_URL}/offer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(pc.localDescription),
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
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
    }
    if (pc) {
        try { pc.close(); } catch (e) {}
        pc = null;
    }
    setStatus("Call ended. Saving...");
    document.getElementById("startBtn").disabled = false;
    document.getElementById("endBtn").style.display = "none";

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

// Load calls on page open
loadCalls();