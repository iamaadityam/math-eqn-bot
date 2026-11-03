/* =========================================================================
   graphshot ranked — online queue, authoritative rooms, simultaneous beams,
   results, and the GraphShot browser bot bridge. Loaded after ui.js + net.js.
   ========================================================================= */
"use strict";

const VERSION = "2.0.0";
let queueWaiters = [];
let lastQueueUi = 0;
let lastRankedUi = 0;
let netState = null;
let enteredRoom = null;
let shownResultRoom = null;
let wantQueue = false;
let userLeft = false;
let queueError = "";

function rankedSlot() { return ranked ? ranked.mySlot : 0; }
function hideResults() { $("results").classList.add("hidden"); }
function showResults() { $("results").classList.remove("hidden"); }

function currentProfile() {
  if (netState && netState.profile) return netState.profile;
  return getProfile();
}
function serverLeaderboard() {
  if (netState && Array.isArray(netState.leaderboard)) return netState.leaderboard;
  return getLeaderboard();
}
function applyProfileChrome(profile) {
  if (!profile) return;
  $("taskuser").textContent = profile.name + "@graphshot";
  document.querySelectorAll(".hello .type").forEach(el => { el.textContent = profile.name; });
  if (phase === "queue") $("qrating").textContent = "rating " + profile.rating;
}
function localTime(serverTimestamp) {
  if (!serverTimestamp) return 0;
  return NET.localTime(serverTimestamp);
}

/* ------------------------------------------------------------------ queue */
function queueSnapshotFallback() {
  const profile = currentProfile();
  const clock = (netState && netState.clock) || CLOCK;
  return {
    size: 10,
    humans: 1,
    enrolled: 1,
    lobbies: 1,
    botSeats: 9,
    endsAt: Date.now() + (clock.queueMs || 30000),
    players: [{ name: profile.name, rating: profile.rating, me: true }]
  };
}
function renderQueueSlots() {
  const q = queueState;
  if (!q) return;
  const players = Array.isArray(q.players) ? q.players : [];
  let html = "";
  for (let i = 0; i < 10; i++) {
    const player = players[i];
    if (!player) {
      html += '<div class="qslot empty"><div class="rn">seat ' + (i + 1) +
        '</div><div class="rr">bot fills at lock</div></div>';
      continue;
    }
    html += '<div class="qslot' + (player.me ? " you" : "") + '">' +
      '<div class="rn">' + esc(player.name) + (player.me ? ' <span class="tag you">you</span>' : '') +
      '</div><div class="rr">' + player.rating + ' rating</div></div>';
  }
  if (players.length > 10) {
    html += '<div class="qslot" style="grid-column:1/-1"><div class="rn">+' +
      (players.length - 10) + ' more queued</div><div class="rr">more lobbies lock at the same time</div></div>';
  }
  $("qslots").innerHTML = html;
}
function updateQueueUI(now) {
  if (phase !== "queue" || !queueState) return;
  const q = queueState;
  const left = Math.max(0, (q.endsAt || 0) - now);
  $("qtimer").textContent = fmtTime(left);
  if (queueError) {
    $("qtext").textContent = "⚠ " + queueError;
  } else if (NET.status === "offline" || NET.status === "reconnecting") {
    $("qtext").textContent = "reconnecting to the match server…";
  } else if (left <= 0) {
    $("qtext").textContent = "locking the lobby…";
  } else if (left <= 5000) {
    $("qtext").textContent = "one last look at the ladder…";
  } else if (left <= 15000) {
    $("qtext").textContent = "sorting ratings, balancing lobbies…";
  } else {
    $("qtext").textContent = "scanning the ladder…";
  }
  const humans = q.humans || 1;
  const lobbies = q.lobbies || Math.ceil(humans / 10);
  const bots = q.botSeats != null ? q.botSeats : Math.max(0, lobbies * 10 - humans);
  $("qcount").textContent = humans + " human" + (humans === 1 ? "" : "s") + " queued · " +
    lobbies + " lobby" + (lobbies === 1 ? "" : "s") + " · " +
    bots + " bot seat" + (bots === 1 ? "" : "s");
  $("qrating").textContent = "rating " + currentProfile().rating;
  renderQueueSlots();
}
function showQueueScreen() {
  $("qrating").textContent = "rating " + currentProfile().rating;
  $("qmeta").textContent = "10 players per lobby · empty seats become skill-matched bots";
  $("qtimer").textContent = fmtTime((queueState && queueState.endsAt ? queueState.endsAt : Date.now()) - Date.now());
  $("qcount").textContent = "";
  $("qtext").textContent = "scanning the ladder…";
  renderQueueSlots();
  show("queue");
}
function startQueue() {
  if (phase === "queue") return;
  if (ranked && ["code", "countdown", "combat"].includes(phase)) {
    setStatus("⚠ match in progress — finish the lobby first.", "err");
    return;
  }
  hideResults();
  shownResultRoom = null;
  userLeft = false;
  queueError = "";
  wantQueue = true;
  if (phase === "practice" || phase === "tutorial") {
    if (anim) { clearInterval(anim); anim = null; }
  }
  if (phase === "result") {
    enteredRoom = null;
    ranked = null;
    M = null;
  }
  queueState = queueSnapshotFallback();
  phase = "queue";
  view = "queue";
  showQueueScreen();
  updateQueueUI(Date.now());
  announcePhase();

  NET.connect()
    .then(() => {
      if (wantQueue && phase === "queue") NET.send({ type: "queue" });
    })
    .catch(error => {
      if (phase !== "queue") return;
      queueState = queueSnapshotFallback();
      queueState.endsAt = Date.now();
      queueError = error.message;
      $("qtext").textContent = "⚠ " + error.message;
      $("qmeta").textContent = NET.url;
      const err = new Error(error.message);
      for (const waiter of queueWaiters) {
        try { waiter.reject(err); } catch (ignored) { /* ignore */ }
      }
      queueWaiters = [];
    });
}
function cancelQueue(rejectWaiters = true) {
  if (phase !== "queue") return;
  wantQueue = false;
  queueError = "";
  try { NET.send({ type: "cancelQueue" }); } catch (error) { /* offline */ }
  queueState = null;
  phase = "idle";
  view = "home";
  if (rejectWaiters) {
    const error = new Error("queue cancelled");
    for (const waiter of queueWaiters) {
      try { waiter.reject(error); } catch (ignored) { /* ignore */ }
    }
  }
  queueWaiters = [];
  show("home");
  announcePhase();
}

