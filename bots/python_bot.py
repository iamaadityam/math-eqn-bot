"""Example Graphshot bot: authenticate, join round, calculate trajectory, and fire."""
from __future__ import annotations
import os
import sys
import time
import requests

BASE = os.getenv("GRAPSHOT_URL", "http://localhost:3000").rstrip("/")
BOT_NAME = os.getenv("BOT_NAME", "Python-SineBot")
EQUATION = os.getenv("BOT_EQUATION", "0.32*x + 1.5*sin(x/4)")
RCTF_TOKEN = os.getenv("RCTF_AUTH_TOKEN", "dev")

s = requests.Session()

print(f"[*] Connecting to Graphshot server at {BASE} as '{BOT_NAME}'...")

# 1. Authenticate session
try:
    auth_resp = s.post(
        f"{BASE}/api/bot/session",
        headers={"Authorization": f"Bearer {RCTF_TOKEN}"},
        json={"name": BOT_NAME},
        timeout=10,
    )
    auth_resp.raise_for_status()
    session_data = auth_resp.json()
    token = session_data["accessToken"]
    headers = {"Authorization": f"Bearer {token}"}
    print(f"[+] Authenticated successfully for team: {session_data.get('team', BOT_NAME)}")
except Exception as e:
    print(f"[-] Authentication failed: {e}")
    sys.exit(1)

# 2. Join current round
try:
    join_resp = s.post(f"{BASE}/api/rounds/current/join", headers=headers, timeout=10)
    join_resp.raise_for_status()
    round_uid = join_resp.json().get("roundUid", "unknown")
    print(f"[+] Reserved seat in round: {round_uid[:8]}")
except requests.HTTPError as e:
    # 409 might mean already joined
    print(f"[!] Join response: {e.response.text}")

# 3. Launch match or obtain active match
match_id = None
try:
    launch_resp = s.post(f"{BASE}/api/rounds/current/launch-now", headers=headers, timeout=10)
    if launch_resp.status_code == 200:
        matches = launch_resp.json().get("matches", [])
        if matches:
            match_id = matches[0]
            print(f"[+] Launched match: {match_id}")
except Exception as e:
    print(f"[!] Launch now info: {e}")

if not match_id:
    # Query /api/me for active match
    me_resp = s.get(f"{BASE}/api/me", headers=headers, timeout=10)
    if me_resp.ok:
        match_id = me_resp.json().get("activeMatchId")

if not match_id:
    print("[-] Could not find active match.")
    sys.exit(1)

# 4. Submit programmed equation
print(f"[*] Submitting cannon equation: '{EQUATION}'")
sub_resp = s.post(
    f"{BASE}/api/matches/{match_id}/submit",
    headers=headers,
    json={"equation": EQUATION},
    timeout=10,
)
sub_resp.raise_for_status()
print(f"[+] Cannon locked in match {match_id} (firesNow: {sub_resp.json().get('firesNow')})")

# 5. Wait for volley resolution and print scoreboard
print("[*] Waiting for volley resolution...")
for _ in range(30):
    time.sleep(1)
    view = s.get(f"{BASE}/api/matches/{match_id}", headers=headers, timeout=10).json()
    if view.get("state") == "finished" and view.get("result"):
        res = view["result"]
        print("\n=== MATCH RESULTS ===")
        for idx, p in enumerate(sorted(res["players"], key=lambda x: x["score"], reverse=True)):
            status_str = "ALIVE" if p["alive"] else "ELIMINATED"
            print(f"#{idx + 1} {p['name']:<20} Score: {p['score']:<5} Kills: {p['kills']:<3} [{status_str}]")
        break
