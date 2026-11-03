"use strict";
/* Headless GraphShot bot: queue -> wait for code -> ask the server for a plan ->
   lock in -> wait for the result.
   Run with the hosted server up:  node bot.example.js
   Env: WS_URL, BOT_TOKEN, BOT_NAME, BOT_ROUND (optional forced round to play).
*/
const WebSocket = require("ws");

const WS_URL = process.env.WS_URL || "ws://127.0.0.1:8787/ws";
const TOKEN = process.env.BOT_TOKEN || "bot-" + Math.random().toString(36).slice(2, 8);
const NAME = process.env.BOT_NAME || "bot";
const FORCE_ROUND = Number(process.env.BOT_ROUND || 0);

const ws = new WebSocket(WS_URL);
const started = Date.now();
let phase = "idle";
let round = 0;
let submittedRound = 0;
let finished = false;
const timer = setTimeout(() => {
  console.error("bot timed out");
  process.exit(1);
}, 180000);

function send(message) {
  ws.send(JSON.stringify(message));
}

function aimInfo(match) {
  const me = match.soldiers[match.mySlot];
  const targets = match.soldiers
    .filter(s => s.slot !== match.mySlot && (me.dir * (s.x - me.x)) > 2.2)
    .map(s => ({
      s,
      u: me.dir * (s.x - me.x),
      v: s.y - me.y,
      slope: Math.abs(s.v / s.u)
    }))
    .sort((a, b) => a.slope - b.slope || a.u - b.u);
  if (!targets.length) return "0";
  return (targets[0].v / targets[0].u).toFixed(6) + "*x";
}

ws.on("open", () => {
  send({ type: "hello", token: TOKEN, name: NAME });
  console.log("bot connected", TOKEN, NAME);
});

ws.on("message", raw => {
  const message = JSON.parse(raw.toString());
  if (message.type === "error") {
    console.error("server error:", message.code, message.message);
    process.exitCode = 1;
    return;
  }
  if (message.type === "plan") {
    send({ type: "submit", expression: message.expression, lock: true });
    return;
  }
  if (message.type !== "state") return;
  const state = message.state;
  phase = state.phase;
  if (state.phase === "idle" && !finished) {
    send({ type: "queue" });
    console.log("queued");
  } else if (state.phase === "queue") {
    console.log("queue:", state.queue.humans, "human(s),", state.queue.botSeats, "bot seat(s)");
  } else if (state.phase === "code") {
    const roundNow = state.match.round || 1;
    if (round !== roundNow) {
      round = roundNow;
      submittedRound = roundNow;
      console.log("round", round, "slot", state.match.mySlot, "dir",
        state.match.soldiers[state.match.mySlot].dir, "bots",
        state.match.soldiers.filter(s => s.isBot).length, "aim", aimInfo(state.match));
      if (FORCE_ROUND && round !== FORCE_ROUND) return;
      send({ type: "plan" });
    }
  } else if (state.phase === "result" && !finished) {
    finished = true;
    const me = state.result.rows.find(row => row.slot === state.match.mySlot);
    console.log("result:", JSON.stringify({
      round: state.match.round,
      rank: me.rank,
      points: me.points,
      kills: me.kills,
      damage: me.damage,
      ratingAfter: me.ratingAfter,
      ms: Date.now() - started
    }));
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  }
});

ws.on("close", () => {
  if (!finished) {
    clearTimeout(timer);
    process.exit(1);
  }
});
ws.on("error", error => {
  console.error(error);
  process.exit(1);
});
