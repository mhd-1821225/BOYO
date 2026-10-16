// BOYO client. Renders server views only — it never knows hidden card values
// except the ones the server privately reveals to this player.
const API = (window.BOYO_CONFIG && window.BOYO_CONFIG.apiBase) || "";
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const SUIT = { S: "♠", H: "♥", D: "♦", C: "♣" };
const AV_COLORS = ["#c8322f", "#2f5fc4", "#2f9a4f", "#b86b1f", "#7a3fb0", "#1f8c8c", "#b0306e", "#4c5a6b"];

const S = {
  session: null, // {code, token, seat}
  ws: null,
  view: null,
  prev: null,
  offset: 0,
  mode: null, // take | tap | peek_own | peek_other | blind_mine | blind_other
  blindMine: null,
  peeks: new Map(), // `${seat}:${slot}` -> {card, until, opening, bad, fresh}
  lastLogId: 0,
  autoStart: null,
  retry: 0,
  closedByUs: false,
  sound: localStorage.getItem("boyo.sound") !== "off",
  dealtRound: null,
  lastBanner: 0,
};

// ---------------------------------------------------------------- utilities
function show(id) {
  for (const sc of ["intro", "menu", "lobby", "table"]) $("#" + sc).classList.toggle("hidden", sc !== id);
  Platform.screen(id);
}
function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (error ? " error" : "");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add("hidden"), 2600);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function playerName() {
  const v = $("#nameInput").value.trim().slice(0, 16);
  return v || "Player";
}
function sessions() {
  try { return JSON.parse(localStorage.getItem("boyo.sessions") || "{}"); } catch { return {}; }
}
function saveSession(sess) {
  const all = sessions();
  all[sess.code] = { token: sess.token, seat: sess.seat, at: Date.now() };
  for (const [k, v] of Object.entries(all)) if (Date.now() - (v.at || 0) > 864e5) delete all[k];
  localStorage.setItem("boyo.sessions", JSON.stringify(all));
}
function forgetSession(code) {
  const all = sessions();
  delete all[code];
  localStorage.setItem("boyo.sessions", JSON.stringify(all));
}
function inviteLink(code) {
  const base = (window.BOYO_CONFIG && window.BOYO_CONFIG.shareBase) || location.origin;
  return `${base}/?room=${code}`;
}
function now() { return Date.now() - S.offset; }

// ---------------------------------------------------------------- sound
const Sound = (() => {
  let ctx;
  function tone(freq, dur, type = "sine", gain = 0.08, when = 0) {
    if (!S.sound) return;
    try {
      ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      const t = ctx.currentTime + when;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur);
    } catch { /* audio unavailable */ }
  }
  function flick() {
    if (!S.sound) return;
    try {
      ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      const len = 0.05, buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
      const src = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      f.type = "bandpass"; f.frequency.value = 2400; g.gain.value = 0.35;
      src.buffer = buf; src.connect(f).connect(g).connect(ctx.destination); src.start();
    } catch { /* ignore */ }
  }
  return {
    card: flick,
    good: () => { tone(660, 0.12, "triangle"); tone(990, 0.18, "triangle", 0.07, 0.09); },
    bad: () => { tone(180, 0.25, "square", 0.05); },
    boyo: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, "triangle", 0.07, i * 0.09)); },
    turn: () => tone(880, 0.1, "sine", 0.05),
    win: () => { [523, 659, 784, 659, 1047].forEach((f, i) => tone(f, 0.3, "triangle", 0.07, i * 0.12)); },
  };
})();
function syncSoundButtons() {
  $$("[data-sound]").forEach((b) => b.classList.toggle("off", !S.sound));
}

