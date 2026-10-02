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

## Verification & Current System Status

In the latest verified call (Call `6c028284-aed9-4e78-9096-054c11b8f5f0`):
- **Call Duration:** 156 seconds
- **Conversation Turns:** 9 full turns successfully recorded
- **Avg LLM Latency:** ~650 ms
- **Avg TTS Latency:** ~345 ms
- **Persistence:** Successfully written to Cloudflare D1 across `calls`, `transcripts`, and `call_metrics` tables.
- **Worker Response:** `HTTP 201 Created`