/* ----------------------------------------------------------- match apply */
function buildMatch(mm) {
  return {
    id: mm.id,
    ranked: true,
    mode: "normal",
    relative: true,
    terrain: clone(mm.terrain),
    zones: [],
    soldiers: mm.soldiers.map(soldier => ({
      ...soldier,
      alive: soldier.alive !== false,
      health: soldier.health != null ? soldier.health : 100,
      maxHealth: soldier.maxHealth != null ? soldier.maxHealth : 100,
      expression: soldier.expression || "",
      ready: !!soldier.ready,
      team: "ffa",
      kind: soldier.isBot ? "bot" : "player"
    })),
    avgRating: mm.avgRating,
    round: mm.round || 1,
    shots: 0,
    friendly: 0,
    over: mm.phase === "result",
    phase: mm.phase,
    submissions: mm.submissions || null
  };
}
function computeResolution(match, submissions) {
  if (!submissions) return null;
  try {
    return resolveRanked(match, submissions);
  } catch (error) {
    console.error("local combat replay failed", error);
    return null;
  }
}
function enterRoomUI(s) {
  const mm = s.match;
  $("gtitle").textContent = "Ranked";
  $("gwin").textContent = "ranked.exe";
  $("settings").classList.add("hidden");
  $("tut").classList.add("hidden");
  $("rankedhud").classList.remove("hidden");
  $("practicelegend").classList.add("hidden");
  $("rankedlegend").classList.remove("hidden");
  $("fields").classList.add("hidden");
  hideResults();
  inp.value = "";
  $("angle").value = "0";
  inp.disabled = false;
  $("angle").disabled = true;
  $("fire").textContent = "lock in";
  $("fire").disabled = false;
  $("feed").innerHTML = "<span>all ten cannons are loaded.</span>";
  $("lobbylabel").textContent = "lobby · avg " + mm.avgRating + " · 10 players";
  $("roster").innerHTML = "";
  renderTerrain();
  setMode();
  updateOffset();
  updateStats();
  setStatus("match found. 10-player lobby locked — write an equation, then <b>lock in</b>. Everyone fires at the same instant.", "ok");
  view = "ranked";
  show("game");
  if (!userLeft) inp.focus();
}
function settleQueueWaiters() {
  if (!queueWaiters.length) return;
  const state = getState();
  const waiters = queueWaiters;
  queueWaiters = [];
  for (const waiter of waiters) {
    try { waiter.resolve(state); } catch (ignored) { /* ignore */ }
  }
}
function applyMatchState(s) {
  const mm = s.match;
  const isNew = enteredRoom !== mm.id;
  if (isNew) {
    enteredRoom = mm.id;
    shownResultRoom = null;
    userLeft = false;
    queueState = null;
    wantQueue = false;
    M = buildMatch(mm);
    ranked = {
      match: M,
      mySlot: mm.mySlot,
      phase: mm.phase,
      round: mm.round || 1,
      codeEndsAt: localTime(mm.codeEndsAt),
      countdownEndsAt: localTime(mm.countdownEndsAt),
      combatStartedAt: localTime(mm.combatStartedAt),
      resolution: null,
      result: null,
      feedShown: new Set(),
      feedItems: [],
      humanLocked: false
    };
    enterRoomUI(s);
  } else {
    const previous = ranked.phase;
    const mmPhase = mm.phase;
    const newRound = !!mm.round && mm.round !== ranked.round;
    M.soldiers = mm.soldiers.map(soldier => ({
      ...soldier,
      alive: soldier.alive !== false,
      health: soldier.health != null ? soldier.health : 100,
      maxHealth: soldier.maxHealth != null ? soldier.maxHealth : 100,
      expression: soldier.expression || "",
      ready: !!soldier.ready,
      team: "ffa",
      kind: soldier.isBot ? "bot" : "player"
    }));
    M.avgRating = mm.avgRating;
    M.phase = mm.phase;
    M.over = mm.phase === "result";
    M.round = mm.round || ranked.round;
    M.submissions = mm.submissions || null;
    ranked.match = M;
    ranked.mySlot = mm.mySlot;
    ranked.round = mm.round || ranked.round;
    ranked.codeEndsAt = localTime(mm.codeEndsAt);
    ranked.countdownEndsAt = localTime(mm.countdownEndsAt);
    if (mm.combatStartedAt) ranked.combatStartedAt = localTime(mm.combatStartedAt);
    ranked.roundHealth = M.soldiers.map(soldier => soldier.health);
    if (newRound) {
      ranked.resolution = null;
      ranked.result = null;
      ranked.feedShown = new Set();
      ranked.feedItems = [];
      const human = M.soldiers[ranked.mySlot];
      if (human && human.health > 0) {
        inp.value = "";
        inp.disabled = false;
        $("fire").disabled = false;
        $("fire").textContent = "lock in";
      } else {
        inp.disabled = true;
        $("fire").disabled = true;
        $("fire").textContent = "locked";
        setStatus("you were eliminated in round " + (M.round - 1) + ". waiting for the lobby…", "err");
      }
      setStatus("round " + M.round + " — cannons repositioned. write an equation, then <b>lock in</b>.", "ok");
      $("feed").innerHTML = "<span>round " + M.round + " — all cannons repositioned.</span>";
    }
    if (previous !== mm.phase) {
      if (mm.phase === "countdown") {
        inp.disabled = true;
        $("fire").disabled = true;
        $("fire").textContent = "locked";
        setStatus("all ten locked. <b>every cannon fires at the same instant.</b>", "ok");
      } else if (mm.phase === "combat") {
        inp.disabled = true;
        $("fire").disabled = true;
        $("fire").textContent = "locked";
        $("feed").innerHTML = "";
        ranked.feedShown = new Set();
        ranked.feedItems = [];
        setStatus("💥 all ten beams are live. if a shooter dies, their beam dies with them.", "");
      } else if (mm.phase === "result") {
        inp.disabled = true;
        $("fire").disabled = true;
        setStatus("lobby finished. every kill and placement paid out.", "ok");
      }
    }
    ranked.phase = mm.phase;
  }

  ranked.phase = mm.phase;
  phase = mm.phase;
  if (mm.phase !== "result") queueError = "";

  if (mm.submissions && (mm.phase === "combat" || mm.phase === "result")) {
    const local = computeResolution(M, mm.submissions);
    if (local) {
      ranked.resolution = local;
      if (mm.phase === "combat") {
        ranked.result = null;
      }
    }
  }

  if (mm.phase === "result") {
    const local = ranked.resolution;
    const rows = s.result ? s.result.rows : null;
    if (rows) {
      ranked.result = {
        ...(local || {}),
        rows,
        endTime: s.result.endTime || (local ? local.endTime : 0)
      };
    }
    if (ranked.result && shownResultRoom !== mm.id) {
      shownResultRoom = mm.id;
      renderResults();
      if (view === "ranked" || view === "game") showResults();
    }
  }

  if (userLeft && isNew) userLeft = false;
  updateRankedUI(Date.now(), true);
  drawRanked();
  settleQueueWaiters();
}

