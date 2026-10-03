# Build Log — Mini Call Log Service

This document tracks the technical challenges, root cause analyses, and solutions implemented during the development and stabilization of the **Mini Call Log Service** voice pipeline.

---

## Architecture Overview
- **Voice Pipeline**: Python + [Pipecat 1.12.0](https://github.com/pipecat-ai/pipecat) (`bot/bot.py`)
  - **Transport**: `SmallWebRTCTransport` (WebRTC audio in/out)
  - **STT**: `DeepgramSTTService` (Live audio transcription)
  - **LLM**: `GroqLLMService` (Fast conversational inference via Groq LPUs)
  - **TTS**: `DeepgramTTSService` (Aura voice synthesis)
- **Backend API**: Cloudflare Worker + Cloudflare D1 SQLite (`worker/src/index.js`)
- **Frontend**: Cloudflare Pages / Vanilla JS client (`frontend/src/app.js`, `frontend/src/index.html`)

---

## Persistent Issues & Implemented Solutions

### 1. `PipelineTask` Argument Signature Error
- **Symptom:**
  ```text
  TypeError: PipelineWorker.__init__() takes 2 positional arguments but 3 were given
  ```
- **Root Cause:** In Pipecat 1.12.0, `PipelineTask` inherits from `PipelineWorker`. Passing `PipelineParams` as a positional argument (`PipelineTask(pipeline, PipelineParams(...))`) failed because `params` must be passed as an explicit keyword argument.
- **Solution:** Updated instantiation to `PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))` in `bot/bot.py`.

---

### 2. Windows `aioice` mDNS `.local` Resolution Crash
- **Symptom:** WebRTC offer negotiation crashed in `aioice` on Windows with socket lookup failures when attempting to resolve mDNS `.local` ICE candidate hostnames.
- **Root Cause:** Unlike macOS and Linux, the standard Windows DNS subsystem cannot resolve `.local` mDNS candidate names via basic `getaddrinfo` calls in Python `asyncio`.
- **Solution:** Filtered `.local` candidate lines from client SDP in `handle_offer` before passing to `SmallWebRTCConnection`:
  ```python
  sdp_clean = "\r\n".join(
      line for line in sdp_lines if not (".local" in line and line.startswith("a=candidate"))
  ) + "\r\n"
  ```

---

### 3. SmallWebRTC Data Channel Requirement & Keepalive
- **Symptom:** The bot threw timeouts waiting for the WebRTC data channel to open: `Data channel not ready, queuing message`.
- **Root Cause:** Pipecat's `SmallWebRTCTransport` requires an active WebRTC data channel for keepalive heartbeats and out-of-band application messages. If the browser does not open a data channel, the transport stalls or disconnects.
- **Solution:**
  - Added `dc = pc.createDataChannel("data")` in `frontend/src/app.js`.
  - Added a 1-second keepalive ping (`setInterval(() => dc.send("ping"), 1000)`).

---

### 4. Decommissioned Groq LLM & Jinja Template Crash
- **Symptom:**
  - `404 Model decommissioned` when calling Groq with `llama3-8b-8192`.
  - `400 Jinja template error` on conversational turn handoffs.
- **Root Cause:**
  - Groq decommissioned the legacy `llama3-8b-8192` model.
  - When an empty user turn occurred (e.g. ambient background noise triggering VAD with no transcript), Groq's Jinja chat template failed formatting empty user messages.
- **Solution:**
  - Switched model to `qwen/qwen3.8-27b` (and verified `openai/gpt-oss-20b`).
  - Configured `empty_user_turn=None` in `LLMUserAggregatorParams` so empty turns are gracefully ignored without invoking the LLM.

---

### 5. Bot Silence & Dropped Transcripts (Frame Processor Direct Mode)
- **Symptom:** The user spoke into the microphone, but the bot remained silent. Neither greeting audio nor conversational responses were heard, and transcripts were not logged.
- **Root Cause:**
  - In Pipecat 1.12.0, `FrameProcessor` defaults to queue-based dispatch (`enable_direct_mode=False`).
  - When non-system frames (`DataFrame` such as `TTSSpeakFrame`, `TranscriptionFrame`, `TTSAudioRawFrame`) enter a processor, they are queued until the processor's internal task is started by receiving a `StartFrame`.
  - The custom processors (`AudioInputMonitor`, `UserTranscriptLogger`, `LLMResponseLogger`, `TTSAudioLogger`) did not call `await super().process_frame(frame, direction)` on `StartFrame`.
  - Because `super().process_frame()` was never executed on `StartFrame`, the internal processing task was never created. Every non-system frame entering `AudioInputMonitor` got queued and sat in memory forever without being forwarded to Deepgram STT, Groq, or Deepgram TTS.
- **Solution:**
  - Configured all custom processors with `super().__init__(enable_direct_mode=True)`.
  - Added `await super().process_frame(frame, direction)` across all processor overrides in `bot/bot.py`.

---

### 6. `LocalSmartTurnAnalyzerV3` Incomplete Turn Lock
- **Symptom:** STT transcribed the user's speech accurately, but the bot never replied. Logs showed:
  ```text
  DEBUG | pipecat.audio.turn.smart_turn.base_smart_turn:analyze_end_of_turn - End of Turn result: EndOfTurnState.INCOMPLETE
  ```
- **Root Cause:** `LLMUserAggregator` defaulted to `LocalSmartTurnAnalyzerV3` (an ONNX neural turn classifier). For conversational or brief user speech, the model repeatedly judged the turn as `INCOMPLETE`, refusing to trigger the turn stop event. The LLM was never called.
- **Solution:** Replaced the turn stop strategy with `SpeechTimeoutUserTurnStopStrategy`:
  ```python
  user_turn_strategies=UserTurnStrategies(
      start=[VADUserTurnStartStrategy(), TranscriptionUserTurnStartStrategy()],
      stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.6)],
  )
  ```
  This reliably ends the turn ~600ms after user speech pauses, invoking Groq and generating speech immediately.

---

### 7. Pipeline Hang on Call Disconnect & Reliable Worker Logging
- **Symptom:** When clicking "End Call", the client disconnected, but the bot remained stuck at:
  ```text
  DEBUG | pipecat.pipeline.worker:_wait_for_pipeline_end - PipelineTask#0: Closing. Waiting for EndFrame#0 to reach the end of the pipeline...
  ```
  The pipeline never returned, and `finish_and_post()` in the `finally` block was never executed, leaving the call unlogged.
- **Root Cause:** `EndFrame` waits for downstream sink processors and closed WebRTC tracks to flush. Because the client had already severed the WebRTC connection, `PipelineWorker` hung indefinitely waiting for a flush signal.
- **Solution:**
  - Decoupled data persistence from pipeline runner completion.
  - On `on_client_disconnected`, the bot waits a 0.6s grace period for any in-flight STT fragments, immediately posts the full call record, transcript, and metrics to the Worker (`POST /calls → 201`), and then cancels the pipeline task cleanly via `task.cancel()`.
  - Guarded `finish_and_post()` with an idempotent `posted` flag.

---

### 8. Google Gemini Integration & Model Availability (`LLM_PROVIDER`)
- **Symptom:**
  - When configuring Google Gemini as the LLM provider, calls threw:
    ```text
    google.genai.errors.ClientError: 404 NOT_FOUND.
    "This model models/gemini-2.0-flash is no longer available. Please update your code to use models/gemini-3.8-flash for the latest features and improvements."
    ```
  - STT transcribed user speech, but the bot stayed silent on each turn, only outputting the initial greeting.
- **Root Cause:**
  - `gemini-2.0-flash` was deprecated/sunset by Google in favor of `gemini-3.8-flash`.
  - Windows Python 3.13 pip encountered TLS handshake resets (`ConnectionResetError 10054`) on `files.pythonhosted.org` when installing `google-genai` due to `truststore` handling; resolved via `--use-deprecated=legacy-certs`.
- **Solution:**
  - Implemented dynamic runtime toggle in `bot/bot.py` via `LLM_PROVIDER` (`groq` vs `gemini`) and `GEMINI_MODEL`.
  - Updated default model to `gemini-3.8-flash`.
  - Added full fallback structure and startup logging (`[Bot] Active LLM Provider: ...`).

---

### 9. Persistent Browser Microphone Permission Prompt Across Calls
- **Symptom:** Every time the user switched voices or initiated a subsequent call after clicking "End Call", the browser repeatedly prompted for microphone permissions.
- **Root Cause:**
  - Even though `app.js` cached `micStream` globally and disabled tracks on `endCall()`, calling `RTCPeerConnection.close()` automatically stops all attached `MediaStreamTrack` senders under the hood.
  - When a `MediaStreamTrack` is stopped, its `readyState` permanently transitions to `"ended"` and cannot be revived.
  - On the next `startCall()`, `getOrCreateMicStream()` detected `readyState !== "live"` and was forced to execute `navigator.mediaDevices.getUserMedia()`, prompting the user anew.
- **Solution:**
  - In `frontend/src/app.js`, clone the audio track via `track.clone()` before attaching it to `pc.addTrack(clone, micStream)`.
  - When `pc.close()` stops the cloned track at the end of a session, the master track in `micStream` remains alive and untouched.
  - The browser requests microphone permission only once upon initial user action.

---

## LLM Provider Benchmark & Comparative Analysis (Groq vs. Gemini)

To determine the optimal default LLM provider for real-time voice conversations, live calls were executed and benchmarked under identical network conditions and pipeline configurations (Deepgram STT & TTS).

### 1. Empirical Latency Metrics

| Metric | **Groq** (`qwen/qwen3.8-27b`) | **Google Gemini** (`gemini-3.8-flash`) | Variance / Winner |
|---|---|---|---|
| **Average LLM Latency** | **682 ms** (~0.68s) | **6,183 ms** (~6.18s) | **Groq (9.1x faster)** |
| **Median LLM Latency** | **670 ms** | **5,940 ms** | **Groq** |
| **Minimum Turn Latency** | **354 ms** | **1,481 ms** | **Groq (4.2x faster)** |
| **Maximum Turn Latency** | **1,198 ms** | **10,837 ms** (~10.8s) | **Groq (9.0x faster)** |
| **Evaluated Sample** | 25 turns across 3 calls | 10 turns across 2 calls | — |
| **Average Deepgram TTS Latency** | **~357 ms** | **~359 ms** | Identical |
| **Total Voice Turnaround (STT+LLM+TTS)** | **~1.3s – 1.5s** | **~6.8s – 11.5s** | **Groq delivers conversational flow** |

### 2. Transcript & Conversational Dynamics

* **Conversational Flow & Dead-Air:**
  - In conversational voice interfaces, latency exceeding **1,200 ms** introduces perceptible hesitation, and delays past **2,000 ms** cause users to assume the connection dropped.
  - **Groq:** Responses arrived in ~500–700 ms. The back-and-forth cadence mirrored natural human interaction without dead-air.
  - **Gemini:** Average response latency of **6.2 seconds** (with peaks up to **10.8 seconds**) created severe conversational friction. Reviewing transcripts revealed that the user frequently said *"Hello?"* or re-prompted due to the long pauses.
* **Turn Collisions & Cut-Offs:**
  - Because of Gemini's latency gap, the user often resumed speaking just as Gemini's first audio chunk arrived from TTS, triggering barge-in interruptions that truncated Gemini's answers mid-sentence (e.g. `"...or roughly 56 grams for [cut off]"`).
* **Adherence to Voice Constraints:**
  - **Groq (`qwen/qwen3.8-27b`):** Consistently obeyed the voice system instruction (*"Keep responses short — 1-2 sentences max"*), delivering tight, punchy answers (e.g. *"Two plus two is four"*, *"There are seven days in a week"*).
  - **Gemini (`gemini-3.8-flash`):** Delivered detailed, high-quality reasoning, but tended toward longer prose less suited for rapid audio delivery unless explicitly trimmed.

### 3. Production Recommendation: Default Choice

> **Decision: Groq (`qwen/qwen3.8-27b`) remains the default provider (`LLM_PROVIDER=groq`).**

- **Why Groq:** Sub-700ms Time-To-First-Token (TTFT) is critical for voice agents. Groq's LPU inference enables real-time duplex speech without jarring latency.
- **Role of Gemini:** Gemini is retained as an opt-in toggle (`LLM_PROVIDER=gemini`) for tasks demanding complex multi-step reasoning where latency can be traded for knowledge depth. For voice agents to match Groq-level speeds with Gemini, the direct bidirectional WebSocket protocol (**Gemini Live Multimodal API**) should be utilized rather than standard REST/HTTP chat completions.

---

## Verification & Current System Status

In the latest verified call (Call `6c028284-aed9-4e78-9096-054c11b8f5f0`):
- **Call Duration:** 156 seconds
- **Conversation Turns:** 9 full turns successfully recorded
- **Avg LLM Latency:** ~650 ms
- **Avg TTS Latency:** ~345 ms
- **Persistence:** Successfully written to Cloudflare D1 across `calls`, `transcripts`, and `call_metrics` tables.
- **Worker Response:** `HTTP 201 Created`

