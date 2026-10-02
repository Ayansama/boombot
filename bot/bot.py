import asyncio
import uuid
import time
import os
import httpx
from datetime import datetime, timezone
from dotenv import load_dotenv
from aiohttp import web

import numpy as np
from deepgram.listen.v1.types import ListenV1Results
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.groq.llm import GroqLLMService
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport, TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_start import VADUserTurnStartStrategy, TranscriptionUserTurnStartStrategy
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.frames.frames import (
    EndFrame, CancelFrame, TranscriptionFrame, LLMTextFrame, TTSAudioRawFrame, InterruptionFrame, TTSSpeakFrame, InputAudioRawFrame
)

load_dotenv()


# POST call data to Worker on call end
async def post_call_to_worker(
    call_id: str,
    start_time: str,
    end_time: str,
    duration: int,
    transcript: list,
    metrics: list,
):
    payload = {
        "call_id":    call_id,
        "start_time": start_time,
        "end_time":   end_time,
        "duration":   duration,
        "transcript": transcript,
        "metrics":    metrics,
    }
    worker_url = os.getenv("WORKER_URL", "http://localhost:8787")
    async with httpx.AsyncClient() as client:
        try:
            r = await client.post(f"{worker_url}/calls", json=payload, timeout=10)
            print(f"[Worker] POST /calls → {r.status_code}")
        except Exception as e:
            print(f"[Worker] Failed to post: {e}")