function applyServerState(s) {
  if (!s) return;
  netState = s;
  if (s.clock) {
    for (const key of ["queueMs", "codeMs", "countdownMs"]) {
      if (Number.isFinite(s.clock[key])) CLOCK[key] = s.clock[key];
    }
  }
  applyProfileChrome(s.profile);

  if (s.phase === "queue") {
    if (phase === "practice" || phase === "tutorial") {
      // A server-side queue only exists after this tab queued, so adopt it.
    }
    const q = s.queue || {};
    queueState = {
      ...q,
      endsAt: localTime(q.endsAt) || Date.now()
    };
    phase = "queue";
    view = "queue";
    wantQueue = true;
    queueError = "";
    if ($("queue").classList.contains("hidden")) {
      hideResults();
      showQueueScreen();
    }
    updateQueueUI(Date.now());
    emitState();
    return;
  }

  if (s.match) {
    applyMatchState(s);
    return;
  }

  // idle
  if (wantQueue) {
    // The socket reconnected after the queue was dropped, or the first queue
    // frame arrived before the handshake finished. Rejoin the same window.
    phase = "queue";
    view = "queue";
    queueError = "";
    if ($("queue").classList.contains("hidden")) showQueueScreen();
    try { NET.send({ type: "queue" }); } catch (error) { /* retry on next state */ }
    emitState();
    return;
  }
  queueState = null;
  if (enteredRoom) {
    enteredRoom = null;
    ranked = null;
    M = null;
    if (phase !== "practice" && phase !== "tutorial") phase = "idle";
  }
  if (phase === "queue") {
    phase = "idle";
    if (view === "queue") { view = "home"; show("home"); }
  }
  if ((view === "ranked" || view === "game") && phase !== "practice" && phase !== "tutorial") {
    view = "home";
    show("home");
  }
  emitState();
}

