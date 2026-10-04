const BOT_URL = "http://localhost:7860";
const WORKER_URL = "https://mini-call-log-worker.ayanforcode.workers.dev";

let pc = null;  // RTCPeerConnection
let dc = null;  // RTCDataChannel
let pingInterval = null;
let micStream = null;
let selectedVoice = "asteria";
let isCallActive = false;

// ----------------------------------------------------
// UI State Management
// ----------------------------------------------------
function updateCallUIState(state, info = "") {
    const badge = document.getElementById("statusBadge");
    const badgeText = document.getElementById("statusBadgeText");
    const hlLine1 = document.getElementById("hlLine1");
    const hlLine2 = document.getElementById("hlLine2");
    const hlLine3 = document.getElementById("hlLine3");
    const instructions = document.getElementById("instructionsText");
    const voiceLockNotice = document.getElementById("voiceLockNotice");
    const startBtn = document.getElementById("startBtn");
    const endBtn = document.getElementById("endBtn");
    const voiceContextNote = document.getElementById("voiceContextNote");
    const voiceContextVal = document.getElementById("voiceContextVal");
    const callProgressInfo = document.getElementById("callProgressInfo");
    const audioWaveRegion = document.getElementById("audioWaveRegion");
    const errorBanner = document.getElementById("errorBanner");
    const errorBannerText = document.getElementById("errorBannerText");

    const voiceCards = document.querySelectorAll(".voice-card");

    if (state === "idle") {
        isCallActive = false;
        if (badge) badge.className = "status-badge";
        if (badgeText) badgeText.textContent = "Ready";

        if (hlLine1) hlLine1.textContent = "LESS TALK.";
        if (hlLine2) hlLine2.textContent = "MORE WORK.";
        if (hlLine3) hlLine3.textContent = "WITH AI.";

        if (instructions) instructions.textContent = "Click to start a voice call with the AI agent.";

        voiceCards.forEach(card => {
            card.classList.remove("locked");
            card.disabled = false;
            const isSel = card.dataset.voice === selectedVoice;
            card.classList.toggle("selected", isSel);
            const ind = card.querySelector(".voice-indicator");
            if (ind) ind.textContent = isSel ? "✓" : "";
        });

        if (voiceLockNotice) voiceLockNotice.style.display = "none";
        if (startBtn) {
            startBtn.style.display = "inline-flex";
            startBtn.disabled = false;
            startBtn.textContent = "Start Call";
        }
        if (endBtn) endBtn.style.display = "none";
        if (voiceContextNote) voiceContextNote.classList.remove("visible");
        if (callProgressInfo) callProgressInfo.classList.remove("visible");
        if (audioWaveRegion) audioWaveRegion.classList.remove("visible", "animating");
        if (errorBanner) errorBanner.classList.remove("visible");

    } else if (state === "connecting") {
        if (badge) badge.className = "status-badge";
        if (badgeText) badgeText.textContent = "Connecting...";
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.textContent = "Connecting...";
        }
        if (errorBanner) errorBanner.classList.remove("visible");

    } else if (state === "active") {
        isCallActive = true;
        if (badge) badge.className = "status-badge active";
        if (badgeText) badgeText.textContent = "Active";

        if (hlLine1) hlLine1.textContent = "YOU TALK.";
        if (hlLine2) hlLine2.textContent = "AI LISTENS.";
        if (hlLine3) hlLine3.textContent = "LIVE NOW.";

        if (instructions) instructions.textContent = "Your voice call with the AI agent is active.";

        voiceCards.forEach(card => {
            card.classList.add("locked");
            card.disabled = true;
            const ind = card.querySelector(".voice-indicator");
            if (ind) {
                ind.textContent = (card.dataset.voice === selectedVoice) ? "🔒" : "";
            }
        });

        if (voiceLockNotice) voiceLockNotice.style.display = "inline-block";
        if (startBtn) startBtn.style.display = "none";
        if (endBtn) endBtn.style.display = "inline-flex";

        if (voiceContextNote) {
            voiceContextNote.classList.add("visible");
            if (voiceContextVal) voiceContextVal.textContent = `${selectedVoice} · voice locked`;
        }

        if (callProgressInfo) callProgressInfo.classList.add("visible");
        if (audioWaveRegion) audioWaveRegion.classList.add("visible", "animating");
        if (errorBanner) errorBanner.classList.remove("visible");

    } else if (state === "error") {
        if (badge) badge.className = "status-badge error";
        if (badgeText) badgeText.textContent = "Error";
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.textContent = "Start Call";
        }
        if (errorBanner) {
            errorBanner.classList.add("visible");
            if (errorBannerText) errorBannerText.textContent = info || "Unable to start the call. Please try again.";
        }
        if (audioWaveRegion) audioWaveRegion.classList.remove("visible", "animating");
        if (callProgressInfo) callProgressInfo.classList.remove("visible");
    }
}

