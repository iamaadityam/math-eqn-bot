/* Authoritative online rooms: matchmaking queue, human/bot seats, phases,
   simultaneous resolution, scoring and per-socket state. */
"use strict";

const crypto = require("node:crypto");
const { makeLobbies } = require("./matchmaker");

const SIZE = 10;
const VERSION = "2.0.0";
const TOKEN_RE = /^[A-Za-z0-9_.:-]{3,100}$/;
const humanKey = token => "h:" + token;

function cleanName(value) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 20);
}

function publicProfile(profile) {
  return {
    id: "me",
    name: profile.name,
    rating: profile.rating,
    matches: profile.matches || 0,
    wins: profile.wins || 0,
    kills: profile.kills || 0,
    points: profile.points || 0,
    isBot: false
  };
}

function publicRow(row) {
  return {
    slot: row.slot,
    rank: row.rank,
    points: row.points,
    kills: row.kills,
    alive: row.alive,
    survived: row.survived,
    deathAt: row.deathAt,
    killedBy: row.killedBy,
    name: row.name,
    rating: row.rating,
    isBot: row.isBot,
    color: row.color,
    expression: row.expression,
    error: row.error,
    delta: row.delta,
    ratingAfter: row.ratingAfter
  };
}

class Hub {
  constructor({ game, ladder, clock, log = console, allowDevClock = false }) {
    this.game = game;
    this.ladder = ladder;
    this.clock = { ...clock };
    this.log = log;
    this.allowDevClock = allowDevClock;
    this.conns = new Map();
    this.queue = new Map();
    this.queueEndsAt = 0;
    this.rooms = new Map();
    this.roomByToken = new Map();
    this.roomSeq = 0;
    this.timer = null;
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 100);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* ------------------------------------------------------------- sockets */
  send(ws, message) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      return false;
    }
  }

  error(ws, message, code = "error") {
    this.send(ws, { type: "error", code, message });
  }

  sendState(token) {
    const conn = this.conns.get(token);
    if (!conn) return;
    this.send(conn.ws, {
      type: "state",
      state: this.stateFor(token)
    });
  }

  broadcastQueue() {
    for (const token of this.queue.keys()) this.sendState(token);
  }

  broadcastRoom(room) {
    for (const seat of room.seats) {
      if (seat.kind === "human" && seat.token) this.sendState(seat.token);
    }
  }

  hello(ws, message) {
    let token = String(message.token || "").trim();
    if (!TOKEN_RE.test(token) || /^(bot-|synthetic-)/.test(token)) {
      token = "anon-" + crypto.randomUUID();
    }
    const requestedName = cleanName(message.name);
    const old = this.conns.get(token);
    if (old && old.ws !== ws) {
      try { old.ws.close(4001, "session replaced"); } catch (error) { /* ignore */ }
    }
    const profile = this.ladder.getProfile(token, requestedName);
    const conn = { ws, token, profile, lastSeen: Date.now() };
    ws.__gstoken = token;
    this.conns.set(token, conn);

    // Reattach a reconnecting player to their queued slot or live room.
    const queued = this.queue.get(token);
    if (queued) {
      queued.ws = ws;
      queued.profile = profile;
    }
    const room = this.roomByToken.get(token);
    if (room) {
      const seat = this.seatFor(room, token);
      if (seat) {
        seat.ws = ws;
        seat.connected = true;
        seat.disconnectedAt = 0;
        seat.left = false;
      }
    }

    this.send(ws, {
      type: "hello",
      token,
      profile: publicProfile(profile),
      serverTime: Date.now(),
      clock: { ...this.clock },
      version: VERSION
    });
    this.sendState(token);
  }

  detach(ws) {
    const token = ws.__gstoken;
    if (!token) return;
    const conn = this.conns.get(token);
    if (!conn || conn.ws !== ws) return;
    this.conns.delete(token);

    const queued = this.queue.get(token);
    if (queued && queued.ws === ws) {
      this.queue.delete(token);
      if (!this.queue.size) this.queueEndsAt = 0;
      this.broadcastQueue();
    }

    const room = this.roomByToken.get(token);
    if (room) {
      const seat = this.seatFor(room, token);
      if (seat && seat.ws === ws) {
        seat.ws = null;
        seat.connected = false;
        seat.disconnectedAt = Date.now();
      }
    }
  }

  handle(ws, message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.error(ws, "message must be a JSON object");
      return;
    }
    const type = String(message.type || "");
    if (type === "hello") return this.hello(ws, message);
    if (type === "ping") {
      return this.send(ws, { type: "pong", t: message.t, serverTime: Date.now() });
    }

    const token = ws.__gstoken;
    const conn = token ? this.conns.get(token) : null;
    if (!conn || conn.ws !== ws) {
      this.error(ws, "send {type:'hello'} first", "handshake");
      return;
    }

    switch (type) {
      case "queue":
        return this.joinQueue(token);
      case "cancelQueue":
        return this.cancelQueue(token);
      case "submit":
        return this.submitExpression(token, message.expression, !!message.lock);
      case "lockIn":
        return this.lockIn(token);
      case "plan":
        return this.planShot(token);
      case "leaveMatch":
        return this.leaveMatch(token);
      case "setName":
        return this.setName(token, message.name);
      case "sync":
        return this.sendState(token);
      case "devClock":
        return this.devClock(token, message.clock);
      default:
        this.error(ws, "unknown message type: " + type, "unknown_type");
    }
  }

  /* --------------------------------------------------------------- queue */
  joinQueue(token) {
    const conn = this.conns.get(token);
    if (!conn) return;
    const room = this.roomByToken.get(token);
    if (room) {
      if (room.phase === "result") {
        this.leaveFinishedRoom(token);
      } else {
        this.error(conn.ws, "finish your current match first", "in_match");
        this.sendState(token);
        return;
      }
    }
    if (this.queue.has(token)) {
      this.queue.get(token).ws = conn.ws;
      this.sendState(token);
      return;
    }
    const profile = this.ladder.getProfile(token);
    this.queue.set(token, {
      token,
      profile,
      ws: conn.ws,
      joinedAt: Date.now()
    });
    if (this.queue.size === 1) this.queueEndsAt = Date.now() + this.clock.queueMs;
    this.broadcastQueue();
    this.log.log("[queue] +" + profile.name + " (" + this.queue.size + " queued)");
  }

  cancelQueue(token) {
    if (this.queue.delete(token)) {
      if (!this.queue.size) this.queueEndsAt = 0;
      this.broadcastQueue();
      this.log.log("[queue] -cancelled (" + this.queue.size + " queued)");
    }
    this.sendState(token);
  }

  queueSnapshot(token) {
    const entries = [...this.queue.values()];
    const humans = entries.length;
    const lobbies = humans ? Math.ceil(humans / SIZE) : 0;
    const botSeats = lobbies ? Math.max(0, lobbies * SIZE - humans) : 0;
    return {
      size: SIZE,
      humans,
      enrolled: humans,
      lobbies,
      botSeats,
      timeLeftMs: this.queueEndsAt ? Math.max(0, this.queueEndsAt - Date.now()) : 0,
      endsAt: this.queueEndsAt,
      players: entries
        .slice()
        .sort((a, b) => (b.profile.rating || 1000) - (a.profile.rating || 1000))
        .map(entry => ({
          name: entry.profile.name,
          rating: entry.profile.rating,
          me: entry.token === token
        }))
    };
  }

  closeQueue(now) {
    if (!this.queueEndsAt || now < this.queueEndsAt) return;
    const entries = [...this.queue.values()];
    this.queue.clear();
    this.queueEndsAt = 0;
    if (!entries.length) return;
    const groups = makeLobbies(entries, this.ladder, SIZE);
    for (const group of groups) this.createRoom(group, now);
    this.log.log("[queue] locked " + entries.length + " human(s) into " +
      groups.length + " lobby(s) of " + SIZE);
  }

  /* --------------------------------------------------------------- rooms */
  createRoom(group, now) {
    const participants = group.map(entry => ({
      id: entry.isBot ? entry.profile.id : humanKey(entry.token),
      name: entry.profile.name,
      rating: entry.profile.rating | 0,
      isBot: !!entry.isBot
    }));
    const match = this.game.genRankedMatch(participants);
    const id = "room-" + (++this.roomSeq).toString(36) + "-" +
      crypto.randomBytes(3).toString("hex");
    match.id = id;
    match.avgRating = Math.round(
      match.soldiers.reduce((sum, soldier) => sum + soldier.rating, 0) / match.soldiers.length
    );

    const byId = new Map(group.map(entry => [
      entry.isBot ? entry.profile.id : humanKey(entry.token),
      entry
    ]));
    const seats = match.soldiers.map((soldier, slot) => {
      const entry = byId.get(soldier.id);
      if (!entry) throw new Error("missing participant for slot " + slot);
      const human = !entry.isBot;
      return {
        kind: human ? "human" : "bot",
        token: human ? entry.token : null,
        ws: human ? entry.ws || null : null,
        profile: entry.profile,
        name: soldier.name,
        rating: soldier.rating,
        ready: false,
        expression: "",
        connected: human ? !!(entry.ws && entry.ws.readyState === 1) : true,
        left: false,
        disconnectedAt: 0,
        plan: null,
        lockAt: 0
      };
    });

    const room = {
      id,
      match,
      seats,
      phase: "code",
      codeEndsAt: now + this.clock.codeMs,
      countdownEndsAt: 0,
      combatStartedAt: 0,
      combatEndsAt: 0,
      submissions: null,
      resolution: null,
      resultRows: null,
      finishedAt: 0,
      createdAt: now
    };

    for (let slot = 0; slot < seats.length; slot++) {
      const seat = seats[slot];
      if (seat.kind !== "bot") continue;
      try {
        seat.plan = this.game.chooseBotShot(match, slot);
      } catch (error) {
        seat.plan = { expression: "0", targetSlot: null, expectedKills: 0 };
      }
      const fast = this.clock.codeMs <= 20000;
      const delay = fast
        ? 300 + Math.random() * Math.min(3000, this.clock.codeMs * 0.42)
        : this.game.botReadyDelay(seat.rating);
      seat.lockAt = now + delay;
    }

    this.rooms.set(id, room);
    for (const seat of seats) {
      if (seat.kind === "human" && seat.token) this.roomByToken.set(seat.token, room);
    }
    this.broadcastRoom(room);
    const humans = seats.filter(seat => seat.kind === "human").length;
    this.log.log("[room] " + id + " · " + humans + " human(s) + " +
      (SIZE - humans) + " bot(s) · avg " + match.avgRating);
  }

  seatFor(room, token) {
    return room.seats.find(seat => seat.kind === "human" && seat.token === token) || null;
  }

  roomFor(token) {
    return this.roomByToken.get(token) || null;
  }

  matchSnapshot(room, token) {
    const slot = room.seats.findIndex(seat => seat.kind === "human" && seat.token === token);
    if (slot < 0) return null;
    const match = room.match;
    const revealed = room.phase === "combat" || room.phase === "result";
    return {
      id: match.id,
      ranked: true,
      phase: room.phase,
      mode: "normal",
      relative: true,
      mySlot: slot,
      avgRating: match.avgRating,
      codeEndsAt: room.codeEndsAt || 0,
      countdownEndsAt: room.countdownEndsAt || 0,
      combatStartedAt: room.combatStartedAt || 0,
      terrain: match.terrain,
      soldiers: match.soldiers.map((soldier, index) => {
        const seat = room.seats[index];
        return {
          slot: index,
          id: soldier.isBot ? soldier.id : "player-" + index,
          name: soldier.name,
          rating: soldier.rating,
          isBot: soldier.isBot,
          alive: soldier.alive,
          x: soldier.x,
          y: soldier.y,
          dir: soldier.dir,
          color: soldier.color,
          ready: !!seat.ready,
          expression: (index === slot || revealed) ? (seat.expression || null) : null
        };
      }),
      // The full set of equations is revealed only after every cannon is locked.
      submissions: revealed ? room.submissions : null
    };
  }

  stateFor(token) {
    const conn = this.conns.get(token);
    const profile = conn ? conn.profile : this.ladder.getProfile(token);
    const room = this.roomFor(token);
    const queued = this.queue.has(token);
    const phase = room ? room.phase : queued ? "queue" : "idle";
    const state = {
      version: VERSION,
      serverTime: Date.now(),
      phase,
      connected: !!conn,
      profile: publicProfile(profile),
      clock: { ...this.clock },
      queue: null,
      match: null,
      result: null,
      leaderboard: this.ladder.leaderboard(token, 100)
    };
    if (queued) state.queue = this.queueSnapshot(token);
    if (room) {
      state.match = this.matchSnapshot(room, token);
      if (room.phase === "result" && room.resultRows) {
        state.result = {
          endTime: room.resolution.endTime,
          rows: room.resultRows.map(publicRow)
        };
      }
    }
    return state;
  }

  readySeats(room) {
    return room.seats.every(seat => seat.ready);
  }

  maybeStartCountdown(room, now) {
    if (room.phase !== "code" || !this.readySeats(room)) return false;
    room.phase = "countdown";
    room.countdownEndsAt = now + this.clock.countdownMs;
    this.broadcastRoom(room);
    this.log.log("[room] " + room.id + " all locked · countdown");
    return true;
  }

  tickBots(room, now) {
    let changed = false;
    for (const seat of room.seats) {
      if (seat.kind !== "bot" || seat.ready || !seat.lockAt || now < seat.lockAt) continue;
      seat.expression = (seat.plan && seat.plan.expression) || "0";
      seat.ready = true;
      changed = true;
    }
    return changed;
  }

  autoLock(room, now, reason) {
    let changed = false;
    for (const seat of room.seats) {
      if (seat.ready) continue;
      if (!seat.expression) seat.expression = "0";
      seat.ready = true;
      changed = true;
    }
    if (changed) {
      this.log.log("[room] " + room.id + " auto-locked: " + reason);
      this.broadcastRoom(room);
    }
    this.maybeStartCountdown(room, now);
  }

  startCombat(room, now) {
    if (room.phase !== "countdown") return;
    const submissions = room.seats.map(seat => ({
      expression: seat.expression || "0",
      angle: 0,
      fields: {}
    }));
    let resolution;
    try {
      resolution = this.game.resolveRanked(room.match, submissions);
    } catch (error) {
      this.log.error("[room] " + room.id + " resolution failed:", error);
      // A structural failure should never kill the room; fall back to safe shots.
      for (const sub of submissions) sub.expression = "0";
      resolution = this.game.resolveRanked(room.match, submissions);
    }
    room.phase = "combat";
    room.combatStartedAt = now;
    room.combatEndsAt = now + Math.max(1500, (resolution.endTime + 1.2) * 1000);
    room.submissions = submissions;
    room.resolution = resolution;
    this.broadcastRoom(room);
    this.log.log("[room] " + room.id + " combat · endTime " +
      resolution.endTime.toFixed(2) + "s");
  }

  finishRoom(room, now) {
    if (room.phase !== "combat") return;
    const resolution = room.resolution;
    room.phase = "result";
    room.finishedAt = now;
    room.match.over = true;
    for (const row of resolution.rows) {
      room.match.soldiers[row.slot].alive = row.alive;
      if (!row.isBot && String(row.id).startsWith("h:")) row.id = String(row.id).slice(2);
    }
    room.resultRows = resolution.rows;
    this.ladder.record(resolution.rows);
    this.broadcastRoom(room);
    const winner = resolution.rows.find(row => row.rank === 1);
    this.log.log("[room] " + room.id + " result · " +
      (winner ? winner.name + " wins with " + winner.points + " points" : "complete"));
  }

  tickRoom(room, now) {
    if (room.phase === "code") {
      const botsChanged = this.tickBots(room, now);
      if (botsChanged) this.broadcastRoom(room);

      // A dropped player gets 15 seconds to reconnect before their cannon is
      // locked with whatever equation they had already submitted.
      let dropped = false;
      for (const seat of room.seats) {
        if (seat.kind !== "human" || seat.ready || seat.connected) continue;
        if (seat.disconnectedAt && now - seat.disconnectedAt > 15000) {
          seat.expression = seat.expression || "0";
          seat.ready = true;
          dropped = true;
        }
      }
      if (dropped) this.broadcastRoom(room);

      if (this.readySeats(room)) {
        this.maybeStartCountdown(room, now);
        return;
      }
      if (now >= room.codeEndsAt) this.autoLock(room, now, "code timer expired");
      return;
    }

    if (room.phase === "countdown") {
      if (now >= room.countdownEndsAt) this.startCombat(room, now);
      return;
    }

    if (room.phase === "combat") {
      if (now >= room.combatEndsAt) this.finishRoom(room, now);
      return;
    }

    // Keep finished rooms long enough for reconnects and the result screen.
    if (room.phase === "result" && now - room.finishedAt > 5 * 60 * 1000) {
      this.destroyRoom(room);
    }
  }

  destroyRoom(room) {
    if (!this.rooms.has(room.id)) return;
    this.rooms.delete(room.id);
    for (const seat of room.seats) {
      if (seat.kind === "human" && seat.token && this.roomByToken.get(seat.token) === room) {
        this.roomByToken.delete(seat.token);
      }
    }
  }

  tick() {
    const now = Date.now();
    if (this.queueEndsAt && now >= this.queueEndsAt) this.closeQueue(now);
    for (const room of [...this.rooms.values()]) this.tickRoom(room, now);
  }

  /* ----------------------------------------------------------- submissions */
  planShot(token) {
    const conn = this.conns.get(token);
    const room = this.roomFor(token);
    if (!conn) return;
    if (!room) {
      this.error(conn.ws, "you are not in a ranked room", "not_in_room");
      return;
    }
    if (room.phase !== "code") {
      this.error(conn.ws, "the code phase is over", "phase");
      return;
    }
    const seat = this.seatFor(room, token);
    if (!seat) return;
    const slot = room.seats.indexOf(seat);
    const plan = this.game.chooseBotShot(room.match, slot, { skill: 1 });
    this.send(conn.ws, {
      type: "plan",
      expression: plan.expression,
      targetSlot: plan.targetSlot,
      expectedKills: plan.expectedKills
    });
  }

  submitExpression(token, expression, lock) {
    const conn = this.conns.get(token);
    const room = this.roomFor(token);
    if (!conn) return;
    if (!room) {
      this.error(conn.ws, "you are not in a ranked room", "not_in_room");
      return;
    }
    if (room.phase !== "code") {
      this.error(conn.ws, "the code phase is over", "phase");
      return;
    }
    const seat = this.seatFor(room, token);
    if (!seat) return;
    if (seat.ready) {
      if (lock) this.sendState(token);
      else this.error(conn.ws, "you are already locked in", "locked");
      return;
    }
    const expr = String(expression == null ? "" : expression).trim();
    if (!expr) {
      this.error(conn.ws, "type an equation before locking in", "empty");
      return;
    }
    if (expr.length > 500) {
      this.error(conn.ws, "equation is too long (max 500 characters)", "too_long");
      return;
    }
    try {
      this.game.compile(expr, this.game.allowedFor("normal"));
    } catch (error) {
      this.error(conn.ws, error.message, "bad_expression");
      return;
    }
    seat.expression = expr;
    if (lock) {
      seat.ready = true;
      this.broadcastRoom(room);
      this.maybeStartCountdown(room, Date.now());
    } else {
      this.sendState(token);
    }
  }

  lockIn(token) {
    const conn = this.conns.get(token);
    const room = this.roomFor(token);
    if (!conn) return;
    if (!room) {
      this.error(conn.ws, "you are not in a ranked room", "not_in_room");
      return;
    }
    if (room.phase !== "code") {
      this.error(conn.ws, "the code phase is over", "phase");
      return;
    }
    const seat = this.seatFor(room, token);
    if (!seat) return;
    if (seat.ready) {
      this.sendState(token);
      return;
    }
    if (!seat.expression) {
      this.error(conn.ws, "type an equation before locking in", "empty");
      return;
    }
    seat.ready = true;
    this.broadcastRoom(room);
    this.maybeStartCountdown(room, Date.now());
  }

  /* ------------------------------------------------------------- lifecycle */
  leaveMatch(token) {
    const room = this.roomFor(token);
    const conn = this.conns.get(token);
    if (!room) {
      this.sendState(token);
      return;
    }
    if (room.phase === "result") {
      this.leaveFinishedRoom(token);
      this.sendState(token);
      return;
    }
    const seat = this.seatFor(room, token);
    if (!seat) return;
    seat.left = true;
    if (room.phase === "code" && !seat.ready) {
      seat.expression = seat.expression || "0";
      seat.ready = true;
      this.broadcastRoom(room);
      this.maybeStartCountdown(room, Date.now());
    }
    if (conn) this.sendState(token);
  }

  leaveFinishedRoom(token) {
    const room = this.roomFor(token);
    if (!room || room.phase !== "result") return false;
    this.roomByToken.delete(token);
    const seat = this.seatFor(room, token);
    if (seat) seat.left = true;
    // Finished rooms are also cleaned by age; this just stops token routing.
    return true;
  }

  setName(token, name) {
    const conn = this.conns.get(token);
    if (!conn) return;
    const clean = cleanName(name);
    if (!clean) {
      this.error(conn.ws, "name must contain at least one visible character", "bad_name");
      return;
    }
    const finalName = this.ladder.setName(token, clean);
    conn.profile.name = finalName;
    const queued = this.queue.get(token);
    if (queued) queued.profile = conn.profile;
    const room = this.roomFor(token);
    if (room) {
      const seat = this.seatFor(room, token);
      if (seat) {
        seat.name = finalName;
        seat.profile = conn.profile;
        const slot = room.seats.indexOf(seat);
        if (slot >= 0) room.match.soldiers[slot].name = finalName;
      }
      this.broadcastRoom(room);
    } else if (queued) {
      this.broadcastQueue();
    }
    this.sendState(token);
  }

  devClock(token, requested) {
    const conn = this.conns.get(token);
    if (!conn) return;
    if (!this.allowDevClock) {
      this.error(conn.ws, "server clocks are fixed by the deployment", "clock_locked");
      return;
    }
    for (const key of ["queueMs", "codeMs", "countdownMs"]) {
      const value = Number(requested && requested[key]);
      if (Number.isFinite(value)) this.clock[key] = Math.max(0, Math.round(value));
    }
    this.send(conn.ws, { type: "clock", clock: { ...this.clock }, serverTime: Date.now() });
    this.log.log("[clock] " + JSON.stringify(this.clock));
  }

  stats() {
    let humans = 0;
    for (const room of this.rooms.values()) {
      humans += room.seats.filter(seat => seat.kind === "human").length;
    }
    return {
      connections: this.conns.size,
      queued: this.queue.size,
      rooms: this.rooms.size,
      playersInRooms: humans,
      ladder: this.ladder.stats()
    };
  }
}

module.exports = { Hub, SIZE, VERSION, cleanName };