/* --------------------------------------------------------------- roster */
function renderRoster(now) {
  if (!ranked) return;
  const r = ranked;
  const m = r.match;
  const t = r.phase === "combat"
    ? Math.max(0, (now - r.combatStartedAt) / 1000)
    : r.phase === "result" ? 1e9 : 0;
  const healthAt = (s, time) => {
    if (r.phase === "code" || r.phase === "countdown") return s.health;
    if (!r.resolution) return s.health;
    if (r.phase !== "combat" && r.phase !== "result") return s.health;
    const start = r.roundHealth ? r.roundHealth[s.slot] : s.health;
    let h = start;
    for (const ev of (r.resolution.hitEvents || [])) {
      if (ev.target === s.slot && time >= ev.time) h -= ev.amount;
    }
    return Math.max(0, h);
  };
  $("roster").innerHTML = m.soldiers.map(s => {
    const h = healthAt(s, t);
    const deadNow = r.phase !== "code" && r.phase !== "countdown" && h <= 0;
    const kills = r.resolution ? (r.resolution.kills[s.slot] || 0) : 0;
    let status = "coding";
    if (r.phase === "code" || r.phase === "countdown") {
      status = s.ready ? "locked" : (s.slot === r.mySlot ? "coding" : "computing");
    } else if (r.phase === "combat" || r.phase === "result") {
      const by = r.resolution && r.resolution.killedBy[s.slot] != null
        ? m.soldiers[r.resolution.killedBy[s.slot]] : null;
      status = deadNow ? ("dead" + (by ? " · by " + by.name : "")) : ("alive · " + kills + " kills · " + Math.round(h) + "/" + (s.maxHealth || 100));
    }
    const tag = s.slot === r.mySlot
      ? '<span class="tag you">you</span>'
      : s.isBot ? '<span class="tag bot">bot</span>' : '<span class="tag">player</span>';
    const cls = [deadNow ? "dead" : "", s.ready && !deadNow ? "ready" : "",
      s.slot === r.mySlot ? "you" : ""].filter(Boolean).join(" ");
    return '<div class="pcard ' + cls + '" data-slot="' + s.slot +
      '" title="' + esc(s.name) + ' · ' + s.rating + ' rating">' +
      '<div class="nm"><i class="pdot" style="background:' + s.color + '"></i><span>' +
      esc(s.name) + '</span>' + tag + '</div>' +
      '<div class="meta"><span>' + s.rating + '</span><span>' + esc(status) + '</span></div>' +
      '<div class="hpwrap"><i class="hpfill" style="width:' + Math.max(0, Math.min(100, (h / (s.maxHealth || 100)) * 100)) + '%"></i></div>';
  }).join("");
  updateStats();
}
function renderFeed() {
  if (!ranked) return;
  const items = ranked.feedItems.slice(-6);
  $("feed").innerHTML = items.length
    ? items.map(x => '<span><span class="k">' + esc(x.a) + '</span> ⚡ ' + esc(x.b) + '</span>').join("")
    : '<span>all ten beams are live.</span>';
}
function updateRankedUI(now, force) {
  if (!ranked) return;
  const r = ranked;
  const badge = $("phasebadge");
  badge.classList.remove("live", "dead");
  if (r.phase === "code") {
    badge.textContent = "code";
    $("ctimer").textContent = fmtTime(Math.max(0, r.codeEndsAt - now));
    const human = r.match.soldiers[r.mySlot];
    $("fire").textContent = human.ready ? "locked" : "lock in";
    $("fire").disabled = !(human && human.health > 0 && !human.ready);
    inp.disabled = !(human && human.health > 0 && !human.ready);
  } else if (r.phase === "countdown") {
    badge.textContent = "fire";
    badge.classList.add("live");
    $("ctimer").textContent = fmtTime(Math.max(0, r.countdownEndsAt - now));
    $("fire").textContent = "locked";
    $("fire").disabled = true;
    inp.disabled = true;
  } else if (r.phase === "combat") {
    badge.textContent = "live";
    badge.classList.add("live");
    $("ctimer").textContent = "LIVE";
    $("fire").disabled = true;
    inp.disabled = true;
  } else if (r.phase === "result") {
    badge.textContent = "done";
    $("ctimer").textContent = "END";
    $("fire").disabled = true;
    inp.disabled = true;
  }
  const alive = r.phase === "combat" && r.resolution
    ? r.match.soldiers.filter((s, i) => r.resolution.deathAt[i] == null).length
    : r.match.soldiers.filter(s => s.health > 0).length;
  $("lobbylabel").textContent = "round " + (r.round || 1) + " · avg " + r.match.avgRating + " · " + alive + " alive";
  if (r.phase === "combat" || r.phase === "result") {
    const t = r.phase === "combat" ? (now - r.combatStartedAt) / 1000 : 1e9;
    collectFeed(t);
  }
  renderRoster(now);
}