// ---------------------------------------------------------------- platform (CrazyGames / native)
const Platform = {
  sdk: null,
  async init() {
    const isCG = (window.BOYO_CONFIG && window.BOYO_CONFIG.platform === "crazygames") || /crazygames/.test(location.hostname) || new URLSearchParams(location.search).get("platform") === "crazygames";
    if (!isCG) return;
    try {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://sdk.crazygames.com/crazygames-sdk-v3.js";
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
      await window.CrazyGames.SDK.init();
      this.sdk = window.CrazyGames.SDK;
      this.sdk.game.loadingStop?.();
    } catch { this.sdk = null; }
  },
  playing: false,
  screen(id) {
    if (!this.sdk) return;
    const playing = id === "table";
    if (playing === this.playing) return;
    this.playing = playing;
    try { playing ? this.sdk.game.gameplayStart() : this.sdk.game.gameplayStop(); } catch { /* ignore */ }
  },
  invite(code) {
    if (this.sdk?.game?.inviteLink) {
      try { return this.sdk.game.inviteLink({ room: code }); } catch { /* fall through */ }
    }
    return inviteLink(code);
  },
  happy() { try { this.sdk?.game?.happytime?.(); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------- cards
function cardHTML(card, size = "", extra = "", attrs = "") {
  if (!card) return `<div class="card back ${size} ${extra}" ${attrs}></div>`;
  if (card.rank === "JOKER") {
    return `<div class="card face joker ${size} ${extra}" ${attrs}><span class="corner">★</span><span class="pip">★<small>JOKER</small></span><span class="corner br">★</span></div>`;
  }
  const red = card.suit === "H" || card.suit === "D";
  const s = SUIT[card.suit];
  const court = ["J", "Q", "K"].includes(card.rank);
  const center = court ? `<span class="pip court"><i>${card.rank === "K" ? "♚" : card.rank === "Q" ? "♛" : "♝"}</i><small>${s}</small></span>` : `<span class="pip">${s}</span>`;
  return `<div class="card face ${red ? "red" : "black"} ${size} ${extra}" ${attrs}><span class="corner">${card.rank}<br>${s}</span>${center}<span class="corner br">${card.rank}<br>${s}</span></div>`;
}
function avatar(p) {
  const init = p.isBot ? "🤖" : esc(p.name[0]?.toUpperCase() || "?");
  return `<span class="avatar" style="background:${AV_COLORS[p.seat % 8]}">${init}</span>`;
}

// ---------------------------------------------------------------- intro
function runIntro() {
  show("intro");
  const done = () => {
    if (runIntro.done) return;
    runIntro.done = true;
    $("#intro").classList.add("leaving");
    setTimeout(() => routeAfterIntro(), 420);
  };
  [0, 1, 2, 3].forEach((i) => setTimeout(() => Sound.card(), 250 + i * 160));
  [0, 1, 2, 3].forEach((i) => setTimeout(() => Sound.card(), 1100 + i * 180));
  setTimeout(() => Sound.boyo(), 2500);
  $("#intro").addEventListener("pointerdown", done, { once: true });
  setTimeout(done, 4300);
}
function routeAfterIntro() {
  let code = new URLSearchParams(location.search).get("room");
  try { code = code || Platform.sdk?.game?.getInviteParam?.("room") || null; } catch { /* ignore */ }
  show("menu");
  if (code) openRoomLink(code.toUpperCase());
}

// ---------------------------------------------------------------- API
async function api(path, body) {
  const res = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

async function createRoom({ rounds, decks, bots }) {
  const data = await api("/api/rooms", { name: playerName(), rounds, decks });
  S.session = { code: data.code, token: data.token, seat: data.seat };
  saveSession(S.session);
  S.autoStart = bots ? { bots } : null;
  connect();
}
async function joinRoom(code) {
  const data = await api(`/api/rooms/${code}/join`, { name: playerName() });
  S.session = { code, token: data.token, seat: data.seat };
  saveSession(S.session);
  connect();
}
function openRoomLink(code) {
  const saved = sessions()[code];
  if (saved) {
    S.session = { code, token: saved.token, seat: saved.seat };
    connect();
  } else {
    joinDialog(code);
  }
}

// ---------------------------------------------------------------- socket
function connect() {
  closeSocket();
  S.closedByUs = false;
  S.view = null; S.prev = null; S.peeks.clear(); S.lastLogId = 0; S.mode = null;
  const wsBase = API ? API.replace(/^http/, "ws") : location.origin.replace(/^http/, "ws");
  const ws = new WebSocket(`${wsBase}/api/rooms/${S.session.code}/ws`);
  S.ws = ws;
  ws.onopen = () => { S.retry = 0; ws.send(JSON.stringify({ type: "auth", token: S.session.token })); };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = (ev) => {
    if (S.ws !== ws || S.closedByUs) return;
    if (ev.code === 4003) {
      forgetSession(S.session.code);
      toast("That seat is no longer available.", true);
      leave(false);
      return;
    }
    const delay = Math.min(8000, 500 * 2 ** S.retry++);
    toast("Connection lost — reconnecting…", true);
    setTimeout(() => { if (S.ws === ws && !S.closedByUs) connect(); }, delay);
  };
  if (!Platform.sdk) history.replaceState(null, "", `?room=${S.session.code}`);
  clearInterval(connect.ping);
  connect.ping = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"ping"}'); }, 25000);
}
function closeSocket() {
  if (S.ws) { S.closedByUs = true; try { S.ws.close(); } catch { /* */ } S.ws = null; }
}
function send(a, extra = {}) {
  if (!S.ws || S.ws.readyState !== 1) return toast("Not connected yet…", true);
  S.ws.send(JSON.stringify({ type: "action", a, ...extra }));
}
function leave(confirmFirst = true) {
  if (confirmFirst && S.view && S.view.status !== "lobby" && S.view.status !== "finished") {
    return confirmDialog("Leave this game?", "You can rejoin from the same device with the invite link.", "Leave", () => leave(false));
  }
  closeSocket();
  clearInterval(connect.ping);
  S.session = null; S.view = null;
  history.replaceState(null, "", location.pathname);
  closeModal();
  show("menu");
}

function onMessage(msg) {
  if (msg.type === "state") {
    S.offset = Date.now() - msg.now;
    S.prev = S.view;
    S.view = msg.view;
    S.session.seat = msg.view.you;
    handleStateChange();
    render();
  } else if (msg.type === "peek") {
    const opening = S.view?.status === "peek";
    S.peeks.set(`${msg.seat}:${msg.slot}`, { card: msg.card, until: opening ? Infinity : Date.now() + 3500, opening, fresh: true });
    Sound.card();
    render();
    if (!opening) setTimeout(render, 3600);
  } else if (msg.type === "tap_result") {
    if (msg.ok) { Sound.good(); banner("TAP!"); }
    else {
      Sound.bad();
      toast(`Wrong TAP — that was ${rankLabel(msg.card)}. Penalty card added.`, true);
    }
  } else if (msg.type === "error") {
    Sound.bad();
    toast(msg.error, true);
  }
}

function rankLabel(card) {
  if (!card) return "?";
  if (card.rank === "JOKER") return "a Joker";
  return `${card.rank}${SUIT[card.suit]}`;
}

function handleStateChange() {
  const v = S.view, p = S.prev;
  // Auto-setup for solo games.
  if (S.autoStart && v.status === "lobby" && v.players[v.you]?.isHost) {
    const n = S.autoStart.bots; S.autoStart = null;
    for (let i = 0; i < n; i++) send("add_bot");
    setTimeout(() => send("start"), 150);
  }
  // Cards move: drop stale peeks for slots that changed.
  for (const e of v.log) {
    if (e.id <= S.lastLogId) continue;
    if (e.kind === "swap") S.peeks.delete(`${e.seat}:${e.slot}`);
    if (e.kind === "blind_swap") { S.peeks.delete(`${e.seat}:${e.slot}`); S.peeks.delete(`${e.target}:${e.targetSlot}`); }
    if (e.kind === "tap_ok") for (const k of [...S.peeks.keys()]) if (k.startsWith(`${e.seat}:`)) S.peeks.delete(k);
    if (S.lastLogId && e.kind === "boyo") { Sound.boyo(); banner("BOYO!", true); }
    if (S.lastLogId && e.kind === "tap_ok" && e.seat !== v.you) { Sound.good(); }
    if (S.lastLogId && e.kind === "tap_bad" && e.seat !== v.you) { Sound.bad(); }
    if (S.lastLogId && (e.kind === "swap" || e.kind === "draw" || e.kind === "discard_drawn")) Sound.card();
  }
  S.lastLogId = v.log.length ? v.log[v.log.length - 1].id : S.lastLogId;
  // Opening peeks are hidden again once play starts.
  if (v.status !== "peek") for (const [k, pk] of S.peeks) if (pk.opening) S.peeks.delete(k);
  if (v.status !== "playing") { S.mode = null; S.blindMine = null; }
  if (p && p.turn !== v.turn && v.turn === v.you && v.status === "playing") { Sound.turn(); }
  if (v.stage !== "drawn" && ["peek_own", "peek_other", "blind_mine", "blind_other"].includes(S.mode)) S.mode = null;
  if (S.mode === "take" && (v.turn !== v.you || v.stage !== "start")) S.mode = null;
  if (v.status === "finished" && p?.status !== "finished" && v.winners?.includes(v.you)) { Sound.win(); Platform.happy(); }
}

function banner(text, red = false) {
  const b = $("#banner");
  b.textContent = text;
  b.className = "banner" + (red ? " red" : "");
  void b.offsetWidth;
  clearTimeout(banner.t);
  banner.t = setTimeout(() => b.classList.add("hidden"), 1650);
}

// ---------------------------------------------------------------- rendering
function render() {
  const v = S.view;
  if (!v) return;
  if (v.status === "lobby") { show("lobby"); renderLobby(v); closeModalIf("reveal"); return; }
  show("table");
  renderTable(v);
  if (v.status === "reveal" || v.status === "finished") renderReveal(v);
  else closeModalIf("reveal");
}

function renderLobby(v) {
  const me = v.players[v.you];
  const host = me?.isHost;
  $("#roomCode").textContent = v.code;
  const seats = [];
  for (let i = 0; i < 8; i++) {
    const p = v.players[i];
    if (!p) { seats.push(`<li class="empty">Open seat</li>`); continue; }
    seats.push(`<li>${avatar(p)}<span>${esc(p.name)}</span>${p.isHost ? '<span class="tag">Host</span>' : ""}${p.seat === v.you ? '<span class="tag">You</span>' : ""}${host && p.isBot ? `<button class="x" data-remove="${p.seat}" aria-label="Remove bot">✕</button>` : ""}</li>`);
  }
  $("#seatList").innerHTML = seats.join("");
  $("#hostControls").classList.toggle("hidden", !host);
  $("#startGame").classList.toggle("hidden", !host);
  $("#lobbyWait").classList.toggle("hidden", !!host);
  $("#roundsVal").textContent = v.settings.rounds;
  $$("#deckSeg button").forEach((b) => b.classList.toggle("sel", Number(b.dataset.decks) === v.settings.decks));
  $("#addBot").disabled = v.players.length >= 8;
  $("#startGame").disabled = v.players.length < 2;
  $("#startGame").textContent = v.players.length < 2 ? "Add a bot or invite a friend" : `Start game (${v.players.length} players)`;
}

function oppPositions(n, portrait) {
  // Spread opponents on the upper arc of the table, west → north → east.
  const out = [];
  const start = n === 1 ? 90 : portrait ? 165 : 180;
  const end = n === 1 ? 90 : portrait ? 15 : 0;
  for (let i = 0; i < n; i++) {
    const a = n === 1 ? 90 : start + ((end - start) * i) / (n - 1);
    const r = (a * Math.PI) / 180;
    const rx = portrait ? 37 : 39, ry = portrait ? 25 : 28;
    out.push({ x: 50 + rx * Math.cos(r), y: (portrait ? 40 : 45) - ry * Math.sin(r) });
  }
  return out;
}

function timerHTML(v, seat) {
  if (v.status !== "playing" && v.status !== "peek") return "";
  if (v.status === "playing" && v.turn !== seat) return "";
  if (!v.deadline) return "";
  const total = v.status === "peek" ? 20000 : 45000;
  const left = Math.max(0, v.deadline - now());
  return `<span class="timer"><i style="transform:scaleX(${(left / total).toFixed(3)})"></i></span>`;
}

function plateHTML(v, p, isMe) {
  const turn = v.status === "playing" && v.turn === p.seat;
  const badges = [];
  if (v.boyoBy === p.seat) badges.push('<span class="badge">BOYO</span>');
  if (v.status === "peek" && p.ready) badges.push('<span class="badge final">Ready</span>');
  const dot = p.isBot ? "" : `<span class="dot ${p.connected ? "" : "off"}" title="${p.connected ? "Online" : "Offline"}"></span>`;
  return `<div class="plate ${turn ? "turn" : ""}">${avatar(p)}<span class="nm">${isMe ? "You" : esc(p.name)}</span>${dot}<span class="sc" title="Total score">${p.total}</span>${badges.join("")}${timerHTML(v, p.seat)}</div>`;
}

function peekFor(seat, slot) {
  const pk = S.peeks.get(`${seat}:${slot}`);
  if (!pk) return null;
  if (pk.until < Date.now()) { S.peeks.delete(`${seat}:${slot}`); return null; }
  return pk;
}

function renderTable(v) {
  const me = v.players[v.you];
  const myTurn = v.status === "playing" && v.turn === v.you;
  $("#roundPill").textContent = `Round ${v.round}/${v.settings.rounds}`;
  $("#codePill").textContent = v.code;
  const newDeal = v.status === "peek" && S.dealtRound !== v.round;
  if (newDeal) { S.dealtRound = v.round; [0, 1, 2, 3].forEach((i) => setTimeout(() => Sound.card(), i * 90)); }

  // Opponents
  const portrait = innerWidth / innerHeight < 0.8;
  const opps = [];
  for (let i = 1; i < v.players.length; i++) opps.push(v.players[(v.you + i) % v.players.length]);
  const pos = oppPositions(opps.length, portrait);
  const targetingOther = myTurn && (S.mode === "peek_other" || S.mode === "blind_other");
  const grid = portrait;
  $("#opponents").className = grid ? "grid" : "";
  $("#opponents").style.setProperty("--cols", opps.length <= 2 ? opps.length : opps.length <= 4 ? 2 : 3);
  $("#opponents").innerHTML = opps.map((p, i) => {
    const cards = [];
    for (let s = 0; s < p.handCount; s++) {
      const pk = peekFor(p.seat, s);
      const cls = `${targetingOther ? "selectable glow" : ""} ${pk?.fresh ? "flip-in" : ""} ${newDeal ? "dealt" : ""}`;
      const attrs = `data-opp="${p.seat}" data-slot="${s}" style="--d:${s + i}"`;
      cards.push(pk ? cardHTML(pk.card, "sm", cls, attrs) : cardHTML(null, "sm", cls, attrs));
    }
    const drawing = v.someoneDrew && v.turn === p.seat ? '<div class="card back sm drop" style="transform:rotate(8deg)"></div>' : "";
    return `<div class="opp" style="${grid ? "" : `left:${pos[i].x}%;top:${pos[i].y}%`}">${plateHTML(v, p, false)}<div class="mini-hand">${cards.join("")}${drawing}</div></div>`;
  }).join("");

  // Piles
  const canStart = myTurn && v.stage === "start";
  const deck = $("#deck");
  deck.classList.toggle("can", canStart);
  deck.classList.toggle("hidden", v.deckCount === 0);
  $("#deckLabel").textContent = `Deck · ${v.deckCount}`;
  const topChanged = !S.prev || JSON.stringify(S.prev.discardTop) !== JSON.stringify(v.discardTop) || S.prev.discardCount !== v.discardCount;
  $("#discard").innerHTML = v.discardTop ? cardHTML(v.discardTop, "md", topChanged ? "drop" : "") : '<div class="card md empty"></div>';
  $("#discard").classList.toggle("can", canStart);
  const drawn = v.drawn;
  $("#drawnBox").classList.toggle("hidden", !drawn);
  if (drawn) $("#drawnCard").innerHTML = cardHTML(drawn.card, "md", S.prev?.drawn ? "" : "flip-in");

  // My hand
  $("#myPlate").innerHTML = plateHTML(v, me, true);
  const selectMine = v.status === "peek" ? v.peeksLeft > 0 && !me.ready
    : S.mode === "tap" ? v.status === "playing"
    : myTurn && (S.mode === "take" || S.mode === "peek_own" || S.mode === "blind_mine" || (v.stage === "drawn" && !S.mode));
  const hand = [];
  for (let s = 0; s < me.handCount; s++) {
    const pk = peekFor(v.you, s);
    if (pk) pk.fresh = pk.fresh && true;
    const cls = `${selectMine ? "selectable" : ""} ${S.mode === "tap" || (selectMine && v.status === "playing" && S.mode !== "blind_other") ? "glow" : ""} ${S.blindMine === s && S.mode === "blind_other" ? "glow" : ""} ${pk?.fresh ? "flip-in" : ""} ${newDeal ? "dealt" : ""}`;
    const attrs = `data-mine="${s}" tabindex="${selectMine ? 0 : -1}" style="--d:${s}"`;
    hand.push(pk ? cardHTML(pk.card, "", cls, attrs) : cardHTML(null, "", cls, attrs));
  }
  $("#myHand").innerHTML = hand.join("") || '<p class="hint">No cards left — nice!</p>';
  for (const pk of S.peeks.values()) pk.fresh = false;

  // Powers
  const pw = $("#powers");
  if (myTurn && drawn && drawn.powers.length) {
    const label = { peek_own: "👁 Peek at your card", peek_other: "👁 Peek at a rival's card", blind_swap: "⇄ Blind swap" };
    pw.innerHTML = drawn.powers.map((p) => `<button class="btn cream ${S.mode === p || (p === "blind_swap" && S.mode?.startsWith("blind")) ? "on" : ""}" data-power="${p}">${label[p]}</button>`).join("")
      + `<button class="btn link" data-power="skip">Skip powers</button>`;
    pw.classList.remove("hidden");
  } else pw.classList.add("hidden");

  // Buttons
  const canCallBoyo = myTurn && v.boyoBy === null && (v.stage === "start" || v.stage === "post_swap");
  $("#actDraw").disabled = !canStart || v.deckCount === 0 && v.discardCount <= 1;
  $("#actBoyo").disabled = !canCallBoyo;
  $("#actTap").disabled = v.status !== "playing" || me.handCount === 0 || !v.discardTop;
  $("#actTap").classList.toggle("on", S.mode === "tap");
  $("#actDraw").classList.toggle("hidden", v.status === "peek" || !canStart);
  $("#actReturnDrawn").classList.toggle("hidden", !(myTurn && v.stage === "drawn" && drawn));
  $("#actBoyo").classList.toggle("hidden", v.status === "peek" || !canCallBoyo);
  $("#actEndTurn").classList.toggle("hidden", !(myTurn && v.stage === "post_swap"));
  $("#actTap").textContent = S.mode === "tap" ? "CANCEL" : "TAP";
  if (v.status === "peek") {
    $("#actTap").classList.add("hidden");
    if (!$("#readyBtn")) $(".actions").insertAdjacentHTML("beforeend", '<button class="btn primary act" id="readyBtn">READY</button>');
    $("#readyBtn").disabled = me.ready;
    $("#readyBtn").textContent = me.ready ? "WAITING…" : "READY";
  } else {
    $("#actTap").classList.remove("hidden");
    $("#readyBtn")?.remove();
  }

  $("#hint").textContent = hintText(v, me, myTurn);
  $("#feed").innerHTML = v.log.slice(-4).map((e) => `<div>${esc(e.text)}</div>`).join("");
}

function hintText(v, me, myTurn) {
  const cur = v.turn !== null ? v.players[v.turn] : null;
  if (v.status === "peek") {
    if (me.ready) return "Waiting for the others to finish peeking…";
    return v.peeksLeft > 0 ? `Tap ${v.peeksLeft} of your cards to peek — memorise them!` : "Remember them! Press READY to hide your cards.";
  }
  if (v.status !== "playing") return "";
  if (S.mode === "tap") return "TAP: pick your card that matches the top discard.";
  const finalNote = v.boyoBy !== null ? (v.boyoBy === v.you ? " (you called BOYO)" : " — final turn!") : "";
  if (!myTurn) {
    return `${cur ? esc(cur.name) : "?"}'s turn${v.boyoBy !== null ? ` · ${v.finalTurnsLeft} final turn${v.finalTurnsLeft === 1 ? "" : "s"} left` : ""}. You can TAP any time.`;
  }
  if (v.stage === "start") {
    if (S.mode === "take") return "Pick the card to swap with the discard.";
    return `Your turn${finalNote}: draw from the deck, take the discard${v.boyoBy === null ? ", or call BOYO" : ""}.`;
  }
  if (v.stage === "post_swap") return v.boyoBy === null ? "Your swap is complete. Call BOYO now, or end your turn." : "Your swap is complete. End your turn to pass to the next player.";
  if (S.mode === "peek_own") return "Pick one of your cards to look at.";
  if (S.mode === "peek_other") return "Pick a rival's card to look at.";
  if (S.mode === "blind_mine") return "Blind swap: pick one of YOUR cards first.";
  if (S.mode === "blind_other") return "Now pick a rival's card to swap with.";
  if (v.drawn?.powers.length) return "Use a power, replace a card, or discard this card on top of the pile to end your turn.";
  return "Replace one of your cards, or discard this card on top of the pile to end your turn.";
}

function renderReveal(v) {
  const lr = v.lastRound;
  if (!lr) return;
  const finished = v.status === "finished";
  const host = v.players[v.you]?.isHost;
  const sorted = v.players.slice().sort((a, b) => a.total - b.total);
  const rows = sorted.map((p) => {
    const r = lr.results.find((x) => x.seat === p.seat);
    const cards = (p.revealed || []).map((c) => cardHTML(c, "")).join("") || "<em>no cards</em>";
    const win = finished ? v.winners?.includes(p.seat) : false;
    return `<div class="reveal-row ${win ? "win" : ""}"><div class="who">${avatar(p)}<span>${p.seat === v.you ? "You" : esc(p.name)}</span>${lr.boyoBy === p.seat ? '<span class="tag">BOYO</span>' : ""}</div><div class="cards">${cards}</div><div class="pts"><b>${r.score > 0 ? "+" : ""}${r.score}</b><small>${p.total}</small></div></div>`;
  }).join("");
  const title = finished
    ? (v.winners.includes(v.you) ? "You win! 🏆" : `${v.winners.map((s) => esc(v.players[s].name)).join(" & ")} wins!`)
    : `Round ${lr.round} results`;
  const left = v.deadline ? Math.max(0, Math.ceil((v.deadline - now()) / 1000)) : 0;
  const footer = finished
    ? `<div class="row2">${host ? '<button class="btn primary big" id="rematch">Rematch</button>' : '<p class="auto">Waiting for host…</p>'}<button class="btn cream big" id="toMenu">Main menu</button></div>`
    : (host ? `<button class="btn primary big" id="nextRound">Next round</button>` : "") + `<p class="auto">Next round starts automatically in ${left}s</p>`;
  openModal(`<div class="reveal"><h2>${title}</h2><div class="reveal-list">${rows}</div>${footer}</div>`, "reveal");
}

// ---------------------------------------------------------------- modals
function openModal(html, kind = "") {
  const m = $("#modal");
  $("#modalCard").innerHTML = html;
  m.dataset.kind = kind;
  m.classList.remove("hidden");
}
function closeModal() { $("#modal").classList.add("hidden"); $("#modal").dataset.kind = ""; }
function closeModalIf(kind) { if ($("#modal").dataset.kind === kind) closeModal(); }
function rulesModal() {
  openModal($("#rulesTpl").innerHTML, "rules");
}
function confirmDialog(title, body, okLabel, onOk) {
  openModal(`<div class="form"><h2>${title}</h2><p class="lead">${body}</p><div class="row2"><button class="btn cream big" data-close>Cancel</button><button class="btn red big" id="confirmOk">${okLabel}</button></div></div>`, "confirm");
  $("#confirmOk").onclick = () => { closeModal(); onOk(); };
}
function setupDialog(solo) {
  const st = { bots: 3, rounds: 5, decks: 1 };
  const draw = () => {
    openModal(`<div class="form">
      <h2>${solo ? "Play vs Bots" : "Create Online Room"}</h2>
      ${solo ? `<div class="setting"><span>Bots</span><div class="stepper"><button data-s="bots" data-d="-1">−</button><b>${st.bots}</b><button data-s="bots" data-d="1">+</button></div></div>` : ""}
      <div class="setting"><span>Rounds</span><div class="stepper"><button data-s="rounds" data-d="-1">−</button><b>${st.rounds}</b><button data-s="rounds" data-d="1">+</button></div></div>
      <div class="setting"><span>Decks</span><div class="seg"><button data-dk="1" class="${st.decks === 1 ? "sel" : ""}">1 deck</button><button data-dk="2" class="${st.decks === 2 ? "sel" : ""}">2 decks</button></div></div>
      <p class="err" id="setupErr"></p>
      <div class="row2"><button class="btn cream big" data-close>Back</button><button class="btn primary big" id="setupGo">${solo ? "Deal me in" : "Create room"}</button></div>
    </div>`, "setup");
    $$("#modalCard [data-s]").forEach((b) => b.onclick = () => {
      const k = b.dataset.s, lim = k === "bots" ? [1, 7] : [1, 20];
      st[k] = Math.max(lim[0], Math.min(lim[1], st[k] + Number(b.dataset.d)));
      draw();
    });
    $$("#modalCard [data-dk]").forEach((b) => b.onclick = () => { st.decks = Number(b.dataset.dk); draw(); });
    $("#setupGo").onclick = async () => {
      $("#setupGo").disabled = true;
      try { await createRoom({ rounds: st.rounds, decks: st.decks, bots: solo ? st.bots : 0 }); closeModal(); }
      catch (e) { $("#setupErr").textContent = e.message; $("#setupGo").disabled = false; }
    };
  };
  draw();
}
function joinDialog(prefill = "") {
  openModal(`<div class="form">
    <h2>Join a room</h2>
    <label class="field"><span>Room code</span><input id="joinCode" maxlength="6" value="${esc(prefill)}" placeholder="ABC123" autocapitalize="characters" /></label>
    <p class="lead">Joining as <b>${esc(playerName())}</b>. Change your name on the main menu.</p>
    <p class="err" id="joinErr"></p>
    <div class="row2"><button class="btn cream big" data-close>Back</button><button class="btn blue big" id="joinGo">Join</button></div>
  </div>`, "join");
  const go = async () => {
    const code = $("#joinCode").value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) { $("#joinErr").textContent = "Codes are 6 letters/numbers."; return; }
    $("#joinGo").disabled = true;
    try { await joinRoom(code); closeModal(); }
    catch (e) { $("#joinErr").textContent = e.message; $("#joinGo").disabled = false; }
  };
  $("#joinGo").onclick = go;
  $("#joinCode").onkeydown = (e) => { if (e.key === "Enter") go(); };
  setTimeout(() => $("#joinCode").focus(), 50);
}

// ---------------------------------------------------------------- input
function onMine(slot) {
  const v = S.view;
  if (!v) return;
  if (v.status === "peek") return send("peek", { slot });
  if (v.status !== "playing") return;
  if (S.mode === "tap") { S.mode = null; send("tap", { slot }); render(); return; }
  if (v.turn !== v.you) return;
  if (S.mode === "take") { S.mode = null; return send("take_discard", { slot }); }
  if (S.mode === "peek_own") { S.mode = null; return send("peek_own", { slot }); }
  if (S.mode === "blind_mine") { S.blindMine = slot; S.mode = "blind_other"; return render(); }
  if (v.stage === "drawn" && !S.mode) return send("swap_drawn", { slot });
}
function onOpp(seat, slot) {
  const v = S.view;
  if (!v || v.turn !== v.you) return;
  if (S.mode === "peek_other") { S.mode = null; return send("peek_other", { target: seat, slot }); }
  if (S.mode === "blind_other") {
    const mine = S.blindMine;
    S.mode = null; S.blindMine = null;
    return send("blind_swap", { slot: mine, target: seat, targetSlot: slot });
  }
}

function bind() {
  $("#skipIntro").onclick = () => {};
  const name = localStorage.getItem("boyo.name");
  if (name) $("#nameInput").value = name;
  $("#nameInput").oninput = () => localStorage.setItem("boyo.name", $("#nameInput").value.trim());
  $("#btnSolo").onclick = () => setupDialog(true);
  $("#btnCreate").onclick = () => setupDialog(false);
  $("#btnJoin").onclick = () => joinDialog();
  $("#btnRules").onclick = rulesModal;
  $("#tableRules").onclick = rulesModal;
  $("#tableLeave").onclick = () => leave(true);
  $("#lobbyLeave").onclick = () => leave(false);
  $$("[data-sound]").forEach((b) => b.onclick = () => {
    S.sound = !S.sound;
    localStorage.setItem("boyo.sound", S.sound ? "on" : "off");
    syncSoundButtons();
    if (S.sound) Sound.good();
  });
  syncSoundButtons();

  $("#copyInvite").onclick = async () => {
    const link = await Platform.invite(S.view.code);
    try { await navigator.clipboard.writeText(link); toast("Invite link copied!"); }
    catch { toast(link); }
  };
  $("#shareInvite").onclick = async () => {
    const link = await Platform.invite(S.view.code);
    if (navigator.share) { try { await navigator.share({ title: "Play BOYO with me", text: `Join my BOYO room ${S.view.code}`, url: link }); } catch { /* cancelled */ } }
    else { try { await navigator.clipboard.writeText(link); toast("Invite link copied!"); } catch { toast(link); } }
  };
  $("#addBot").onclick = () => send("add_bot");
  $("#startGame").onclick = () => send("start");
  $("#seatList").onclick = (e) => { const b = e.target.closest("[data-remove]"); if (b) send("remove_bot", { seat: Number(b.dataset.remove) }); };
  $("#hostControls").onclick = (e) => {
    const st = e.target.closest("[data-step]");
    if (st) send("settings", { rounds: Math.max(1, Math.min(20, S.view.settings.rounds + Number(st.dataset.d))) });
    const dk = e.target.closest("[data-decks]");
    if (dk) send("settings", { decks: Number(dk.dataset.decks) });
  };

  $("#deck").onclick = () => { const v = S.view; if (v?.turn === v?.you && v.stage === "start") { S.mode = null; send("draw"); } };
  $("#actDraw").onclick = () => { S.mode = null; send("draw"); };
  $("#discard").onclick = () => {
    const v = S.view;
    if (v?.status === "playing" && v.turn === v.you && v.stage === "start") { S.mode = S.mode === "take" ? null : "take"; render(); }
  };
  $("#actTap").onclick = () => { S.mode = S.mode === "tap" ? null : "tap"; render(); };
  $("#actReturnDrawn").onclick = () => {
    const v = S.view;
    if (v?.status === "playing" && v.turn === v.you && v.stage === "drawn") {
      S.mode = null;
      send("discard_drawn");
    }
  };
  $("#actBoyo").onclick = () => confirmDialog("Call BOYO?", "Everyone else gets exactly one final turn, then all cards are revealed and scored.", "BOYO!", () => send("boyo"));
  $("#actEndTurn").onclick = () => { if (S.view?.status === "playing" && S.view.turn === S.view.you && S.view.stage === "post_swap") send("finish_turn"); };
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) closeModal();
    if (e.target.id === "readyBtn") send("ready");
    if (e.target.id === "nextRound") send("next_round");
    if (e.target.id === "rematch") send("rematch");
    if (e.target.id === "toMenu") leave(false);
    const pw = e.target.closest("[data-power]");
    if (pw) {
      const p = pw.dataset.power;
      if (p === "skip") { S.mode = null; send("skip_powers"); return; }
      const m = p === "blind_swap" ? "blind_mine" : p;
      S.mode = S.mode === m || (p === "blind_swap" && S.mode === "blind_other") ? null : m;
      S.blindMine = null;
      render();
    }
  });
  $("#myHand").onclick = (e) => { const c = e.target.closest("[data-mine]"); if (c) onMine(Number(c.dataset.mine)); };
  $("#myHand").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { const c = e.target.closest("[data-mine]"); if (c) { e.preventDefault(); onMine(Number(c.dataset.mine)); } } };
  $("#opponents").onclick = (e) => { const c = e.target.closest("[data-opp]"); if (c) onOpp(Number(c.dataset.opp), Number(c.dataset.slot)); };
  $("#modal").onclick = (e) => { if (e.target.id === "modal" && $("#modal").dataset.kind !== "reveal") closeModal(); };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (!$("#modal").classList.contains("hidden") && $("#modal").dataset.kind !== "reveal") closeModal(); else { S.mode = null; S.blindMine = null; render(); } }
    if (e.key.toLowerCase() === "t" && S.view?.status === "playing" && document.activeElement?.tagName !== "INPUT") { S.mode = S.mode === "tap" ? null : "tap"; render(); }
  });
  addEventListener("resize", () => render());
  // Timers / countdown refresh.
  setInterval(() => {
    const v = S.view;
    if (!v || $("#table").classList.contains("hidden")) return;
    $$(".plate .timer i").forEach(() => {});
    if (v.status === "playing" || v.status === "peek") {
      const t = document.querySelectorAll(".plate .timer i");
      const total = v.status === "peek" ? 20000 : 45000;
      const left = Math.max(0, v.deadline - now());
      t.forEach((el) => el.style.transform = `scaleX(${(left / total).toFixed(3)})`);
    }
    if (v.status === "reveal") {
      const el = document.querySelector(".reveal .auto");
      if (el) el.textContent = `Next round starts automatically in ${Math.max(0, Math.ceil((v.deadline - now()) / 1000))}s`;
    }
  }, 250);
}

bind();
Platform.init();
runIntro();
