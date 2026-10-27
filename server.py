"""AWS/RDS Graphshot server: rCTF teams, timed rounds, bots and authoritative volleys."""
from __future__ import annotations
import asyncio
import json
import math
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlencode

import asyncpg
import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse

from engine import Player, arena, bot_equation, compile_equation, resolve_volley

ROOT = Path(__file__).parent


def _load_env_file():
    """Load key-value pairs from .env if present without overwriting existing environment."""
    env_path = ROOT / ".env"
    if env_path.exists():
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip("'\"")
                    if k and k not in os.environ:
                        os.environ[k] = v
        except Exception:
            pass


_load_env_file()

DATABASE_URL = os.getenv("DATABASE_URL", "")
RCTF_BASE_URL = os.getenv("RCTF_BASE_URL", "").rstrip("/")
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:3000").rstrip("/")
RCTF_CLIENT_ID = os.getenv("RCTF_CLIENT_ID", "")
RCTF_CLIENT_SECRET = os.getenv("RCTF_CLIENT_SECRET", "")
PERIOD = int(os.getenv("ROUND_PERIOD_SECONDS", "300"))
ENTRY = int(os.getenv("ENTRY_WINDOW_SECONDS", "60"))
CODING = int(os.getenv("CODING_SECONDS", "120"))
SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
DEV_AUTH = os.getenv("DEV_AUTH", "false").lower() == "true" or not RCTF_BASE_URL
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "3000"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS gs_sessions(
    id UUID PRIMARY KEY,
    team_id TEXT NOT NULL,
    team_name TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS gs_rounds(
    uid UUID PRIMARY KEY,
    slot BIGINT UNIQUE NOT NULL,
    opens_at TIMESTAMPTZ NOT NULL,
    entry_closes_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'entry'
);
CREATE TABLE IF NOT EXISTS gs_seats(
    team_id TEXT PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES gs_sessions(id),
    round_uid UUID NOT NULL REFERENCES gs_rounds(uid),
    state TEXT NOT NULL DEFAULT 'queued',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gs_matches(
    id UUID PRIMARY KEY,
    round_uid UUID NOT NULL REFERENCES gs_rounds(uid),
    state TEXT NOT NULL DEFAULT 'coding',
    coding_ends_at TIMESTAMPTZ NOT NULL,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gs_match_players(
    match_id UUID NOT NULL REFERENCES gs_matches(id),
    slot INT NOT NULL,
    team_id TEXT,
    team_name TEXT NOT NULL,
    rating INT NOT NULL DEFAULT 1000,
    is_bot BOOLEAN NOT NULL DEFAULT false,
    equation TEXT,
    PRIMARY KEY(match_id, slot)
);
CREATE TABLE IF NOT EXISTS gs_ratings(
    team_id TEXT PRIMARY KEY,
    rating INT NOT NULL DEFAULT 1000,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


async def me(req: Request):
    """Authenticate via Authorization Bearer token or gs_session cookie."""
    auth_header = req.headers.get("authorization", "")
    token = ""
    if auth_header:
        parts = auth_header.split(None, 1)
        if len(parts) == 2 and parts[0].lower() == "bearer":
            token = parts[1].strip()
        else:
            token = auth_header.strip()
    if not token:
        token = req.cookies.get("gs_session", "").strip()

    try:
        sid = uuid.UUID(token)
    except (ValueError, TypeError):
        raise HTTPException(401, "Sign in with rCTF first")

    db = req.app.state.db
    row = await db.fetchrow(
        "SELECT id, team_id, team_name FROM gs_sessions WHERE id=$1 AND expires_at>now()",
        sid,
    )
    if not row:
        raise HTTPException(401, "Session expired")
    return row


async def round_now(db):
    now_ts = time.time()
    slot = int(now_ts) // PERIOD
    opening = slot * PERIOD
    closes = opening + ENTRY
    uid = uuid.uuid5(uuid.NAMESPACE_URL, f"graphshot:{slot}")
    await db.execute(
        "INSERT INTO gs_rounds(uid,slot,opens_at,entry_closes_at) VALUES($1,$2,to_timestamp($3),to_timestamp($4)) ON CONFLICT(slot) DO NOTHING",
        uid,
        slot,
        opening,
        closes,
    )
    row = await db.fetchrow("SELECT * FROM gs_rounds WHERE slot=$1", slot)
    # If the current slot has already closed or launched, prepare and return the next round
    if row and (row["status"] != "entry" or row["entry_closes_at"].timestamp() < now_ts):
        next_slot = slot + 1
        next_opening = next_slot * PERIOD
        next_closes = next_opening + ENTRY
        next_uid = uuid.uuid5(uuid.NAMESPACE_URL, f"graphshot:{next_slot}")
        await db.execute(
            "INSERT INTO gs_rounds(uid,slot,opens_at,entry_closes_at) VALUES($1,$2,to_timestamp($3),to_timestamp($4)) ON CONFLICT(slot) DO NOTHING",
            next_uid,
            next_slot,
            next_opening,
            next_closes,
        )
        return await db.fetchrow("SELECT * FROM gs_rounds WHERE slot=$1", next_slot)
    return row


async def rating(db, team: str) -> int:
    val = await db.fetchval("SELECT rating FROM gs_ratings WHERE team_id=$1", team)
    return int(val) if val is not None else 1000


async def launch(db, uid: uuid.UUID) -> list[str]:
    rows = await db.fetch(
        "SELECT s.team_id, t.team_name FROM gs_seats s JOIN gs_sessions t ON t.id=s.session_id WHERE s.round_uid=$1 AND s.state='queued' ORDER BY s.created_at FOR UPDATE",
        uid,
    )
    made: list[str] = []
    for start in range(0, len(rows), 10):
        group = rows[start : start + 10]
        if not group:
            continue
        mid = uuid.uuid4()
        await db.execute(
            "INSERT INTO gs_matches(id,round_uid,coding_ends_at) VALUES($1,$2,now()+$3*interval '1 second')",
            mid,
            uid,
            CODING,
        )
        ratings = []
        for slot, p in enumerate(group):
            r = await rating(db, p["team_id"])
            ratings.append(r)
            await db.execute(
                "INSERT INTO gs_match_players(match_id,slot,team_id,team_name,rating) VALUES($1,$2,$3,$4,$5)",
                mid,
                slot,
                p["team_id"],
                p["team_name"],
                r,
            )
        average = round(sum(ratings) / len(ratings)) if ratings else 1000
        for slot in range(len(group), 10):
            await db.execute(
                "INSERT INTO gs_match_players(match_id,slot,team_name,rating,is_bot,equation) VALUES($1,$2,$3,$4,true,$5)",
                mid,
                slot,
                f"bot-{slot+1}",
                average,
                bot_equation(average),
            )
        await db.execute(
            "UPDATE gs_seats SET state='matched' WHERE round_uid=$1 AND team_id=ANY($2::text[])",
            uid,
            [x["team_id"] for x in group],
        )
        made.append(str(mid))
    await db.execute("UPDATE gs_rounds SET status='launched' WHERE uid=$1", uid)
    return made


async def finish(db, mid: uuid.UUID):
    match = await db.fetchrow("SELECT * FROM gs_matches WHERE id=$1 FOR UPDATE", mid)
    if not match or match["state"] != "coding":
        return
    rows = await db.fetch(
        "SELECT * FROM gs_match_players WHERE match_id=$1 ORDER BY slot", mid
    )
    ps = arena(
        [
            Player(str(r["slot"]), r["team_name"], r["rating"], r["is_bot"])
            for r in rows
        ]
    )
    submissions = {str(r["slot"]): r["equation"] for r in rows if r["equation"]}
    result = resolve_volley(ps, submissions)
    human = [p for p in result["players"] if not p["bot"]]
    avg = sum(p["score"] for p in human) / max(1, len(human))
    for p, row in zip(result["players"], rows):
        if p["bot"] or not row["team_id"]:
            continue
        delta = max(-32, min(32, round((p["score"] - avg) / 12)))
        await db.execute(
            "INSERT INTO gs_ratings(team_id,rating) VALUES($1,1000+$2) ON CONFLICT(team_id) DO UPDATE SET rating=gs_ratings.rating+$2,updated_at=now()",
            row["team_id"],
            delta,
        )
        await db.execute("DELETE FROM gs_seats WHERE team_id=$1", row["team_id"])
    await db.execute(
        "UPDATE gs_matches SET state='finished',result=$2 WHERE id=$1",
        mid,
        json.dumps(result),
    )


async def clock(app: FastAPI):
    while True:
        try:
            await asyncio.sleep(1)
            db = getattr(app.state, "db", None)
            if not db:
                continue
            await round_now(db)
            rounds = await db.fetch(
                "SELECT uid FROM gs_rounds WHERE status='entry' AND entry_closes_at<=now()"
            )
            for r in rounds:
                async with db.acquire() as c:
                    async with c.transaction():
                        await launch(c, r["uid"])
            matches = await db.fetch(
                "SELECT id FROM gs_matches WHERE state='coding' AND coding_ends_at<=now()"
            )
            for m_row in matches:
                async with db.acquire() as c:
                    async with c.transaction():
                        await finish(c, m_row["id"])
        except asyncio.CancelledError:
            break
        except Exception as e:
            # Prevent background clock failure from crashing server
            await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not hasattr(app.state, "db") or app.state.db is None:
        if not DATABASE_URL:
            raise RuntimeError(
                "DATABASE_URL is not set. Please configure DATABASE_URL in your environment or .env file."
            )
        app.state.db = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=10)
        async with app.state.db.acquire() as c:
            await c.execute(SCHEMA)

    task = asyncio.create_task(clock(app))
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    if hasattr(app.state, "db") and app.state.db is not None:
        if hasattr(app.state.db, "close"):
            await app.state.db.close()


app = FastAPI(title="Graphshot", lifespan=lifespan)


@app.get("/")
async def home():
    index_file = ROOT / "public" / "index.html"
    if not index_file.exists():
        raise HTTPException(404, "index.html not found")
    return FileResponse(index_file)


@app.get("/solo")
@app.get("/solo.html")
async def solo():
    solo_file = ROOT / "public" / "solo.html"
    if not solo_file.exists():
        raise HTTPException(404, "solo.html not found")
    return FileResponse(solo_file)


@app.get("/auth/rctf/login")
async def login():
    if not RCTF_BASE_URL or not RCTF_CLIENT_ID:
        if DEV_AUTH:
            return RedirectResponse("/auth/dev/login?team=Team1")
        raise HTTPException(500, "rCTF authentication is not configured")
    state = secrets.token_urlsafe(24)
    callback = f"{APP_BASE_URL}/auth/rctf/callback"
    q = urlencode(
        {"client_id": RCTF_CLIENT_ID, "redirect_uri": callback, "state": state}
    )
    res = RedirectResponse(f"{RCTF_BASE_URL}/external-auth/authorize?{q}")
    res.set_cookie(
        "gs_state",
        state,
        httponly=True,
        secure=SECURE,
        samesite="lax",
        max_age=300,
    )
    return res


@app.get("/auth/rctf/callback")
async def callback(req: Request, code: str, state: str):
    if not secrets.compare_digest(state, req.cookies.get("gs_state", "")):
        raise HTTPException(400, "Invalid login state")
    async with httpx.AsyncClient(timeout=10) as h:
        token = await h.post(
            f"{RCTF_BASE_URL}/api/v2/external-auth/token",
            json={
                "clientId": RCTF_CLIENT_ID,
                "clientSecret": RCTF_CLIENT_SECRET,
                "code": code,
            },
        )
        token.raise_for_status()
        access = token.json()["data"]["accessToken"]
        profile = await h.get(
            f"{RCTF_BASE_URL}/api/v2/users/me",
            headers={"Authorization": f"Bearer {access}"},
        )
        profile.raise_for_status()
        team = profile.json()["data"]
    sid = uuid.uuid4()
    await req.app.state.db.execute(
        "INSERT INTO gs_sessions VALUES($1,$2,$3,now()+interval '8 hours')",
        sid,
        str(team["id"]),
        team["name"],
    )
    res = RedirectResponse("/")
    res.set_cookie(
        "gs_session",
        str(sid),
        httponly=True,
        secure=SECURE,
        samesite="lax",
        max_age=28800,
    )
    return res


@app.get("/auth/dev/login")
async def dev_login(req: Request, team: str = "coder"):
    """Local development login helper enabled when DEV_AUTH=true."""
    if not DEV_AUTH:
        raise HTTPException(403, "Dev authentication is disabled")
    clean_name = "".join(c for c in team if c.isalnum() or c in " _-")[:24] or "coder"
    team_id = f"dev-{clean_name.lower().replace(' ', '-')}"
    sid = uuid.uuid4()
    await req.app.state.db.execute(
        "INSERT INTO gs_sessions VALUES($1,$2,$3,now()+interval '8 hours')",
        sid,
        team_id,
        clean_name,
    )
    res = RedirectResponse("/")
    res.set_cookie(
        "gs_session",
        str(sid),
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=28800,
    )
    return res


@app.post("/api/bot/session")
async def bot_session(req: Request):
    auth = req.headers.get("authorization", "")
    if DEV_AUTH and (not RCTF_BASE_URL or not auth or auth == "Bearer dev"):
        body = {}
        try:
            body = await req.json()
        except Exception:
            pass
        name = body.get("name", "bot-team")
        team_id = f"bot-{name.lower().replace(' ', '-')}"
        sid = uuid.uuid4()
        await req.app.state.db.execute(
            "INSERT INTO gs_sessions VALUES($1,$2,$3,now()+interval '8 hours')",
            sid,
            team_id,
            name,
        )
        return {"accessToken": str(sid), "team": name}

    if not RCTF_BASE_URL:
        raise HTTPException(500, "rCTF authentication is not configured")
    async with httpx.AsyncClient(timeout=10) as h:
        r = await h.get(
            f"{RCTF_BASE_URL}/api/v2/users/me", headers={"Authorization": auth}
        )
        r.raise_for_status()
        team = r.json()["data"]
    sid = uuid.uuid4()
    await req.app.state.db.execute(
        "INSERT INTO gs_sessions VALUES($1,$2,$3,now()+interval '8 hours')",
        sid,
        str(team["id"]),
        team["name"],
    )
    return {"accessToken": str(sid), "team": team["name"]}


@app.get("/api/me")
async def who(req: Request):
    t = await me(req)
    db = req.app.state.db
    team_rating = await rating(db, t["team_id"])
    active_match = await db.fetchrow(
        """
        SELECT m.id, m.state, m.round_uid
        FROM gs_matches m
        JOIN gs_match_players p ON p.match_id = m.id
        WHERE p.team_id = $1 AND (m.state = 'coding' OR m.created_at > now() - interval '3 minutes')
        ORDER BY m.created_at DESC LIMIT 1
        """,
        t["team_id"],
    )
    seat = await db.fetchrow(
        "SELECT round_uid, state FROM gs_seats WHERE team_id = $1",
        t["team_id"],
    )
    return {
        "teamId": t["team_id"],
        "teamName": t["team_name"],
        "rating": team_rating,
        "oneComputerPerTeam": True,
        "devMode": DEV_AUTH,
        "activeMatchId": str(active_match["id"]) if active_match else None,
        "matchState": active_match["state"] if active_match else None,
        "seatState": seat["state"] if seat else None,
        "seatRoundUid": str(seat["round_uid"]) if seat else None,
    }


@app.get("/api/rounds/current")
async def current(req: Request):
    r = await round_now(req.app.state.db)
    close_ts = r["entry_closes_at"].timestamp()
    now_ts = time.time()
    return {
        "uid": str(r["uid"]),
        "status": r["status"],
        "entryClosesAt": r["entry_closes_at"].isoformat() if hasattr(r["entry_closes_at"], "isoformat") else str(r["entry_closes_at"]),
        "period": PERIOD,
        "entryWindow": ENTRY,
        "secondsUntilClose": max(0, int(close_ts - now_ts)),
    }


@app.post("/api/rounds/current/join")
async def join(req: Request):
    t = await me(req)
    db = req.app.state.db
    r = await round_now(db)
    if r["status"] != "entry" or r["entry_closes_at"].timestamp() < time.time():
        raise HTTPException(409, "Entry window is closed")

    # Clean up any stale seat from old finished rounds
    old_seat = await db.fetchrow("SELECT round_uid, state FROM gs_seats WHERE team_id=$1", t["team_id"])
    if old_seat:
        if old_seat["round_uid"] != r["uid"]:
            await db.execute("DELETE FROM gs_seats WHERE team_id=$1", t["team_id"])
        else:
            return {"roundUid": str(r["uid"]), "queued": True, "alreadyJoined": True}

    try:
        await db.execute(
            "INSERT INTO gs_seats(team_id,session_id,round_uid) VALUES($1,$2,$3)",
            t["team_id"],
            t["id"],
            r["uid"],
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "One active computer per rCTF team")
    return {"roundUid": str(r["uid"]), "queued": True}


@app.post("/api/rounds/current/launch-now")
async def launch_now(req: Request):
    t = await me(req)
    db = req.app.state.db
    r = await round_now(db)
    yes = await db.fetchval(
        "SELECT EXISTS(SELECT 1 FROM gs_seats WHERE team_id=$1 AND round_uid=$2 AND state='queued')",
        t["team_id"],
        r["uid"],
    )
    if not yes:
        # Check if already matched
        already = await db.fetchrow(
            """
            SELECT m.id FROM gs_matches m
            JOIN gs_match_players p ON p.match_id = m.id
            WHERE p.team_id = $1 AND m.state = 'coding'
            ORDER BY m.created_at DESC LIMIT 1
            """,
            t["team_id"],
        )
        if already:
            return {"matches": [str(already["id"])], "alreadyStarted": True}
        raise HTTPException(409, "Join first")

    async with db.acquire() as c:
        async with c.transaction():
            ids = await launch(c, r["uid"])
    return {"matches": ids, "botsFillRemainingSeats": True}


@app.get("/api/matches/{mid}")
async def match_view(req: Request, mid: uuid.UUID):
    t = await me(req)
    db = req.app.state.db
    row = await db.fetchrow(
        "SELECT m.* FROM gs_matches m JOIN gs_match_players p ON p.match_id=m.id WHERE m.id=$1 AND p.team_id=$2",
        mid,
        t["team_id"],
    )
    if not row:
        raise HTTPException(404, "Match not found")
    players = await db.fetch(
        "SELECT slot, team_name, rating, is_bot, equation, team_id FROM gs_match_players WHERE match_id=$1 ORDER BY slot",
        mid,
    )
    is_finished = row["state"] == "finished"
    sanitized_players = []
    for p in players:
        p_dict = {
            "slot": p["slot"],
            "team_name": p["team_name"],
            "rating": p["rating"],
            "is_bot": p["is_bot"],
            "is_you": (p["team_id"] == t["team_id"]),
        }
        angle = (p["slot"] / 10.0) * 2 * math.pi - math.pi / 2
        p_dict["x"] = round(18.0 * math.cos(angle), 3)
        p_dict["y"] = round(18.0 * math.sin(angle), 3)
        p_dict["angle"] = round(angle + math.pi, 4)

        if is_finished or p["team_id"] == t["team_id"]:
            p_dict["equation"] = p["equation"]
        else:
            p_dict["equation"] = "locked" if p["equation"] else None

        sanitized_players.append(p_dict)

    result_data = row["result"]
    if isinstance(result_data, str):
        try:
            result_data = json.loads(result_data)
        except Exception:
            pass

    return {
        "id": str(mid),
        "state": row["state"],
        "codingEndsAt": row["coding_ends_at"].isoformat() if hasattr(row["coding_ends_at"], "isoformat") else str(row["coding_ends_at"]),
        "players": sanitized_players,
        "result": result_data,
    }


@app.post("/api/matches/{mid}/submit")
async def submit(req: Request, mid: uuid.UUID):
    t = await me(req)
    db = req.app.state.db
    match_row = await db.fetchrow("SELECT state FROM gs_matches WHERE id=$1", mid)
    if not match_row:
        raise HTTPException(404, "Match not found")
    if match_row["state"] != "coding":
        raise HTTPException(409, "Coding window has ended")

    body = await req.json()
    equation = body.get("equation", "")
    try:
        compile_equation(equation)
    except ValueError as e:
        raise HTTPException(422, str(e))

    changed = await db.execute(
        "UPDATE gs_match_players SET equation=$1 WHERE match_id=$2 AND team_id=$3",
        equation,
        mid,
        t["team_id"],
    )
    if changed.endswith("0"):
        raise HTTPException(404, "Match player not found")

    pending = await db.fetchval(
        "SELECT count(*) FROM gs_match_players WHERE match_id=$1 AND NOT is_bot AND equation IS NULL",
        mid,
    )
    if not pending:
        async with db.acquire() as c:
            async with c.transaction():
                await finish(c, mid)
    return {"accepted": True, "firesNow": not pending}


@app.get("/api/leaderboard")
async def leaderboard(req: Request):
    rows = await req.app.state.db.fetch(
        "SELECT team_id, rating FROM gs_ratings ORDER BY rating DESC LIMIT 100"
    )
    return {"teams": [dict(x) for x in rows]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host=HOST, port=PORT, reload=False)