/* ------------------------------------------------------------ combat draw */
function pathPointAt(pts, cum, distance) {
  if (distance <= 0) return pts[0];
  const last = cum[cum.length - 1];
  if (distance >= last) return pts[pts.length - 1];
  let lo = 1, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < distance) lo = mid + 1;
    else hi = mid;
  }
  const index = lo;
  const segment = cum[index] - cum[index - 1];
  const k = segment ? (distance - cum[index - 1]) / segment : 0;
  return [
    pts[index - 1][0] + (pts[index][0] - pts[index - 1][0]) * k,
    pts[index - 1][1] + (pts[index][1] - pts[index - 1][1]) * k
  ];
}
function drawPathUpTo(pts, cum, distance, color, width) {
  if (distance <= 0 || pts.length < 2) return;
  const last = cum[cum.length - 1];
  const head = pathPointAt(pts, cum, Math.min(distance, last));
  let i = 1;
  while (i < cum.length && cum[i] <= distance) i++;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "#141211";
  ctx.lineWidth = width + 3;
  ctx.beginPath();
  ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
  for (let j = 1; j < i; j++) ctx.lineTo(X(pts[j][0]), Y(pts[j][1]));
  ctx.lineTo(X(head[0]), Y(head[1]));
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
  for (let j = 1; j < i; j++) ctx.lineTo(X(pts[j][0]), Y(pts[j][1]));
  ctx.lineTo(X(head[0]), Y(head[1]));
  ctx.stroke();
  return head;
}
function collectFeed(t) {
  if (!ranked || !ranked.resolution) return;
  let added = false;
  ranked.resolution.events.forEach((event, index) => {
    if (event.time > t || ranked.feedShown.has(index)) return;
    ranked.feedShown.add(index);
    const a = ranked.match.soldiers[event.shooter].name;
    const b = ranked.match.soldiers[event.target].name;
    ranked.feedItems.push({ a, b, time: event.time });
    added = true;
  });
  if (added) renderFeed();
}
function drawRanked() {
  if (!ranked) return;
  const r = ranked;
  const m = r.match;
  const t = r.phase === "combat"
    ? (Date.now() - r.combatStartedAt) / 1000
    : r.phase === "result" ? (r.resolution ? r.resolution.endTime + 1 : 0) : 0;
  const hFor = (s, time) => {
    if (r.phase === "code" || r.phase === "countdown") return s.health;
    if (!r.resolution) return s.health;
    if (r.phase !== "combat" && r.phase !== "result") return s.health;
    const start = r.roundHealth ? r.roundHealth[s.slot] : s.health;
    let h = start;
    for (const ev of (r.resolution.hitEvents || [])) {
      if (ev.target === s.slot && time >= ev.time) h -= ev.amount;
    }
    return Math.max(0, h);
  };
  drawBaseField();

  ctx.textAlign = "left";
  ctx.font = "bold 10px " + MONO;
  ctx.fillStyle = "#a49a82";
  ctx.fillText("fires →", X(CFG.XMIN) + 8, Y(14) + 14);
  ctx.textAlign = "right";
  ctx.fillText("← fires", X(CFG.XMAX) - 8, Y(14) + 14);

  if (r.resolution && (r.phase === "combat" || r.phase === "result")) {
    for (let i = 0; i < m.soldiers.length; i++) {
      const beam = r.resolution.beams[i];
      if (!beam) continue;
      const death = r.resolution.deathAt[i];
      const end = Math.min(death != null ? death : beam.pathEndAt, beam.pathEndAt);
      const travelled = Math.min(t, end) * CFG.BEAM_SPEED;
      if (travelled <= 0) continue;
      const soldier = m.soldiers[i];
      const width = i === r.mySlot ? 3.4 : 2.2;
      const head = drawPathUpTo(beam.pts, beam.cum, travelled, soldier.color, width);
      if (head && t < end && r.phase === "combat") {
        ctx.fillStyle = "#141211";
        ctx.beginPath();
        ctx.arc(X(head[0]), Y(head[1]), 6, 0, 7);
        ctx.fill();
        ctx.fillStyle = soldier.color;
        ctx.beginPath();
        ctx.arc(X(head[0]), Y(head[1]), 3.4, 0, 7);
        ctx.fill();
      }
      if (death != null) {
        const dt = t - death;
        if (dt >= 0 && dt < 0.7) {
          const px = X(soldier.x), py = Y(soldier.y), rad = 6 + dt * 38;
          ctx.globalAlpha = 1 - dt / 0.7;
          ctx.strokeStyle = soldier.color;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(px, py, rad, 0, 7);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  ctx.textAlign = "center";
  ctx.font = "bold 10px " + MONO;
  m.soldiers.forEach(s => {
    const px = X(s.x), py = Y(s.y);
    const h = hFor(s, t);
    const deadNow = r.phase !== "code" && r.phase !== "countdown" && h <= 0;
    if (deadNow) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(px - 6, py - 6);
      ctx.lineTo(px + 6, py + 6);
      ctx.moveTo(px + 6, py - 6);
      ctx.lineTo(px - 6, py + 6);
      ctx.stroke();
    } else {
      ctx.fillStyle = s.color;
      ctx.strokeStyle = "#141211";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, 7);
      ctx.fill();
      ctx.stroke();
      if (s.slot === r.mySlot) {
        ctx.strokeStyle = "#141211";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 10, 0, 7);
        ctx.stroke();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, 10, 0, 7);
        ctx.stroke();
      }
      const dir = s.dir || 1;
      ctx.strokeStyle = "#141211";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(px + dir * 8, py);
      ctx.lineTo(px + dir * 15, py);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px + dir * 15, py);
      ctx.lineTo(px + dir * 11, py - 3);
      ctx.moveTo(px + dir * 15, py);
      ctx.lineTo(px + dir * 11, py + 3);
      ctx.stroke();
    }
    const label = s.slot === r.mySlot ? "YOU" : s.name;
    const hmax = s.maxHealth || 100;
    const hpY = py - 29;
    ctx.strokeStyle = "#141211";
    ctx.lineWidth = 2;
    ctx.strokeRect(px - 13, hpY, 26, 4);
    ctx.fillStyle = h > 0 ? "#3fcf6b" : "#ff5a4d";
    ctx.fillRect(px - 13, hpY, Math.max(0, (26 * h) / hmax), 4);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#fbf7ec";
    ctx.strokeText(label, px, py - 15);
    ctx.fillStyle = deadNow ? "#8c8574" : "#141211";
    ctx.fillText(label, px, py - 15);
    if (s.slot === r.mySlot) {
      const glow = document.getElementById("pointerglow");
      const rect = cv.getBoundingClientRect();
      if (glow) {
        glow.style.transform = `translate(${rect.left + px}px,${rect.top + py}px)`;
        glow.classList.add("on");
      }
    }
  });
  if (r.phase === "combat") collectFeed(t);
}

