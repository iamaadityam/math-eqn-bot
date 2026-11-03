/* WebSocket bridge to the authoritative graphshot server.
   Loaded after ui.js and before ranked.js. */
"use strict";

const NET = (() => {
  const query = new URLSearchParams(location.search);
  const queryToken = query.get("token");
  const queryName = query.get("name");
  const queryServer = query.get("server");
  const TOKEN_KEY = "gs-token-v2";
  const NAME_KEY = "gs-name-v1";

  const read = (key, fallback) => {
    try { return localStorage.getItem(key) || fallback; } catch (error) { return fallback; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, value); } catch (error) { /* ignore */ }
  };
  const makeToken = () => {
    try { return "p-" + crypto.randomUUID(); }
    catch (error) { return "p-" + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  };

  let token = queryToken && /^[A-Za-z0-9_.:-]{3,100}$/.test(queryToken)
    ? queryToken
    : read(TOKEN_KEY, makeToken());
  if (!queryToken) write(TOKEN_KEY, token);
  let name = (queryName || read(NAME_KEY, "user")).slice(0, 20);
  write(NAME_KEY, name);

  let socket = null;
  let state = null;
  let status = "offline";
  let connecting = null;
  let reconnectTimer = null;
  let retry = 0;
  let stopped = false;
  let offset = 0;
  let lastPhase = null;
  let rtt = 0;

  function url() {
    if (queryServer) return queryServer;
    if (location.protocol === "file:") return "ws://127.0.0.1:8787/ws";
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  }

  function setStatus(next) {
    if (status === next) return;
    status = next;
    emit("status", { status, connected: status === "online", url: url() });
  }

  function emitStatus() {
    emit("status", { status, connected: status === "online", url: url() });
  }

  function sendRaw(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      return false;
    }
  }

  function send(message) {
    if (!sendRaw(message)) throw new Error("not connected to the match server");
    return true;
  }

  function applyState(next) {
    if (!next || typeof next !== "object") return;
    state = next;
    offset = (next.serverTime || Date.now()) - Date.now();
    if (next.profile && next.profile.name) name = next.profile.name;
    write(NAME_KEY, name);
    if (window.GraphShot && typeof GraphShot.__applyServerState === "function") {
      try { GraphShot.__applyServerState(next); } catch (error) { console.error("state apply failed", error); }
    }
    emit("state", next);
    if (next.phase !== lastPhase) {
      lastPhase = next.phase;
      emit("phase", { phase: next.phase, state: next });
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(8000, Math.round(500 * Math.pow(1.7, retry++)));
    setStatus("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(() => {});
    }, delay);
  }

  function connect() {
    if (socket && socket.readyState === WebSocket.OPEN && state) return Promise.resolve(state);
    if (connecting) return connecting;
    setStatus("connecting");
    connecting = new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url());
      } catch (error) {
        connecting = null;
        setStatus("offline");
        reject(error);
        return;
      }
      socket = ws;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        connecting = null;
        try { ws.close(); } catch (error) { /* ignore */ }
        setStatus("offline");
        reject(new Error("could not reach the match server at " + url()));
      }, 8000);

      ws.onopen = () => {
        retry = 0;
        setStatus("online");
        sendRaw({ type: "hello", token, name });
        try {
          ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
        } catch (error) { /* ignore */ }
      };

      ws.onmessage = event => {
        let message;
        try { message = JSON.parse(event.data); }
        catch (error) { return; }
        if (message.type === "hello") {
          if (message.token) {
            token = message.token;
            if (!queryToken) write(TOKEN_KEY, token);
          }
          if (message.profile && message.profile.name) {
            name = message.profile.name;
            write(NAME_KEY, name);
          }
          return;
        }
        if (message.type === "state") {
          applyState(message.state);
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            connecting = null;
            resolve(message.state);
          }
          return;
        }
        if (message.type === "error") {
          emit("error", { message: message.message, code: message.code });
          if (!settled && /handshake|bad_json/.test(message.code || "")) {
            settled = true;
            clearTimeout(timeout);
            connecting = null;
            reject(new Error(message.message));
          }
          return;
        }
        if (message.type === "pong") {
          if (message.t) rtt = Math.max(0, Date.now() - message.t);
          return;
        }
        if (message.type === "clock") {
          emit("clock", message.clock);
        }
      };

      ws.onclose = () => {
        if (socket === ws) socket = null;
        setStatus("offline");
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          connecting = null;
          reject(new Error("match server closed the connection"));
        }
        scheduleReconnect();
      };

      ws.onerror = () => { /* close handler does the cleanup */ };
    });
    return connecting;
  }

  function disconnect() {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket) {
      try { socket.close(1000, "client disconnect"); } catch (error) { /* ignore */ }
    }
    socket = null;
    state = null;
    setStatus("offline");
  }

  function setName(value) {
    const clean = String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 20);
    if (!clean) throw new Error("name must contain at least one visible character");
    name = clean;
    write(NAME_KEY, name);
    if (socket && socket.readyState === WebSocket.OPEN) send({ type: "setName", name });
    return name;
  }

  const localTime = serverTime => Number(serverTime) - offset;
  const serverTime = () => Date.now() + offset;

  window.addEventListener("online", () => { connect().catch(() => {}); });
  window.addEventListener("offline", () => setStatus("offline"));

  const api = {
    connect,
    disconnect,
    send,
    get state() { return state; },
    get status() { return status; },
    get connected() { return status === "online"; },
    get token() { return token; },
    get name() { return name; },
    get rtt() { return rtt; },
    get url() { return url(); },
    setName,
    localTime,
    serverTime,
    applyState
  };
  window.GraphShotNet = api;
  return api;
})();
