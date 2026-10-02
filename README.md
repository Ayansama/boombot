# boombot — Mini Call Log Service

**boombot** is a real-time conversational voice assistant with an automated call logging and telemetry pipeline. Built with **Pipecat**, **WebRTC**, **Deepgram**, **Groq**, and **Cloudflare Workers + D1 SQLite**.

---

## Architecture Overview

```
                                  +---------------------------+
                                  |    Browser (Frontend)     |
                                  |   (Vanilla JS + WebRTC)   |
                                  +-------------+-------------+
                                                |
                               WebRTC Audio In  |  WebRTC Audio Out
                                                v
+-----------------------------------------------------------------------------------------+
|                                    boombot (Python)                                     |
|  +---------------------+    +--------------------+    +-----------------------------+   |
|  |    Deepgram STT     | -> |      Groq LLM      | -> |        Deepgram TTS         |   |
|  |  (Nova Transcription|    | (Fast LPU Inference|    |    (Aura Audio Synthesis)   |   |
|  +---------------------+    +--------------------+    +-----------------------------+   |
|                                       |                                                 |
|                        End-of-Call Telemetry Aggregator                                 |
+---------------------------------------+-------------------------------------------------+
                                        |
                            HTTP POST   | Call Metadata, Transcripts &
                            /calls      | Turn Latency Metrics
                                        v
                        +-------------------------------+
                        |   Cloudflare Worker Backend   |
                        |      + D1 SQLite Database     |
                        +-------------------------------+
```

---

## Features

- **Full-Duplex Voice Conversation**: Low-latency, bidirectional audio streaming using WebRTC (`aiortc` + `SmallWebRTC`).
- **Streaming Speech-to-Text**: Real-time voice transcription powered by Deepgram.
- **Ultra-Fast LLM Inference**: Conversational intelligence powered by Groq's high-speed inference engine.
- **Natural Voice Synthesis**: Low-latency text-to-speech powered by Deepgram Aura.
- **Automated Call Telemetry**: Automatically records call duration, timestamped conversation turns, and per-turn latency metrics (STT, LLM, TTS).
- **Interactive Call Log Dashboard**: View past calls, review transcripts, and inspect performance latency metrics.

---

## Project Structure

```text
mini-call-log/
├── bot/
│   ├── bot.py                  # Pipecat WebRTC bot and telemetry pipeline
│   ├── requirements.txt        # Pinned Python dependencies
│   └── .env.example            # Environment variable template
├── worker/
│   ├── src/
│   │   └── index.js            # Cloudflare Worker API router
│   ├── migrations/
│   │   └── 0001_init.sql       # D1 database schema
│   ├── wrangler.toml           # Worker & D1 database configuration
│   └── package.json            # Worker development scripts
├── frontend/
│   └── src/
│       ├── index.html          # Web interface & call dashboard
│       └── app.js              # WebRTC signaling, audio playback & API client
├── build_log.md                # Development history, resolved issues & root causes
└── README.md                   # Documentation and quickstart guide
```

---

## Getting Started

### 1. Cloudflare Worker (Backend & Database)

1. Navigate to the worker directory:
   ```bash
   cd worker
   ```
2. Initialize local D1 database schema:
   ```bash
   npx wrangler d1 execute call-log-db --local --file=migrations/0001_init.sql
   ```
3. Start the local worker server (runs on `http://127.0.0.1:8787`):
   ```bash
   npx wrangler dev
   ```

---

### 2. Python Bot (Voice Pipeline)

1. Navigate to the bot directory:
   ```bash
   cd bot
   ```
2. Create and activate a Python virtual environment:
   ```bash
   python -m venv venv
   # Windows:
   .\venv\Scripts\activate
   # Linux / macOS:
   source venv/bin/activate
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Configure environment variables:
   Copy `.env.example` to `.env` and provide your API keys:
   ```bash
   cp .env.example .env
   ```
   ```env
   DEEPGRAM_API_KEY=your_deepgram_api_key
   GROQ_API_KEY=your_groq_api_key
   CALL_LOG_API_URL=http://localhost:8787
   ```
5. Start the bot server (runs on `http://localhost:7860`):
   ```bash
   python bot.py
   ```

---

### 3. Frontend (Web Client)

Open [frontend/src/index.html](file:///c:/Projects/mini-call-log/frontend/src/index.html) in your browser or serve using any static web server:

```bash
# Example using Python:
cd frontend/src
python -m http.server 3000
```
Open `http://localhost:3000` in your browser. Click **Start Call** to begin talking with **boombot**.

---

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/calls` | `GET` | Retrieve list of all recorded calls |
| `/calls/:id` | `GET` | Retrieve call details with transcript turns and latency metrics |
| `/calls` | `POST` | Save completed call metadata, transcripts, and metrics |

---

## Database Schema (D1 SQLite)

- **`calls`**: `id` (UUID), `start_time`, `end_time`, `duration` (seconds), `created_at`.
- **`transcripts`**: `id`, `call_id` (FK), `role` (`user` \| `bot`), `content`, `timestamp`.
- **`call_metrics`**: `id`, `call_id` (FK), `turn_index`, `stt_latency` (ms), `llm_latency` (ms), `tts_latency` (ms).