/* --------------------------------------------------------------- results */
function renderResults() {
  if (!ranked || !ranked.result) return;
  const res = ranked.result;
  const me = res.rows.find(row => row.slot === ranked.mySlot);
  const winner = res.rows.find(row => row.rank === 1);
  $("resulttitle").textContent = winner && winner.slot === ranked.mySlot
    ? "you win the lobby."
    : (winner ? winner.name + " wins the lobby." : "lobby complete.");
  $("resultsub").innerHTML = me
    ? "you placed <b>#" + me.rank + "</b> · <b>" + me.points + "</b> points · rating " +
      me.rating + " → <b>" + me.ratingAfter + "</b> (" + (me.delta >= 0 ? "+" : "") +
      me.delta + ") · kills " + me.kills + " · survived " + me.survived.toFixed(1) + "s"
    : "";
  $("resultbody").innerHTML = '<table class="scoretable"><thead><tr>' +
    '<th>#</th><th>player</th><th>rating</th><th>kills</th><th>survived</th><th>points</th><th>rating Δ</th>' +
    '</tr></thead><tbody>' +
    res.rows.map(row =>
      '<tr class="' + (row.slot === ranked.mySlot ? "me" : "") + '">' +
      '<td>' + row.rank + '</td>' +
      '<td><span class="pdot" style="display:inline-block;background:' + row.color +
      ';margin-right:5px"></span>' + esc(row.name) +
      (row.slot === ranked.mySlot ? ' <span class="tag you">you</span>' : row.isBot ? ' <span class="tag bot">bot</span>' : '') +
      '</td><td>' + row.rating + '</td><td>' + row.kills + '</td>' +
      '<td>' + (row.alive ? "survived" : row.survived.toFixed(1) + "s") + '</td>' +
      '<td>' + row.points + '</td>' +
      '<td class="' + (row.delta >= 0 ? "up" : "down") + '">' +
      (row.delta >= 0 ? "+" : "") + row.delta + '</td></tr>').join("") +
    '</tbody></table>';
}

