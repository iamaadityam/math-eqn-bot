"use strict";
const WebSocket = require("ws");

const ws = new WebSocket(process.env.WS_URL || "ws://127.0.0.1:8787/ws");
let lockedRoom = "";
let finished = false;
let sentRound = -1;
const started = Date.now();
const timer = setTimeout(() => {
  console.error("timeout");
  process.exit(1);
}, 180000);

function send(message) {
  ws.send(JSON.stringify(message));
}

function aim(match) {
  const me = match.soldiers[match.mySlot];
  const targets = match.soldiers
    .filter(s => s.slot !== match.mySlot && (me.dir * (s.x - me.x)) > 2.2)
    .map(s => {
      const u = me.dir * (s.x - me.x);
      const v = s.y - me.y;
      return { s, u, v, slope: Math.abs(v / u) };
    })
    .sort((a, b) => a.slope - b.slope || a.u - b.u);
  if (!targets.length) return "0";
  return (targets[0].v / targets[0].u).toFixed(6) + "*x";
}

ws.on("open", () => send({ type: "hello", token: "smoke-" + Date.now(), name: "smoke" }));
ws.on("message", raw => {
  const message = JSON.parse(raw);
  if (message.type === "error") console.log("error:", message.code, message.message);
  if (message.type !== "state") return;
  const state = message.state;
  if (state.phase === "idle" && !finished) {
    send({ type: "queue" });
    console.log("queued");
  } else if (state.phase === "queue") {
    console.log("queue:", state.queue.humans, "human(s),", state.queue.botSeats, "bot seat(s)");
  } else if (state.phase === "code") {
    if (sentRound !== state.match.round) {
      sentRound = state.match.round;
      const expression = aim(state.match);
      console.log("room:", state.match.id, "round", state.match.round, "slot", state.match.mySlot, "dir",
        state.match.soldiers[state.match.mySlot].dir, "bots",
        state.match.soldiers.filter(s => s.isBot).length, "aim", expression);
      send({ type: "submit", expression, lock: true });
    }
  } else if (state.phase === "result" && !finished) {
    finished = true;
    const me = state.result.rows.find(row => row.slot === state.match.mySlot);
    console.log("result:", JSON.stringify({
      rows: state.result.rows.length,
      rank: me.rank,
      points: me.points,
      kills: me.kills,
      delta: me.delta,
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
