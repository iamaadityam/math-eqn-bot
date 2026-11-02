/* Persistent local ladder for the hosted game.
   Humans are identified by an opaque client token; bots are long-lived ladder
   members so every player shares the same leaderboard. */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const BOT_NAMES = [
  "euler", "gauss", "newton", "noether", "riemann", "turing", "lovelace", "cantor",
  "hilbert", "laplace", "fourier", "maxwell", "galois", "ramanujan", "erdos", "poincare",
  "archimedes", "pythagoras", "descartes", "leibniz", "cauchy", "weierstrass", "bolzano", "lagrange",
  "jacobi", "hamilton", "abel", "dirichlet", "dedekind", "kronecker", "zeta", "lhopital"
];

const cleanName = value => String(value == null ? "" : value)
  .replace(/[\u0000-\u001f\u007f]/g, "")
  .trim()
  .slice(0, 20);

function defaultBots() {
  return BOT_NAMES.map((name, i) => ({
    id: "bot-" + name,
    name,
    rating: 760 + i * 26,
    matches: 0,
    wins: 0,
    kills: 0,
    points: 0,
    isBot: true
  }));
}

class Ladder {
  constructor(dataDir, log = console) {
    this.dir = dataDir;
    this.file = path.join(dataDir, "ladder.json");
    this.log = log;
    this.bots = [];
    this.players = new Map();
    this.synthetic = 0;
    this.load();
  }

  load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (Array.isArray(raw.bots)) this.bots = raw.bots;
        if (Array.isArray(raw.players)) {
          for (const player of raw.players) {
            if (player && player.id) this.players.set(player.id, player);
          }
        }
      }
    } catch (error) {
      this.log.error("[ladder] could not load:", error.message);
    }
    if (!this.bots.length) this.bots = defaultBots();
    // Add any newly introduced default bots without disturbing stored ratings.
    const known = new Set(this.bots.map(bot => bot.id));
    for (const bot of defaultBots()) if (!known.has(bot.id)) this.bots.push(bot);
    this.save();
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + ".tmp";
      const payload = JSON.stringify({ bots: this.bots, players: [...this.players.values()] }, null, 2);
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, this.file);
    } catch (error) {
      this.log.error("[ladder] could not save:", error.message);
    }
  }

  getProfile(token, preferredName) {
    let profile = this.players.get(token);
    if (!profile) {
      profile = {
        id: token,
        name: cleanName(preferredName) || "user-" + token.slice(-4),
        rating: 1000,
        matches: 0,
        wins: 0,
        kills: 0,
        points: 0,
        isBot: false,
        createdAt: Date.now(),
        lastSeen: Date.now()
      };
      this.players.set(token, profile);
      this.save();
    } else {
      profile.lastSeen = Date.now();
      const name = cleanName(preferredName);
      if (name && name !== profile.name) {
        profile.name = name;
        this.save();
      }
    }
    return profile;
  }

  setName(token, name) {
    const profile = this.getProfile(token);
    const clean = cleanName(name);
    if (!clean) return profile.name;
    if (clean !== profile.name) {
      profile.name = clean;
      this.save();
    }
    return profile.name;
  }

  leaderboard(forToken, limit = 200) {
    const rows = [
      ...this.bots.map(bot => ({ ...bot })),
      ...[...this.players.values()].map(player => ({ ...player }))
    ];
    rows.sort((a, b) =>
      (b.rating || 0) - (a.rating || 0) ||
      (b.wins || 0) - (a.wins || 0) ||
      (b.kills || 0) - (a.kills || 0) ||
      String(a.name).localeCompare(String(b.name))
    );
    return rows.slice(0, limit).map((row, index) => ({
      pos: index + 1,
      name: row.name,
      rating: row.rating,
      matches: row.matches || 0,
      wins: row.wins || 0,
      kills: row.kills || 0,
      points: row.points || 0,
      isBot: !!row.isBot,
      me: row.id === forToken
    }));
  }

  record(rows) {
    let changed = false;
    for (const row of rows) {
      if (row.isBot) {
        const bot = this.bots.find(item => item.id === row.id);
        if (!bot) continue;
        bot.rating = row.ratingAfter;
        bot.matches = (bot.matches || 0) + 1;
        bot.wins = (bot.wins || 0) + (row.rank === 1 ? 1 : 0);
        bot.kills = (bot.kills || 0) + row.kills;
        bot.points = (bot.points || 0) + row.points;
        changed = true;
      } else {
        const player = this.players.get(row.id);
        if (!player) continue;
        player.rating = row.ratingAfter;
        player.matches = (player.matches || 0) + 1;
        player.wins = (player.wins || 0) + (row.rank === 1 ? 1 : 0);
        player.kills = (player.kills || 0) + row.kills;
        player.points = (player.points || 0) + row.points;
        player.lastSeen = Date.now();
        changed = true;
      }
    }
    if (changed) this.save();
  }

  pickBot(average, used) {
    const pool = this.bots.filter(bot => !used.has(bot.id));
    if (pool.length) {
      const picked = pool
        .map(bot => ({ bot, distance: Math.abs((bot.rating || 1000) - average) + Math.random() * 85 }))
        .sort((a, b) => a.distance - b.distance)[0].bot;
      return { ...picked, isBot: true };
    }
    // The normal 32-bot pool is enough for six lobbies (max 9 bots are needed
    // in one matchmaking window), but stay safe if the pool is edited down.
    this.synthetic++;
    const name = "bot " + this.synthetic;
    const bot = {
      id: "synthetic-" + crypto.randomUUID(),
      name,
      rating: Math.max(600, Math.min(1800, Math.round(average + (Math.random() * 240 - 120)))),
      matches: 0,
      wins: 0,
      kills: 0,
      points: 0,
      isBot: true
    };
    this.bots.push(bot);
    this.save();
    return { ...bot };
  }

  stats() {
    return {
      humans: this.players.size,
      bots: this.bots.length
    };
  }
}

module.exports = { Ladder, cleanName, defaultBots, BOT_NAMES };