/* ------------------------------------------------------------------- API */
function planShot() {
  if (!ranked || phase !== "code") throw new Error("planShot() needs a ranked code phase");
  const plan = chooseBotShot(ranked.match, ranked.mySlot, { skill: 1 });
  return {
    expression: plan.expression,
    angle: 0,
    targetSlot: plan.targetSlot,
    expectedKills: plan.expectedKills
  };
}
function localLock(expression) {
  const r = ranked;
  if (!r) return;
  const soldier = r.match.soldiers[r.mySlot];
  soldier.expression = expression;
  soldier.ready = true;
  r.humanLocked = true;
  inp.disabled = true;
  $("fire").disabled = true;
  $("fire").textContent = "locked";
  setStatus("locked. waiting for the rest of the lobby…", "ok");
  updateRankedUI(Date.now(), true);
}
function lockIn() {
  if (phase === "practice" || phase === "tutorial") {
    firePractice();
    return true;
  }
  if (phase !== "code" || !ranked) return false;
  const soldier = ranked.match.soldiers[ranked.mySlot];
  if (!soldier || soldier.health <= 0) {
    setStatus("you are out of the fight — health 0.", "err");
    return false;
  }
  if (soldier.ready) return true;
  const expression = inp.value.trim();
  if (!expression) {
    setStatus("⚠ type an equation before locking in.", "err");
    return false;
  }
  try {
    compile(expression, allowedFor("normal"));
  } catch (error) {
    setStatus("⚠ " + error.message, "err");
    return false;
  }
  try {
    NET.send({ type: "submit", expression, lock: true });
  } catch (error) {
    setStatus("⚠ " + error.message, "err");
    return false;
  }
  localLock(expression);
  emitState();
  return true;
}
function submitShot(options = {}) {
  if (phase === "code" && ranked) {
    const expression = options.expression != null ? String(options.expression) : inp.value;
    if (options.expression != null) inp.value = expression;
    updateOffset();
    let ok = true;
    if (expression.trim()) {
      try {
        compile(expression, allowedFor("normal"));
      } catch (error) {
        setStatus("⚠ " + error.message, "err");
        ok = false;
      }
    }
    if (ok) {
      try {
        NET.send({ type: "submit", expression, lock: !!options.lock });
        if (options.lock && expression.trim()) localLock(expression);
      } catch (error) {
        setStatus("⚠ " + error.message, "err");
        ok = false;
      }
    }
    return { ok, state: getState() };
  }
  if (phase === "practice" || phase === "tutorial") {
    if (options.expression != null) inp.value = String(options.expression);
    updateOffset();
    if (options.fire) firePractice();
    return { ok: true, state: getState() };
  }
  throw new Error("submitShot() is only available while coding or practising");
}
function waitForPhase(target, timeoutMs = 0) {
  if (phase === target) return Promise.resolve(getState());
  return new Promise((resolve, reject) => {
    let timer = null;
    const off = onEvent("phase", detail => {
      if (detail.phase !== target) return;
      cleanup();
      resolve(getState());
    });
    const cleanup = () => { off(); if (timer) clearTimeout(timer); };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for phase " + target));
      }, timeoutMs);
    }
  });
}
function waitFor(event, predicate, timeoutMs = 0) {
  if (typeof predicate === "number") { timeoutMs = predicate; predicate = null; }
  return new Promise((resolve, reject) => {
    let timer = null;
    const off = onEvent(event, detail => {
      if (predicate && !predicate(detail)) return;
      cleanup();
      resolve(detail);
    });
    const cleanup = () => { off(); if (timer) clearTimeout(timer); };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for " + event));
      }, timeoutMs);
    }
  });
}
function findMatch() {
  if (phase === "queue") {
    return new Promise((resolve, reject) => queueWaiters.push({ resolve, reject }));
  }
  if (phase === "code" || phase === "countdown") return Promise.resolve(getState());
  if (phase === "combat") return Promise.reject(new Error("a match is already running"));
  return new Promise((resolve, reject) => {
    queueWaiters.push({ resolve, reject });
    startQueue();
  });
}
function setNameRemote(name) {
  const clean = setName(name);
  try { NET.setName(clean); } catch (error) { /* not connected */ }
  if (netState && netState.profile) netState.profile.name = clean;
  applyProfileChrome(netState && netState.profile ? netState.profile : { ...getProfile(), name: clean });
  emitState();
  return GraphShot.getProfile();
}
function getProfileView() {
  if (netState && netState.profile) return { ...netState.profile };
  return getProfile();
}
function getLeaderboardView() {
  return serverLeaderboard();
}
function matchSnapshot() {
  if (ranked) {
    const r = ranked;
    const m = r.match;
    const now = Date.now();
    return {
      id: m.id,
      ranked: true,
      phase: r.phase,
      mode: "normal",
      relative: true,
      mySlot: r.mySlot,
      avgRating: m.avgRating,
      round: m.round || r.round || 1,
      codeLeftMs: r.phase === "code" ? Math.max(0, r.codeEndsAt - now) : 0,
      countdownLeftMs: r.phase === "countdown" ? Math.max(0, r.countdownEndsAt - now) : 0,
      combatT: r.phase === "combat" ? (now - r.combatStartedAt) / 1000 :
        r.phase === "result" ? (r.resolution ? r.resolution.endTime : 0) : 0,
      terrain: clone(m.terrain),
      zones: [],
      soldiers: m.soldiers.map(soldier => ({
        slot: soldier.slot,
        id: soldier.id,
        name: soldier.name,
        rating: soldier.rating,
        isBot: soldier.isBot,
        alive: soldier.alive,
        health: soldier.health,
        maxHealth: soldier.maxHealth,
        x: soldier.x,
        y: soldier.y,
        dir: soldier.dir,
        color: soldier.color,
        ready: !!soldier.ready,
        expression: soldier.expression || null,
        targetSlot: null
      })),
      submissions: m.submissions || null,
      result: r.result ? { endTime: r.result.endTime, rows: r.result.rows } : null
    };
  }
  if (M) {
    return {
      id: "practice",
      ranked: false,
      phase,
      mode: M.mode,
      relative: !!M.relative,
      mySlot: 0,
      terrain: clone(M.terrain),
      zones: clone(M.zones || []),
      soldiers: M.soldiers.map((soldier, index) => ({
        slot: index,
        name: soldier.team,
        team: soldier.team,
        kind: soldier.kind,
        alive: soldier.alive,
        x: soldier.x,
        y: soldier.y
      })),
      shots: M.shots,
      over: M.over
    };
  }
  return null;
}
function getState() {
  const now = Date.now();
  const top = getLeaderboardView().slice(0, 10).map(row => ({
    pos: row.pos, name: row.name, rating: row.rating, wins: row.wins,
    kills: row.kills, isBot: row.isBot, me: row.me
  }));
  return {
    version: VERSION,
    screen: view,
    phase,
    now,
    connected: NET.connected,
    server: { url: NET.url, status: NET.status, latencyMs: NET.rtt },
    profile: getProfileView(),
    options: getOptions(),
    clock: (netState && netState.clock) || { ...CLOCK },
    queue: queueState ? {
      size: 10,
      humans: queueState.humans || 1,
      enrolled: queueState.enrolled || queueState.humans || 1,
      lobbies: queueState.lobbies || 1,
      botSeats: queueState.botSeats != null ? queueState.botSeats : 9,
      timeLeftMs: Math.max(0, (queueState.endsAt || now) - now),
      endsAt: queueState.endsAt,
      players: (queueState.players || []).map(player => ({ ...player }))
    } : null,
    match: matchSnapshot(),
    result: ranked && ranked.result
      ? { rows: ranked.result.rows, endTime: ranked.result.endTime }
      : null,
    leaderboard: top
  };
}
function getMap() {
  if (!M) return null;
  const slot = M.ranked ? rankedSlot() : 0;
  let bounds = { xmin: CFG.XMIN, xmax: CFG.XMAX, ymin: CFG.YMIN, ymax: CFG.YMAX };
  let localSoldiers = null;
  try {
    const local = localWorldFor(M, slot);
    bounds = local.bounds;
    localSoldiers = local.match.soldiers;
  } catch (error) { /* ignore */ }
  return {
    ranked: !!M.ranked,
    mode: M.mode,
    relative: !!M.relative,
    mySlot: slot,
    bounds,
    terrain: clone(M.terrain),
    zones: clone(M.zones || []),
    soldiers: M.soldiers.map((soldier, index) => ({
      slot: index,
      id: soldier.id,
      name: soldier.name,
      team: soldier.team,
      kind: soldier.kind,
      alive: soldier.alive,
      health: soldier.health,
      maxHealth: soldier.maxHealth,
      x: soldier.x,
      y: soldier.y,
      dir: soldier.dir,
      rating: soldier.rating,
      isBot: soldier.isBot,
      color: soldier.color
    })),
    localSoldiers: localSoldiers ? localSoldiers.map((soldier, index) => ({
      slot: index,
      id: soldier.id,
      name: soldier.name,
      x: soldier.x,
      y: soldier.y,
      alive: soldier.alive
    })) : null
  };
}

