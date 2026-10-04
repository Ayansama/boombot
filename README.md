# boombot — Mini Call Log Service

A real-time AI voice agent with persistent call logging. Speak into your browser, get a live response from an LLM, and have every call — transcript, duration, and latency metrics — automatically saved to a cloud database.

---

## Architecture

```
Browser (WebRTC)
    │
    ├─── Audio In/Out ──► bot/bot.py  (Python · Pipecat 1.12.0)
    │                          │
    │                    ┌─────▼──────┐
    │                    │  Pipeline  │
    │                    │  STT  →  Deepgram Live
    │                    │  LLM  →  Groq (default) / Gemini (opt-in)
    │                    │  TTS  →  Deepgram Aura
    │                    └─────┬──────┘
    │                          │ POST /calls
    └─── UI ──► frontend/      ▼
                (Cloudflare  worker/src/index.js
                 Pages)       (Cloudflare Worker + D1 SQLite)
```

| Layer | Technology |
|---|---|
| Voice Pipeline | Python, [Pipecat 1.12.0](https://github.com/pipecat-ai/pipecat), `SmallWebRTCTransport` |
| STT | Deepgram Live Transcription |
| LLM | Groq (`qwen/qwen3.8-27b`) · Google Gemini (`gemini-3.8-flash`) |
| TTS | Deepgram Aura 2 (`asteria`, `athena`, `mars`) |
| Backend API | Cloudflare Worker (JavaScript) |
| Database | Cloudflare D1 (SQLite) |
| Frontend | Vanilla JS, Cloudflare Pages |
| CI/CD | GitHub Actions → Wrangler |

---

## Project Structure

```
boombot/
├── bot/
│   ├── bot.py              # Voice pipeline + WebRTC signaling server
│   ├── requirements.txt
│   ├── .env.example
│   └── venv/
│
├── worker/
│   ├── src/index.js        # Cloudflare Worker REST API
│   ├── migrations/
│   │   └── 0001_init.sql   # D1 schema (calls, transcripts, call_metrics)
│   ├── wrangler.toml
│   └── package.json
│
├── frontend/
│   └── src/
│       ├── index.html      # UI (voice controls, call history, detail modal)
│       └── app.js          # WebRTC client + Worker API calls
│
└── .github/workflows/
    └── deploy.yml          # CI: D1 migrations → Worker deploy → Pages deploy
```

---

## Prerequisites

- Python 3.11+
- Node.js 18+ (for Wrangler)
- A [Cloudflare account](https://cloudflare.com) with Workers and D1 enabled
- API keys for Deepgram and Groq (and optionally Google Gemini)

---

## Setup

### 1. Bot (Python voice pipeline)

```bash
cd bot
python -m venv venv

# Windows
venv\Scripts\activate
# macOS / Linux
source venv/bin/activate

pip install -r requirements.txt
```

Copy the example env file and fill in your keys:

```bash
cp .env.example .env
```

```env
DEEPGRAM_API_KEY=your_deepgram_api_key
GROQ_API_KEY=your_groq_api_key
GEMINI_API_KEY=your_gemini_api_key     # optional
GEMINI_MODEL=gemini-3.8-flash          # optional
LLM_PROVIDER=groq                      # "groq" or "gemini"
WORKER_URL=http://localhost:8787       # or your deployed Worker URL
```

Start the signaling server:

```bash
python bot.py
# Listening on http://localhost:7860
```

### 2. Worker (Cloudflare backend)

```bash
cd worker
npm install
```

Create a D1 database and update `wrangler.toml` with the returned `database_id`:

```bash
npx wrangler d1 create call-log-db
```

Apply the schema locally:

```bash
npm run d1:init
```

Run the Worker locally:

```bash
npm run dev
# Listening on http://localhost:8787
```

### 3. Frontend

Open `frontend/src/index.html` directly in your browser, or serve it with any static server. The `BOT_URL` and `WORKER_URL` constants at the top of `app.js` point to `localhost` by default.

---

## Deployment

Set the following repository secrets in GitHub:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Worker + Pages + D1 access |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

Push to `main` or `master`. The workflow in `.github/workflows/deploy.yml` will:

1. Apply D1 migrations to the remote database.
2. Deploy the Worker API.
3. Deploy the frontend to Cloudflare Pages.

Update `BOT_URL` in `frontend/src/app.js` to wherever your Python bot is publicly hosted (e.g. a VPS or tunnel), and `WORKER_URL` to your deployed Worker URL.

---

## API Reference

The Cloudflare Worker exposes three endpoints:

### `POST /calls`
Save a completed call. Called automatically by the bot at the end of each session.

**Body:**
```json
{
  "call_id": "uuid",
  "start_time": "ISO 8601",
  "end_time": "ISO 8601",
  "duration": 42,
  "transcript": [
    { "role": "user" | "bot", "content": "...", "timestamp": "ISO 8601" }
  ],
  "metrics": [
    { "turn_index": 0, "stt_latency": null, "llm_latency": 682, "tts_latency": 357 }
  ]
}
```

**Response:** `201 Created`

---

### `GET /calls`
Returns all calls, newest first.

```json
[
  { "id": "...", "start_time": "...", "end_time": "...", "duration": 42, "created_at": "..." }
]
```

---

### `GET /calls/:id`
Returns a single call with its full transcript and per-turn metrics.

```json
{
  "id": "...",
  "duration": 42,
  "transcript": [...],
  "metrics": [...]
}
```

---

## Voice Options

Three Deepgram Aura 2 voices are available and can be selected before each call:

| Key | Model |
|---|---|
| `asteria` | `aura-2-asteria-en` (default) |
| `athena` | `aura-2-athena-en` |
| `mars` | `aura-2-mars-en` |

Voice is locked for the duration of a call and unlocked when the call ends.

---

## LLM Providers

Toggle the provider with the `LLM_PROVIDER` environment variable.

| Provider | Model | Avg LLM Latency | Notes |
|---|---|---|---|
| `groq` (default) | `qwen/qwen3.8-27b` | ~680 ms | Best for real-time voice; sub-700ms TTFT |
| `gemini` | `gemini-3.8-flash` | ~6,200 ms | Richer reasoning; not recommended for voice |

Groq is the default. Gemini is available as an opt-in for tasks where reasoning depth outweighs latency requirements.

---

## Database Schema

```sql
-- A completed call session
CREATE TABLE calls (
  id         TEXT PRIMARY KEY,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL,
  duration   INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Ordered transcript turns
CREATE TABLE transcripts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id   TEXT NOT NULL REFERENCES calls(id),
  role      TEXT NOT NULL CHECK(role IN ('user', 'bot')),
  content   TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

-- Per-turn latency telemetry
CREATE TABLE call_metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id     TEXT NOT NULL REFERENCES calls(id),
  turn_index  INTEGER,
  stt_latency INTEGER,
  llm_latency INTEGER,
  tts_latency INTEGER
);
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DEEPGRAM_API_KEY` | ✅ | — | Deepgram API key (STT + TTS) |
| `GROQ_API_KEY` | ✅ | — | Groq API key |
| `GEMINI_API_KEY` | ➖ | — | Google Gemini API key |
| `GEMINI_MODEL` | ➖ | `gemini-3.8-flash` | Gemini model name |
| `LLM_PROVIDER` | ➖ | `groq` | `groq` or `gemini` |
| `WORKER_URL` | ➖ | `http://localhost:8787` | Base URL of the Cloudflare Worker |
