CREATE TABLE IF NOT EXISTS calls (
  id         TEXT PRIMARY KEY,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL,
  duration   INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transcripts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id   TEXT NOT NULL REFERENCES calls(id),
  role      TEXT NOT NULL CHECK(role IN ('user', 'bot')),
  content   TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS call_metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id     TEXT NOT NULL REFERENCES calls(id),
  turn_index  INTEGER,
  stt_latency INTEGER,
  llm_latency INTEGER,
  tts_latency INTEGER
);