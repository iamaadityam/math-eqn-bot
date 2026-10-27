# Graphshot Online — Multiplayer Math Artillery Arena

Graphshot is a competitive, simultaneous-resolution multiplayer math artillery game. Players (or automated bots) program mathematical curve equations `f(x)` for their cannons arranged on a circular arena. When the coding phase ends, all cannons fire at once: shots follow their mathematical trajectories, and a player who is hit and destroyed ceases firing, invalidating any later beam collisions from their cannon.

Live link (Solo sandbox): [https://math-eqn-bot.vercel.app/](https://math-eqn-bot.vercel.app/)

---

## Architecture Overview

- **`server.py`**: Authoritative FastAPI server handling PostgreSQL storage, rCTF team authentication, round management, matchmaking, autorating, and match lifecycle.
- **`engine.py`**: Pure, deterministic combat and equation engine. Bounded parsing without `eval`/`exec`, implicit multiplication, resilient arithmetic, and simultaneous volley resolution.
- **`public/index.html`**: Multiplayer arena web client featuring real-time lobby polling, live trajectory aiming preview, circular arena canvas, animated volley beams, and live scoreboards.
- **`public/solo.html`**: Standalone single-player sandbox and 7-level derivative tutorial.
- **`bots/`**: Bot clients in Python (`bots/python_bot.py`) and Node.js (`bots/node_bot.mjs`) for automated tournament competition.
- **`tests/`**: Full test suites for engine physics and server integration.

---

## Getting Started

### 1. Prerequisites
- Python 3.10+
- (Optional) Node.js 20+ for the Node bot client
- (Production) PostgreSQL database & rCTF instance

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Configure Environment
Copy `.env.example` to `.env` and fill in your configuration:
```bash
cp .env.example .env
```

Key environment variables:
- `DATABASE_URL`: PostgreSQL connection string (e.g., AWS RDS or local Postgres).
- `RCTF_BASE_URL`: Base URL of your rCTF instance.
- `APP_BASE_URL`: Public URL of your Graphshot app (for OAuth callback).
- `RCTF_CLIENT_ID` / `RCTF_CLIENT_SECRET`: OAuth2 credentials configured in rCTF.
- `ROUND_PERIOD_SECONDS`: Time interval between round starts (default: `300`).
- `ENTRY_WINDOW_SECONDS`: Time window to reserve seats in a round (default: `60`).
- `CODING_SECONDS`: Time window to program cannon equations (default: `120`).
- `COOKIE_SECURE`: Set to `true` behind HTTPS; `false` for local HTTP.
- `DEV_AUTH`: Set to `true` to enable instant dev login without an external rCTF instance.

### 4. Run the Server
```bash
python server.py
```
Or via uvicorn:
```bash
uvicorn server:app --host 0.0.0.0 --port 3000
```

Visit [http://localhost:3000](http://localhost:3000) for the Multiplayer Arena, or [http://localhost:3000/solo](http://localhost:3000/solo) for the solo sandbox and tutorial.

### 5. Run the Bots
Automated bot clients can participate alongside human players:
- **Python Bot**: `python bots/python_bot.py`
- **Node.js Bot**: `node bots/node_bot.mjs`

### 6. Run Tests
```bash
python -m unittest discover tests
```

---

## Docker Deployment

To build and run in Docker:
```bash
docker build -t graphshot-server .
docker run -p 3000:3000 --env-file .env graphshot-server
```
