"""Integration tests for Graphshot server endpoints and game lifecycle."""
import asyncio
import json
import unittest
import uuid
from datetime import datetime, timezone, timedelta
from fastapi.testclient import TestClient
import server


class MockTransaction:
    async def __aenter__(self):
        return self
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass


class MockAcquire:
    def __init__(self, db):
        self.db = db
    async def __aenter__(self):
        return self.db
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        pass


class MockDB:
    def __init__(self):
        self.sessions = {}      # sid -> dict
        self.rounds = {}        # slot -> dict
        self.seats = {}         # team_id -> dict
        self.matches = {}       # mid -> dict
        self.match_players = {} # (mid, slot) -> dict
        self.ratings = {}       # team_id -> int

    def acquire(self):
        return MockAcquire(self)

    def transaction(self):
        return MockTransaction()

    async def execute(self, query: str, *args):
        q = query.strip()
        now = datetime.now(timezone.utc)
        if "INSERT INTO gs_rounds" in q:
            uid, slot, opens_at, closes_at = args
            if slot not in self.rounds:
                self.rounds[slot] = {
                    "uid": uid,
                    "slot": slot,
                    "opens_at": datetime.fromtimestamp(opens_at, tz=timezone.utc),
                    "entry_closes_at": datetime.fromtimestamp(closes_at, tz=timezone.utc),
                    "status": "entry",
                }
            return "INSERT 1"

        if "INSERT INTO gs_sessions" in q:
            sid, team_id, team_name = args[:3]
            self.sessions[sid] = {
                "id": sid,
                "team_id": str(team_id),
                "team_name": team_name,
                "expires_at": now + timedelta(hours=8),
            }
            return "INSERT 1"

        if "INSERT INTO gs_seats" in q:
            team_id, session_id, round_uid = args
            self.seats[team_id] = {
                "team_id": team_id,
                "session_id": session_id,
                "round_uid": round_uid,
                "state": "queued",
                "created_at": now,
            }
            return "INSERT 1"

        if "DELETE FROM gs_seats WHERE team_id=$1" in q:
            team_id = args[0]
            self.seats.pop(team_id, None)
            return "DELETE 1"

        if "INSERT INTO gs_matches" in q:
            mid, round_uid, coding_dur = args
            self.matches[mid] = {
                "id": mid,
                "round_uid": round_uid,
                "state": "coding",
                "coding_ends_at": now + timedelta(seconds=coding_dur),
                "result": None,
                "created_at": now,
            }
            return "INSERT 1"

        if "INSERT INTO gs_match_players" in q:
            if "true" in q.lower():
                mid, slot, team_name, rating_val, eq = args
                team_id, is_bot = None, True
            else:
                mid, slot, team_id, team_name, rating_val = args
                is_bot, eq = False, None
            self.match_players[(mid, slot)] = {
                "match_id": mid,
                "slot": slot,
                "team_id": team_id,
                "team_name": team_name,
                "rating": rating_val,
                "is_bot": is_bot,
                "equation": eq,
            }
            return "INSERT 1"

        if "UPDATE gs_seats SET state='matched'" in q:
            uid, teams = args
            for t in teams:
                if t in self.seats and self.seats[t]["round_uid"] == uid:
                    self.seats[t]["state"] = "matched"
            return f"UPDATE {len(teams)}"

        if "UPDATE gs_rounds SET status='launched'" in q:
            uid = args[0]
            for r in self.rounds.values():
                if r["uid"] == uid:
                    r["status"] = "launched"
            return "UPDATE 1"

        if "UPDATE gs_match_players SET equation=$1 WHERE match_id=$2 AND team_id=$3" in q:
            eq, mid, team_id = args
            found = False
            for p in self.match_players.values():
                if p["match_id"] == mid and p["team_id"] == team_id:
                    p["equation"] = eq
                    found = True
            return "UPDATE 1" if found else "UPDATE 0"

        if "UPDATE gs_matches SET state='finished',result=$2 WHERE id=$1" in q:
            mid, res = args
            if mid in self.matches:
                self.matches[mid]["state"] = "finished"
                self.matches[mid]["result"] = res
            return "UPDATE 1"

        if "INSERT INTO gs_ratings" in q:
            team_id, delta = args[0], args[1]
            self.ratings[team_id] = self.ratings.get(team_id, 1000) + delta
            return "INSERT 1"

        return "OK"

    async def fetch(self, query: str, *args):
        q = query.strip()
        now = datetime.now(timezone.utc)
        if "FROM gs_seats s JOIN gs_sessions t" in q:
            uid = args[0]
            res = []
            for s in self.seats.values():
                if s["round_uid"] == uid and s["state"] == "queued":
                    sess = self.sessions.get(s["session_id"])
                    name = sess["team_name"] if sess else s["team_id"]
                    res.append({"team_id": s["team_id"], "team_name": name})
            return res

        if "FROM gs_match_players WHERE match_id=$1 ORDER BY slot" in q:
            mid = args[0]
            res = [p for p in self.match_players.values() if p["match_id"] == mid]
            res.sort(key=lambda x: x["slot"])
            return res

        if "FROM gs_ratings ORDER BY rating DESC" in q:
            sorted_ratings = sorted(self.ratings.items(), key=lambda x: x[1], reverse=True)
            return [{"team_id": k, "rating": v} for k, v in sorted_ratings]

        if "SELECT uid FROM gs_rounds WHERE status='entry'" in q:
            return [{"uid": r["uid"]} for r in self.rounds.values() if r["status"] == "entry" and r["entry_closes_at"] <= now]

        if "SELECT id FROM gs_matches WHERE state='coding'" in q:
            return [{"id": m["id"]} for m in self.matches.values() if m["state"] == "coding" and m["coding_ends_at"] <= now]

        return []

    async def fetchrow(self, query: str, *args):
        q = query.strip()
        now = datetime.now(timezone.utc)
        if "FROM gs_sessions WHERE id=$1 AND expires_at>now()" in q:
            sid = args[0]
            s = self.sessions.get(sid)
            if s and s["expires_at"] > now:
                return s
            return None

        if "FROM gs_rounds WHERE slot=$1" in q:
            return self.rounds.get(args[0])

        if "FROM gs_seats WHERE team_id" in q:
            team_id = args[0]
            return self.seats.get(team_id)

        if "FROM gs_matches m" in q:
            # Handles WHERE m.id=$1 AND p.team_id=$2 or WHERE p.team_id = $1
            if len(args) == 2:
                mid, team_id = args
                m = self.matches.get(mid)
                if m:
                    for p in self.match_players.values():
                        if p["match_id"] == mid and p["team_id"] == team_id:
                            return m
                return None
            else:
                team_id = args[0]
                for m in self.matches.values():
                    for p in self.match_players.values():
                        if p["match_id"] == m["id"] and p["team_id"] == team_id:
                            return m
                return None

        if "FROM gs_matches WHERE id=$1" in q:
            return self.matches.get(args[0])

        return None

    async def fetchval(self, query: str, *args):
        q = query.strip()
        if "SELECT rating FROM gs_ratings WHERE team_id=$1" in q:
            return self.ratings.get(args[0])

        if "SELECT EXISTS(SELECT 1 FROM gs_seats" in q:
            team_id, round_uid = args[:2]
            seat = self.seats.get(team_id)
            return bool(seat and seat["round_uid"] == round_uid and seat["state"] == "queued")

        if "SELECT count(*) FROM gs_match_players WHERE match_id=$1 AND NOT is_bot AND equation IS NULL" in q:
            mid = args[0]
            count = sum(1 for p in self.match_players.values() if p["match_id"] == mid and not p["is_bot"] and p["equation"] is None)
            return count

        return None


class ServerIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.mock_db = MockDB()
        server.app.state.db = self.mock_db
        self.client = TestClient(server.app)

    def test_static_routes_available(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIn("graphshot", res.text.lower())

        solo = self.client.get("/solo")
        self.assertEqual(solo.status_code, 200)

    def test_unauthorized_api_me_returns_401(self):
        res = self.client.get("/api/me")
        self.assertEqual(res.status_code, 401)

    def test_dev_login_and_whoami(self):
        res = self.client.get("/auth/dev/login?team=CyberKnights", follow_redirects=False)
        self.assertEqual(res.status_code, 307)
        cookie = res.cookies.get("gs_session")
        self.assertTrue(bool(cookie))

        # Call /api/me with session cookie
        me_res = self.client.get("/api/me", cookies={"gs_session": cookie})
        self.assertEqual(me_res.status_code, 200)
        data = me_res.json()
        self.assertEqual(data["teamName"], "CyberKnights")
        self.assertEqual(data["rating"], 1000)

    def test_current_round_and_joining(self):
        # 1. Check current round
        r_res = self.client.get("/api/rounds/current")
        self.assertEqual(r_res.status_code, 200)
        round_info = r_res.json()
        self.assertTrue("uid" in round_info)
        self.assertEqual(round_info["status"], "entry")

        # 2. Login as TeamA
        login_res = self.client.get("/auth/dev/login?team=TeamA")
        cookie = login_res.cookies.get("gs_session")

        # 3. Join round
        join_res = self.client.post("/api/rounds/current/join", cookies={"gs_session": cookie})
        self.assertEqual(join_res.status_code, 200)
        self.assertTrue(join_res.json().get("queued"))

        # 4. Check /api/me reflects queued seat
        me_data = self.client.get("/api/me", cookies={"gs_session": cookie}).json()
        self.assertEqual(me_data["seatState"], "queued")

    def test_match_launch_submission_and_resolution(self):
        # 1. Login
        login_res = self.client.get("/auth/dev/login?team=Sharpshooters")
        cookie = login_res.cookies.get("gs_session")

        # 2. Join
        self.client.post("/api/rounds/current/join", cookies={"gs_session": cookie})

        # 3. Launch now (fills with bots)
        launch_res = self.client.post("/api/rounds/current/launch-now", cookies={"gs_session": cookie})
        self.assertEqual(launch_res.status_code, 200)
        mid = launch_res.json()["matches"][0]

        # 4. Fetch match view
        m_view = self.client.get(f"/api/matches/{mid}", cookies={"gs_session": cookie}).json()
        self.assertEqual(m_view["state"], "coding")
        self.assertEqual(len(m_view["players"]), 10)

        # Check that opponents' equations are hidden during coding phase
        bot_players = [p for p in m_view["players"] if p["is_bot"]]
        for b in bot_players:
            self.assertEqual(b["equation"], "locked")

        # Check player coordinates
        you = next(p for p in m_view["players"] if p["is_you"])
        self.assertTrue("x" in you and "y" in you and "angle" in you)

        # 5. Submit valid equation
        sub_res = self.client.post(
            f"/api/matches/{mid}/submit",
            cookies={"gs_session": cookie},
            json={"equation": "0.3*x"},
        )
        self.assertEqual(sub_res.status_code, 200)
        self.assertTrue(sub_res.json()["firesNow"])

        # 6. Verify match resolved and result is populated
        m_after = self.client.get(f"/api/matches/{mid}", cookies={"gs_session": cookie}).json()
        self.assertEqual(m_after["state"], "finished")
        self.assertIsNotNone(m_after["result"])
        self.assertTrue("beams" in m_after["result"])
        self.assertTrue("deaths" in m_after["result"])

        # 7. Check leaderboard
        lb = self.client.get("/api/leaderboard").json()
        self.assertTrue("teams" in lb)


if __name__ == "__main__":
    unittest.main()
