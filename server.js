/* Graphshot hosted server — static site + authoritative WebSocket rooms.
   Run: npm start   (or PORT=8080 node server.js) */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { loadGame, ROOT } = require("./server/load-game");
const { Ladder } = require("./server/ladder");
const { Hub, VERSION } = require("./server/hub");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function resolveClock() {
  const fast = process.env.FAST === "1" || process.env.FAST === "true";
  return {
    fast,
    queueMs: fast ? 3000 : envNumber("QUEUE_MS", 30000),
    codeMs: fast ? 10000 : envNumber("CODE_MS", 120000),
    countdownMs: fast ? 1000 : envNumber("COUNTDOWN_MS", 3000)
  };
}

function createApp(options = {}) {
  const clock = options.clock || resolveClock();
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(ROOT, "data");
  const log = options.log || console;
  const game = options.game || loadGame();
  const ladder = options.ladder || new Ladder(dataDir, log);
  const hub = options.hub || new Hub({
    game,
    ladder,
    clock,
    log,
    allowDevClock: options.allowDevClock != null
      ? options.allowDevClock
      : process.env.ALLOW_CLOCK === "1"
  });

  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(body);
  };

  const serveStatic = (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch (error) {
      sendJson(res, 400, { error: "bad path" });
      return;
    }
    if (pathname === "/") pathname = "/index.html";
    const filePath = path.resolve(ROOT, "." + pathname);
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    fs.stat(filePath, (statError, stat) => {
      if (statError || !stat.isFile()) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || "application/octet-stream";
      const cache = ext === ".html" ? "no-store" : "public, max-age=60";
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": stat.size,
        "Cache-Control": cache,
        "X-Content-Type-Options": "nosniff"
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(filePath).pipe(res);
    });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        clock: { queueMs: clock.queueMs, codeMs: clock.codeMs, countdownMs: clock.countdownMs },
        ...hub.stats()
      });
      return;
    }
    if (url.pathname === "/api/leaderboard") {
      sendJson(res, 200, { rows: ladder.leaderboard(null, 200) });
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res);
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
  });

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 32 * 1024,
    perMessageDeflate: false,
    clientTracking: true
  });

  wss.on("connection", ws => {
    ws.__gsAlive = true;
    ws.on("pong", () => { ws.__gsAlive = true; });
    ws.on("message", data => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (error) {
        hub.error(ws, "invalid JSON", "bad_json");
        return;
      }
      try {
        hub.handle(ws, message);
      } catch (error) {
        log.error("[ws] handler error:", error);
        hub.error(ws, "internal server error", "internal");
      }
    });
    ws.on("close", () => hub.detach(ws));
    ws.on("error", () => { /* close handler cleans up */ });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.__gsAlive) {
        ws.terminate();
        continue;
      }
      ws.__gsAlive = false;
      try { ws.ping(); } catch (error) { /* ignore */ }
    }
  }, 30000);

  let started = false;
  function start(port = envNumber("PORT", 8787), host = process.env.HOST || "0.0.0.0") {
    if (started) return Promise.resolve(server.address());
    started = true;
    hub.start();
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        const address = server.address();
        log.log("graphshot server v" + VERSION + " on http://localhost:" + address.port);
        log.log("clock: queue " + clock.queueMs + "ms · code " + clock.codeMs +
          "ms · countdown " + clock.countdownMs + "ms" + (clock.fast ? " (FAST)" : ""));
        log.log("data: " + dataDir);
        resolve(address);
      });
    });
  }

  function close() {
    hub.stop();
    clearInterval(heartbeat);
    for (const ws of wss.clients) {
      try { ws.close(1001, "server shutting down"); } catch (error) { /* ignore */ }
    }
    return new Promise(resolve => wss.close(() => server.close(() => resolve())));
  }

  return { server, wss, hub, ladder, game, clock, dataDir, start, close };
}

if (require.main === module) {
  const app = createApp();
  app.start().catch(error => {
    console.error("could not start graphshot server:", error);
    process.exit(1);
  });
  const shutdown = () => {
    app.ladder.save();
    app.close().then(() => process.exit(0)).catch(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { createApp, resolveClock };