# State container for a single call session
class CallSession:
    def __init__(self, call_id: str, start_time: str):
        self.call_id = call_id
        self.start_time = start_time
        self.transcript = []
        self.metrics = []
        self.turn_index = 0
        self._llm_start = None
        self._tts_start = None
        self._current_llm_latency = None

    def record_user_speech(self, text: str):
        text = text.strip()
        if not text:
            return
        if self.transcript and self.transcript[-1]["role"] == "user":
            self.transcript[-1]["content"] += " " + text
        else:
            self.transcript.append({
                "role":      "user",
                "content":   text,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
        print(f"\n[User] {text}")
        self._llm_start = time.time()

    def record_llm_text(self, text: str):
        if not text:
            return
        if self._llm_start:
            self._current_llm_latency = int((time.time() - self._llm_start) * 1000)
            self._llm_start = None
        if not self._tts_start:
            self._tts_start = time.time()

        if self.transcript and self.transcript[-1]["role"] == "bot":
            self.transcript[-1]["content"] += text
        else:
            self.transcript.append({
                "role":      "bot",
                "content":   text,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
        print(f"[Bot] {text}", end="", flush=True)

    def record_tts_audio(self):
        if self._tts_start:
            tts_latency = int((time.time() - self._tts_start) * 1000)
            self.metrics.append({
                "turn_index":  self.turn_index,
                "stt_latency": None,
                "llm_latency": self._current_llm_latency,
                "tts_latency": tts_latency,
            })
            self.turn_index += 1
            self._tts_start = None
            self._current_llm_latency = None
            print()

    def handle_interruption(self):
        self._llm_start = None
        self._tts_start = None
        self._current_llm_latency = None


# Logger frame processors placed at exact points in the pipeline
class AudioInputMonitor(FrameProcessor):
    def __init__(self):
        super().__init__(enable_direct_mode=True)
        self._count = 0

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self._count += 1
            if self._count % 50 == 1:
                arr = np.frombuffer(frame.audio, dtype=np.int16)
                max_amp = int(np.max(np.abs(arr))) if len(arr) > 0 else 0
                print(f"[Mic Audio] Frame #{self._count}, size={len(frame.audio)}, max_amp={max_amp}")
        await self.push_frame(frame, direction)


class DiagnosticDeepgramSTTService(DeepgramSTTService):
    async def _on_message(self, message):
        if isinstance(message, ListenV1Results):
            if message.channel and message.channel.alternatives:
                t = message.channel.alternatives[0].transcript
                if t:
                    print(f"[Deepgram STT] Alternative: '{t}' (is_final={message.is_final})")
        await super()._on_message(message)


class UserTranscriptLogger(FrameProcessor):
    def __init__(self, session: CallSession):
        super().__init__(enable_direct_mode=True)
        self.session = session

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            self.session.record_user_speech(frame.text)
        await self.push_frame(frame, direction)


class LLMResponseLogger(FrameProcessor):
    def __init__(self, session: CallSession):
        super().__init__(enable_direct_mode=True)
        self.session = session

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMTextFrame) and frame.text:
            self.session.record_llm_text(frame.text)
        elif isinstance(frame, InterruptionFrame):
            self.session.handle_interruption()
        await self.push_frame(frame, direction)


class TTSAudioLogger(FrameProcessor):
    def __init__(self, session: CallSession):
        super().__init__(enable_direct_mode=True)
        self.session = session

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSAudioRawFrame):
            self.session.record_tts_audio()
        elif isinstance(frame, InterruptionFrame):
            self.session.handle_interruption()
        await self.push_frame(frame, direction)


# Bot pipeline (one per WebRTC connection)
async def run_bot(connection: SmallWebRTCConnection):
    call_id    = str(uuid.uuid4())
    start_time = datetime.now(timezone.utc).isoformat()
    session    = CallSession(call_id=call_id, start_time=start_time)

    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        )
    )

    stt = DiagnosticDeepgramSTTService(api_key=os.getenv("DEEPGRAM_API_KEY"))
    llm = GroqLLMService(
        api_key=os.getenv("GROQ_API_KEY"),
        settings=GroqLLMService.Settings(
            model="qwen/qwen3.8-27b",
            system_instruction=(
                "You are a helpful voice assistant. "
                "Keep responses short — 1-2 sentences max."
            ),
        )
    )
    tts = DeepgramTTSService(
        api_key=os.getenv("DEEPGRAM_API_KEY"),
        settings=DeepgramTTSService.Settings(voice="aura-asteria-en")
    )

    context            = LLMContext()
    context_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(),
            empty_user_turn=None,
            user_turn_strategies=UserTurnStrategies(
                start=[VADUserTurnStartStrategy(), TranscriptionUserTurnStartStrategy()],
                stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.6)],
            ),
        ),
    )

    pipeline = Pipeline([
        transport.input(),
        AudioInputMonitor(),
        stt,
        UserTranscriptLogger(session),
        context_aggregator.user(),
        llm,
        LLMResponseLogger(session),
        tts,
        TTSAudioLogger(session),
        context_aggregator.assistant(),
        transport.output(),
    ])

    task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))

    posted = False

    async def finish_and_post():
        nonlocal posted
        if posted:
            return
        posted = True

        print(f"[Call {call_id[:8]}] Posting call data to Worker...")
        end      = datetime.now(timezone.utc).isoformat()
        start_dt = datetime.fromisoformat(start_time)
        end_dt   = datetime.fromisoformat(end)
        dur      = max(1, int((end_dt - start_dt).total_seconds()))

        # Fallback to context messages if transcript list is empty
        final_transcript = list(session.transcript)
        if not final_transcript:
            for msg in context.get_messages():
                role = msg.get("role")
                content = msg.get("content")
                if role in ("user", "assistant") and content:
                    final_transcript.append({
                        "role": "bot" if role == "assistant" else "user",
                        "content": str(content),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })

        await post_call_to_worker(
            call_id=call_id,
            start_time=start_time,
            end_time=end,
            duration=dur,
            transcript=final_transcript,
            metrics=session.metrics,
        )

    async def play_initial_greeting():
        # Wait until Deepgram TTS websocket is connected
        for _ in range(50):
            if getattr(tts, "_websocket", None) is not None:
                break
            await asyncio.sleep(0.1)
        await asyncio.sleep(0.3)
        greeting = "Hello! How can I help you today?"
        session.record_llm_text(greeting)
        await task.queue_frame(TTSSpeakFrame(greeting))

    async def handle_disconnect():
        # Allow any in-transit STT transcription to arrive, post data, then cancel pipeline
        await asyncio.sleep(0.6)
        await finish_and_post()
        try:
            await task.cancel()
        except Exception as e:
            print(f"[Call {call_id[:8]}] Error cancelling task: {e}")

    @transport.event_handler("on_client_connected")
    async def on_client_connected(t, client):
        print(f"[Call {call_id[:8]}] Client connected")
        asyncio.create_task(play_initial_greeting())

    @transport.event_handler("on_client_disconnected")
    async def on_disconnect(t, client):
        print(f"[Call {call_id[:8]}] Client disconnected")
        asyncio.create_task(handle_disconnect())

    runner = PipelineRunner()
    try:
        await runner.run(task)
    except asyncio.CancelledError:
        pass
    finally:
        await finish_and_post()


# HTTP signaling server (WebRTC offer/answer)
async def handle_offer(request):
    body       = await request.json()
    # Strip .local mDNS ICE candidates — aioice can't resolve them on Windows
    sdp_lines  = body["sdp"].splitlines()
    sdp_clean  = "\r\n".join(
        line for line in sdp_lines if not (".local" in line and line.startswith("a=candidate"))
    ) + "\r\n"
    connection = SmallWebRTCConnection()
    await connection.initialize(sdp=sdp_clean, type=body["type"])
    asyncio.ensure_future(run_bot(connection))
    answer = connection.get_answer()
    return web.json_response(answer, headers={
        "Access-Control-Allow-Origin": "*",
    })


async def handle_options(request):
    return web.Response(headers={
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    })


app = web.Application()
app.router.add_post("/offer",   handle_offer)
app.router.add_route("OPTIONS", "/offer", handle_options)

if __name__ == "__main__":
    print("[Bot] Starting signaling server on http://localhost:7860")
    web.run_app(app, host="0.0.0.0", port=7860)