/* ------------------------------------------------------------------- nav */
function go(where) {
  if (where === "play") {
    hideResults();
    startQueue();
    return;
  }
  if (where === "practice") {
    if (ranked && ["code", "countdown", "combat"].includes(phase)) {
      setStatus("⚠ match in progress — finish the lobby before leaving.", "err");
      return false;
    }
    hideResults();
    if (phase === "queue") cancelQueue(false);
    if (phase === "result") {
      try { NET.send({ type: "leaveMatch" }); } catch (error) { /* ignore */ }
      enteredRoom = null;
      ranked = null;
      M = null;
    }
    phase = "practice";
    view = "practice";
    startPractice(true);
    return;
  }
  if (where === "tutorial") {
    if (ranked && ["code", "countdown", "combat"].includes(phase)) {
      setStatus("⚠ match in progress — finish the lobby before leaving.", "err");
      return false;
    }
    hideResults();
    if (phase === "queue") cancelQueue(false);
    if (phase === "result") {
      try { NET.send({ type: "leaveMatch" }); } catch (error) { /* ignore */ }
      enteredRoom = null;
      ranked = null;
      M = null;
    }
    view = "tutorial";
    startTutorial(0);
    return;
  }
  if (["home", "help", "board"].includes(where)) {
    if (ranked && ["code", "countdown", "combat"].includes(phase) && where !== "board") {
      setStatus("⚠ match in progress — finish the lobby before leaving.", "err");
      return false;
    }
    if (ranked && ["code", "countdown", "combat"].includes(phase) && where === "board") {
      setStatus("⚠ match in progress — finish the lobby before leaving.", "err");
      return false;
    }
    hideResults();
    if (phase === "queue") cancelQueue(false);
    if (ranked && phase === "result") {
      try { NET.send({ type: "leaveMatch" }); } catch (error) { /* ignore */ }
      enteredRoom = null;
      ranked = null;
      M = null;
    }
    if (phase !== "practice" && phase !== "tutorial") phase = "idle";
    view = where;
    if (where === "board") renderLeaderboard();
    show(where);
    announcePhase();
    return;
  }
  return false;
}

document.querySelectorAll("[data-go]").forEach(button =>
  button.addEventListener("click", () => go(button.dataset.go)));
$("qcancel").addEventListener("click", () => cancelQueue(true));
$("b-again").addEventListener("click", () => {
  hideResults();
  startQueue();
});
$("b-results-board").addEventListener("click", () => {
  hideResults();
  try { NET.send({ type: "leaveMatch" }); } catch (error) { /* ignore */ }
  enteredRoom = null;
  ranked = null;
  M = null;
  phase = "idle";
  view = "board";
  renderLeaderboard();
  show("board");
  announcePhase();
});
$("b-results-home").addEventListener("click", () => {
  hideResults();
  try { NET.send({ type: "leaveMatch" }); } catch (error) { /* ignore */ }
  enteredRoom = null;
  ranked = null;
  M = null;
  phase = "idle";
  view = "home";
  show("home");
  announcePhase();
});

/* ------------------------------------------------------------------ loop */
function uiLoop() {
  const now = Date.now();
  if (phase === "queue") {
    if (now - lastQueueUi > 80) { lastQueueUi = now; updateQueueUI(now); }
  } else if (ranked && (phase === "code" || phase === "countdown" || phase === "combat")) {
    if (now - lastRankedUi > 100) { lastRankedUi = now; updateRankedUI(now); }
  }
}
setInterval(uiLoop, 100);
(function combatFrame() {
  if (phase === "combat" && ranked) drawRanked();
  requestAnimationFrame(combatFrame);
})();

/* ------------------------------------------------------------- connection */
onEvent("status", detail => {
  const node = document.getElementById("netstat");
  if (node) {
    node.textContent = detail.status === "online" ? "● live" : detail.status === "connecting" ? "● connecting" : "○ offline";
    node.dataset.status = detail.status;
  }
  if (phase === "queue" && queueState) {
    updateQueueUI(Date.now());
  }
});
onEvent("error", detail => {
  const message = "⚠ " + detail.message;
  if (phase === "queue") {
    queueError = detail.message;
    $("qtext").textContent = message;
    if (detail.code === "in_match") {
      const error = new Error(detail.message);
      for (const waiter of queueWaiters) {
        try { waiter.reject(error); } catch (ignored) { /* ignore */ }
      }
      queueWaiters = [];
    }
  } else if (view === "ranked" || view === "game") {
    setStatus(message, "err");
    if (ranked && ranked.phase === "code" && ["bad_expression", "empty", "too_long"].includes(detail.code)) {
      const soldier = ranked.match.soldiers[ranked.mySlot];
      soldier.ready = false;
      soldier.expression = "";
      inp.disabled = false;
      $("fire").disabled = false;
      $("fire").textContent = "lock in";
    }
  }
});
onEvent("clock", clock => {
  if (clock) for (const key of ["queueMs", "codeMs", "countdownMs"]) {
    if (Number.isFinite(clock[key])) CLOCK[key] = clock[key];
  }
  emitState();
});

/* ------------------------------------------------------------------ API */
const GraphShot = {
  version: VERSION,
  connect: () => NET.connect(),
  disconnect: () => NET.disconnect(),
  getState,
  getMap,
  getOptions,
  setOptions,
  setName: setNameRemote,
  getProfile: getProfileView,
  findMatch,
  cancelQueue() {
    cancelQueue(true);
    return getState();
  },
  submitShot,
  lockIn() {
    const ok = lockIn();
    if (!ok) throw new Error($("status").textContent || "could not lock in");
    return getState();
  },
  fire() {
    fireAction();
    return getState();
  },
  planShot,
  waitForPhase,
  waitFor,
  on: onEvent,
  navigate: go,
  getLeaderboard: getLeaderboardView,
  refresh() {
    try { NET.send({ type: "sync" }); } catch (error) { /* offline */ }
    return getState();
  },
  setClock(clock = {}) {
    try { NET.send({ type: "devClock", clock }); } catch (error) { /* offline */ }
    return (netState && netState.clock) || { ...CLOCK };
  },
  matchmake: skillMatchmake,
  getConnection() {
    return {
      url: NET.url,
      status: NET.status,
      connected: NET.connected,
      latencyMs: NET.rtt,
      serverNow: NET.serverTime()
    };
  },
  __applyServerState: applyServerState
};
window.GraphShot = GraphShot;
$("taskuser").textContent = currentProfile().name + "@graphshot";

/* Populate the profile/leaderboard as soon as the page opens. */
NET.connect().catch(() => {});
