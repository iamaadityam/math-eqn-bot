/* Server integration tests: hosted rooms, bot fill, 60 -> 6 lobbies. */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const { createApp } = require("../server");

const quiet = { log() {}, error() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "graphshot-test-"));
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once("error", reject);
  });
}

class TestClient {
  constructor(ws, token, name) {
    this.ws = ws;
    this.token = token;
    this.name = name;
    this.state = null;
    this.states = [];
    this.errors = [];
    this.waiters = [];
    ws.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "state") {
        this.state = message.state;
        this.states.push(message.state);
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(message.state)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(message.state);
          }
        }
      } else if (message.type === "error") {
        this.errors.push(message);
      }
    });
  }
  send(message) {
    this.ws.send(JSON.stringify(message));
  }
  waitFor(predicate, timeoutMs = 15000) {
    if (this.state && predicate(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error("timed out waiting for state (" + this.name + "), phase=" +
          (this.state && this.state.phase)));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

async function connectToken(url, token, name, expected = state => state.phase === "idle") {
  const ws = new WebSocket(url);
  await once(ws, "open");
  const client = new TestClient(ws, token, name);
  client.send({ type: "hello", token, name });
  await client.waitFor(expected);
  return client;
}

async function connect(url, index, prefix = "p") {
  const token = prefix + "-" + index + "-" + Math.random().toString(36).slice(2, 8);
  return connectToken(url, token, prefix + index);
}

function aim(match) {
  const me = match.soldiers[match.mySlot];
  const targets = match.soldiers
    .filter(soldier => soldier.slot !== match.mySlot && (me.dir * (soldier.x - me.x)) > 2.2)
    .map(soldier => {
      const u = me.dir * (soldier.x - me.x);
      const v = soldier.y - me.y;
      return { u, v, slope: Math.abs(v / u) };
    })
    .sort((a, b) => a.slope - b.slope || a.u - b.u);
  if (!targets.length) return "0";
  return (targets[0].v / targets[0].u).toFixed(6) + "*x";
}

async function testThreeHumansFillWithBots() {
  const dataDir = tempDir();
  const app = createApp({
    dataDir,
    log: quiet,
    clock: { queueMs: 1000, codeMs: 8000, countdownMs: 200, fast: true }
  });
  const address = await app.start(0, "127.0.0.1");
  const url = "ws://127.0.0.1:" + address.port + "/ws";
  const clients = [];
  try {
    clients.push(...await Promise.all([
      connect(url, 1), connect(url, 2), connect(url, 3)
    ]));
    for (const client of clients) client.send({ type: "queue" });
    await clients[0].waitFor(state => state.phase === "queue" && state.queue.humans === 3, 5000);

    const codeStates = await Promise.all(clients.map(client =>
      client.waitFor(state => state.phase === "code", 10000)));
    const roomIds = new Set(codeStates.map(state => state.match.id));
    assert.equal(roomIds.size, 1, "three humans should share one room");
    for (const state of codeStates) {
      assert.equal(state.match.soldiers.length, 10);
      assert.equal(state.match.soldiers.filter(soldier => !soldier.isBot).length, 3);
      assert.equal(state.match.soldiers.filter(soldier => soldier.isBot).length, 7);
      assert.equal(state.match.soldiers[state.match.mySlot].isBot, false);
      assert.equal(state.queue, null);
    }

    for (const client of clients) {
      const state = client.state;
      client.send({ type: "submit", expression: aim(state.match), lock: true });
    }

    const resultStates = await Promise.all(clients.map(client =>
      client.waitFor(state => state.phase === "result", 30000)));
    for (const state of resultStates) {
      assert.equal(state.result.rows.length, 10);
      const me = state.result.rows.find(row => row.slot === state.match.mySlot);
      assert.ok(me, "own result row exists");
      assert.ok(me.points > 0, "every loser still earns points");
      assert.equal(typeof me.ratingAfter, "number");
      assert.equal(me.ratingAfter, me.rating + me.delta);
    }
    const board = app.hub.stateFor(clients[0].token).leaderboard;
    const humanRows = board.filter(row => !row.isBot && ["p1", "p2", "p3"].includes(row.name));
    assert.equal(humanRows.length, 3, "all three humans are on the shared ladder");
    console.log("ok 3 humans -> one room with 7 bots + results");
  } finally {
    for (const client of clients) client.ws.close();
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testSixtyHumansBecomeSixRooms() {
  const dataDir = tempDir();
  const app = createApp({
    dataDir,
    log: quiet,
    clock: { queueMs: 3000, codeMs: 8000, countdownMs: 200, fast: true }
  });
  const address = await app.start(0, "127.0.0.1");
  const url = "ws://127.0.0.1:" + address.port + "/ws";
  const clients = [];
  try {
    const batch = [];
    for (let index = 0; index < 60; index++) batch.push(connect(url, index, "crowd"));
    clients.push(...await Promise.all(batch));
    for (const client of clients) client.send({ type: "queue" });
    await clients[0].waitFor(state =>
      state.phase === "queue" && state.queue.humans === 60, 10000);

    const codeStates = await Promise.all(clients.map(client =>
      client.waitFor(state => state.phase === "code", 15000)));
    const rooms = new Map();
    for (const state of codeStates) {
      if (!rooms.has(state.match.id)) rooms.set(state.match.id, []);
      rooms.get(state.match.id).push(state);
    }
    assert.equal(rooms.size, 6, "60 humans should form six rooms");
    for (const [roomId, states] of rooms) {
      assert.equal(states.length, 10, "room " + roomId + " holds ten humans");
      assert.equal(states[0].match.soldiers.length, 10);
      assert.equal(states[0].match.soldiers.filter(soldier => soldier.isBot).length, 0);
      assert.equal(states[0].match.soldiers.filter(soldier => !soldier.isBot).length, 10);
    }
    console.log("ok 60 humans -> 6 rooms of 10, no bots");
  } finally {
    for (const client of clients) client.ws.close();
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function testReconnectDuringCode() {
  const dataDir = tempDir();
  const app = createApp({
    dataDir,
    log: quiet,
    clock: { queueMs: 1000, codeMs: 8000, countdownMs: 200, fast: true }
  });
  const address = await app.start(0, "127.0.0.1");
  const url = "ws://127.0.0.1:" + address.port + "/ws";
  const token = "reconnect-" + Math.random().toString(36).slice(2, 8);
  let client = null;
  let reconnected = null;
  try {
    client = await connectToken(url, token, "reconnect");
    client.send({ type: "queue" });
    const code = await client.waitFor(state => state.phase === "code" && state.match, 10000);
    const roomId = code.match.id;
    const slot = code.match.mySlot;
    assert.equal(code.match.soldiers.filter(soldier => soldier.isBot).length, 9);

    const closed = once(client.ws, "close");
    client.ws.close();
    await closed;

    reconnected = await connectToken(
      url,
      token,
      "reconnect",
      state => state.phase === "code" && !!state.match
    );
    const back = await reconnected.waitFor(state =>
      state.phase === "code" && state.match.id === roomId, 5000);
    assert.equal(back.match.id, roomId, "reconnect returns to the same room");
    assert.equal(back.match.mySlot, slot, "reconnect returns to the same seat");
    assert.equal(back.match.soldiers.filter(soldier => soldier.isBot).length, 9);
    assert.equal(back.connected, true);

    const plan = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("plan helper timed out")), 3000);
      const onMessage = raw => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "plan") return;
        clearTimeout(timer);
        reconnected.ws.off("message", onMessage);
        resolve(message);
      };
      reconnected.ws.on("message", onMessage);
      reconnected.send({ type: "plan" });
    });
    assert.ok(plan.expression, "plan helper returns an expression");

    reconnected.send({ type: "submit", expression: plan.expression, lock: true });
    const result = await reconnected.waitFor(state => state.phase === "result", 30000);
    assert.equal(result.result.rows.length, 10);
    assert.ok(result.result.rows.find(row => row.slot === slot).points > 0);

    console.log("ok reconnect keeps the same room/seat; plan helper works");
  } finally {
    if (client) client.ws.close();
    if (reconnected) reconnected.ws.close();
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  await testThreeHumansFillWithBots();
  await testSixtyHumansBecomeSixRooms();
  await testReconnectDuringCode();
  console.log("all server tests passed");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