// Voice selection handler
function selectVoice(voice) {
    if (isCallActive) return;
    selectedVoice = voice;
    const voiceSelect = document.getElementById("voiceSelect");
    if (voiceSelect) voiceSelect.value = voice;

    document.querySelectorAll(".voice-card").forEach(card => {
        const isSel = card.dataset.voice === voice;
        card.classList.toggle("selected", isSel);
        const ind = card.querySelector(".voice-indicator");
        if (ind) ind.textContent = isSel ? "✓" : "";
    });

    const voiceContextVal = document.getElementById("voiceContextVal");
    if (voiceContextVal) voiceContextVal.textContent = `${voice} · voice locked`;
}

// ----------------------------------------------------
// Microphone stream manager (cached across calls)
// ----------------------------------------------------
async function getOrCreateMicStream() {
    const isLive = micStream && micStream.active && micStream.getAudioTracks().some(t => t.readyState === "live");
    if (!isLive) {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            }
        });
    }
    // Re-enable tracks in case they were muted during idle
    micStream.getAudioTracks().forEach(track => {
        track.enabled = true;
    });
    return micStream;
}

// ----------------------------------------------------
// WebRTC Call Session: Start Call
// ----------------------------------------------------
async function startCall() {
    try {
        updateCallUIState("connecting");
        await getOrCreateMicStream();

        pc = new RTCPeerConnection();

        // Create data channel (required by SmallWebRTC for keepalive + signaling)
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

        // Clone mic tracks before adding to PeerConnection so pc.close() doesn't kill the master tracks
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

        // Create WebRTC offer and wait for ICE gathering
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await new Promise(resolve => {
            if (pc.iceGatheringState === "complete") return resolve();
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === "complete") resolve();
            };
        });

        const res = await fetch(`${BOT_URL}/offer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                sdp: pc.localDescription.sdp,
                type: pc.localDescription.type,
                voice: selectedVoice,
            }),
        });

        if (!res.ok) {
            throw new Error(`Bot signaling error: ${res.status}`);
        }

        const answer = await res.json();
        await pc.setRemoteDescription(answer);

        updateCallUIState("active");

    } catch (err) {
        console.error("startCall error:", err);
        updateCallUIState("error", err.message);
        endCall();
    }
}

// ----------------------------------------------------
// WebRTC Call Session: End Call
// ----------------------------------------------------
function endCall() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    if (dc) {
        try { dc.close(); } catch (e) { }
        dc = null;
    }
    if (micStream) {
        // Mute mic tracks instead of stopping them to preserve browser permission
        micStream.getAudioTracks().forEach(track => track.enabled = false);
    }
    if (pc) {
        try {
            pc.getSenders().forEach(sender => {
                if (sender.track) {
                    try { sender.track.stop(); } catch (e) { }
                }
            });
            pc.close();
        } catch (e) { }
        pc = null;
    }

    updateCallUIState("idle");

    // Refresh call list after intervals to allow the bot to POST data over HTTPS to the remote worker
    setTimeout(loadCalls, 1500);
    setTimeout(loadCalls, 3500);
    setTimeout(loadCalls, 6000);
}

// ----------------------------------------------------
// Call History & List
// ----------------------------------------------------
async function loadCalls() {
    try {
        const res = await fetch(`${WORKER_URL}/calls`);
        const calls = await res.json();
        const list = document.getElementById("callList");
        const countBadge = document.getElementById("recordCount");

        if (countBadge) {
            countBadge.textContent = String(calls.length || 0).padStart(2, "0");
        }

        if (!calls || !calls.length) {
            if (list) list.innerHTML = '<div class="empty-history">No calls recorded yet.</div>';
            return;
        }

        if (list) {
            list.innerHTML = calls.map(c => `
                <div class="call-record-item" onclick="openCall('${c.id}')">
                    <div class="call-record-row-top">
                        <span class="call-identifier">Call ${c.id.slice(0, 8)}…</span>
                        <svg class="call-arrow-icon" viewBox="0 0 24 24">
                            <path d="M7 17L17 7M17 7H7M17 7V17" />
                        </svg>
                    </div>
                    <div class="call-record-row-bottom">
                        <span class="call-record-timestamp">${new Date(c.start_time).toLocaleString()}</span>
                        <span class="duration-badge">${c.duration}s</span>
                    </div>
                </div>
            `).join("");
        }

    } catch (err) {
        console.error("Failed to load calls:", err);
    }
}

// ----------------------------------------------------
// Call Detail Modal
// ----------------------------------------------------
async function openCall(id) {
    try {
        const res = await fetch(`${WORKER_URL}/calls/${id}`);
        const call = await res.json();

        // Populate Metadata Strip
        const modalCallId = document.getElementById("modalCallId");
        const modalTimestamp = document.getElementById("modalTimestamp");
        const modalDuration = document.getElementById("modalDuration");
        const modalTurnCount = document.getElementById("modalTurnCount");
        const modalTranscriptList = document.getElementById("modalTranscriptList");

        if (modalCallId) modalCallId.textContent = `${call.id.slice(0, 8)}…`;
        if (modalTimestamp) modalTimestamp.textContent = new Date(call.start_time).toLocaleString();
        if (modalDuration) modalDuration.textContent = `${call.duration}s`;

        const turns = call.transcript || [];
        if (modalTurnCount) modalTurnCount.textContent = `${turns.length} TURNS`;

        if (modalTranscriptList) {
            if (!turns.length) {
                modalTranscriptList.innerHTML = '<div class="empty-history">No transcript recorded for this call.</div>';
            } else {
                modalTranscriptList.innerHTML = turns.map(t => {
                    const speaker = (t.role === "user") ? "YOU" : "BOT";
                    const roleClass = (t.role === "user") ? "user" : "bot";
                    return `
                        <div class="transcript-turn-box ${roleClass}">
                            <span class="turn-speaker-label">${speaker}</span>
                            <div class="turn-content-text">${escapeHtml(t.content)}</div>
                        </div>
                    `;
                }).join("");
            }
        }

        // Populate Metrics Panel
        const avgLLM = avg(call.metrics, "llm_latency");
        const avgTTS = avg(call.metrics, "tts_latency");

        const metricDurationVal = document.getElementById("metricDurationVal");
        const metricLlmVal = document.getElementById("metricLlmVal");
        const metricTtsVal = document.getElementById("metricTtsVal");

        if (metricDurationVal) metricDurationVal.textContent = `${call.duration}s`;
        if (metricLlmVal) metricLlmVal.textContent = (avgLLM !== "—") ? `${avgLLM}ms` : "—";
        if (metricTtsVal) metricTtsVal.textContent = (avgTTS !== "—") ? `${avgTTS}ms` : "—";

        // Open Modal
        const modal = document.getElementById("modal");
        if (modal) modal.classList.add("open");

    } catch (err) {
        console.error("Failed to open call details:", err);
    }
}

function closeModal() {
    const modal = document.getElementById("modal");
    if (modal) modal.classList.remove("open");
}

function onModalBackdropClick(event) {
    if (event.target.id === "modal") {
        closeModal();
    }
}

// Helpers
function avg(arr, key) {
    if (!arr || !arr.length) return "—";
    const vals = arr.map(m => m[key]).filter(v => v !== null && v !== undefined);
    if (!vals.length) return "—";
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function escapeHtml(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Clean up microphone hardware tracks when tab is closed
window.addEventListener("beforeunload", () => {
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
    }
});

// Initialize on page open
updateCallUIState("idle");
loadCalls();