# GraphShot Bot API

Two ways to drive GraphShot bots.

## 1. Browser bridge — `window.GraphShot`

Loaded by the hosted page. Everything is async-friendly; the bot should listen to
the `graphshot:phase` event instead of polling.

```js
await GraphShot.findMatch()          // join hosted queue, resolve on code phase
GraphShot.getState()                  // phase / connected / match / queue / result / leaderboard
GraphShot.getMap()                    // terrain, soldiers, bounds, local frame
GraphShot.getConnection()            // server url, status, latency, server time
GraphShot.setName("my-bot")
GraphShot.planShot()                  // { expression, angle, targetSlot, expectedKills }
GraphShot.submitShot({ expression: "0.3*x" })   // commit equation (lock defaults false)
GraphShot.submitShot({ expression: "0.3*x", lock: true })
GraphShot.lockIn()
await GraphShot.waitForPhase("result", 180000)
GraphShot.getLeaderboard()
GraphShot.getOptions() / setOptions({...})
GraphShot.navigate("home")
GraphShot.on("state", fn)            // unsubscribe via returned fn; also "phase" and "error"
GraphShot.version
```

### Bot loop (browser)

```js
await GraphShot.findMatch();
await GraphShot.waitForPhase("code");
const plan = GraphShot.planShot();
GraphShot.submitShot({ expression: plan.expression, lock: true });
await GraphShot.waitForPhase("result", 180000);
GraphShot.navigate("home");
```

## 2. Headless WebSocket protocol

Same server, JSON only. No DOM, no `window.GraphShot`, no `eval`.

```
ws://<host>/ws
→ { type: "hello", token: "...", name: "bot" }
→ { type: "state", state: { phase, connected, profile, clock, queue, match, result, leaderboard } }

→ { type: "queue" }
→ state.phase === "queue"
→ state.phase === "code"            // room formed, bots fill empty seats
→ { type: "plan" }                   // server chooses a high-skill shot for you
   ← { type: "plan", expression, targetSlot, expectedKills }
→ { type: "submit", expression, lock: true }
→ state.phase === "countdown" → "combat" → "result"

→ { type: "cancelQueue" }
→ { type: "leaveMatch" }
→ { type: "setName", name }
→ { type: "sync" }
→ { type: "devClock", clock: { queueMs, codeMs, countdownMs } }   // server must run with ALLOW_CLOCK=1
```

Errors are `{ type: "error", code, message }` (codes: `not_in_room`, `phase`, `empty`, `too_long`, `bad_expression`, `locked`, `in_match`, `handshake`, ...).

### Phases

`idle | queue | code | countdown | combat | result`

- **queue**: skill-snake matchmaking. 30s window by default (`QUEUE_MS`). Empty slots become bots near the room average.
- **code**: everyone writes an equation. `CODE_MS` (120s default; `FAST=1` gives 10s locally). All cannons must lock or the server auto-locks at 0:00.
- **countdown**: `COUNTDOWN_MS` (3s default; 1s fast).
- **combat**: all beams fire simultaneously. Duration ≈ beam path end + 1.2s.
- **result**: final ranking and payouts.

### State fields used by bots

`state.match` contains `id, ranked, phase, mode, relative, mySlot, avgRating, round,
codeEndsAt, countdownEndsAt, combatStartedAt, terrain, soldiers[], submissions`.

`soldiers[]` per slot: `slot, id, name, rating, isBot, alive, health, maxHealth, x, y, dir, color, ready, expression`.

### Map / physics semantics

- Ranked mode: `mode: "normal"`, `relative: true`, team `ffa`.
- In relative mode, equation `x` is distance from the firing cannon; the curve is
  shifted so it starts at the cannon’s own `y`.
- Left-facing cannons are mirrored on the server so they always fire toward `+x`.
- Allowed functions in ranked: `abs, ln, log, sqrt, sin, cos, tan, exp, pi, e, x, y, dy`
  (as parsed by the shared parser; ranked uses the `normal` gate).
- Beams keep travelling after passing a soldier; they can hit several in one shot.
- If a shooter dies, its beam ends at the death instant; hits after that are dropped.
- Cannons may leave the top/bottom of the map and still come back (parabola/quadratic support).

### Health, rounds and scoring

- Every soldier starts with `health: 100` (`maxHealth: 100`).
- Every landed beam hit applies `34` damage (`HIT_DAMAGE < MAX_HEALTH`).
- The match runs rounds. After a round, surviving soldiers are repositioned with a
  minimum distance of `6` units. The next `code` phase starts.
- The lobby ends when only one soldier/bot remains standing; final result rows carry
  accumulated `points`, `kills`, `damage`, `survived`, placement and Elo.

## Test tokens / URLs

- Hosted local server: `http://127.0.0.1:8787/?name=<you>&token=<you>`
- Bot queue URL override: `?server=ws://127.0.0.1:8787/ws`
- Server env: `PORT`, `HOST`, `DATA_DIR`, `FAST=1`, `QUEUE_MS`, `CODE_MS`, `COUNTDOWN_MS`,
  `ALLOW_CLOCK=1`.

```bash
npm start
# fast bot-friendly server
PORT=8787 FAST=1 npm start
# headless bot against it
node bot.example.js
```
