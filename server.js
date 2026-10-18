"use strict";
const express = require("express"), http = require("http"), path = require("path"), crypto = require("crypto");
const { Server } = require("socket.io");
const World = require("./world");
const authoredChoices = require("./data/choices");

const PORT = process.env.PORT || 3000;
const app = express(), server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000, maxHttpBufferSize: 1e5 });
app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1d", etag: true,
  setHeaders: (res, file) => {
    // Revalidate HTML so deployments are picked up, but cache static JS/CSS/assets.
    if (/\.html$/.test(file)) res.setHeader("Cache-Control", "no-cache");
    else if (/\.(js|css|png|webp|ico|svg|woff2?)$/.test(file)) res.setHeader("Cache-Control", "public, max-age=86400");
  },
}));
app.get("/health", (_, res) => res.json({ ok: true, rooms: rooms.size }));

/* ------------------------------------------------------------------ config */
const DURATION = 420, MAX_PLAYERS = 30, BOOST_MS = 3000, SHIELD_MS = 10000, SLOW_MS = 5000;
const ZOMBIE_FREEZE_MS = 5000, PICKUP_EVERY_MS = 30000, ATTACK_COOLDOWN_MS = 3000;
// Shared with the client (sent on join) so prediction and validation use the same numbers.
const CFG = {
  tickHz: 15, playerSpeed: 200, boostMult: 1.55, slowMult: 0.48, waterMult: 0.65,
  zombieSpeed: 150, zombieFinalSpeed: 200, zombieBoostSpeed: 225, finalSeconds: 120,
  range: { file: 110, crate: 150, pc: 120, guide: 120, pickup: 90, zip: 140, relay: 110, victim: 150 },
  autoPickup: 46, map: World.MAP,
};
const TOL = 15; // network-latency tolerance added to server-side range checks

/* ------------------------------------------------------------------ language data */
const pronouns = ["je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles"];
const aux = {
  avoir: { je: "ai", tu: "as", il: "a", elle: "a", on: "a", nous: "avons", vous: "avez", ils: "ont", elles: "ont" },
  être: { je: "suis", tu: "es", il: "est", elle: "est", on: "est", nous: "sommes", vous: "êtes", ils: "sont", elles: "sont" },
};
// [infinitive, past participle, auxiliary, English infinitive, English simple past, English past after plural subjects]
const verbs = [
  ["avoir", "eu", "avoir", "to have", "had"], ["être", "été", "avoir", "to be", "was", "were"],
  ["faire", "fait", "avoir", "to do/make", "did/made"], ["prendre", "pris", "avoir", "to take", "took"],
  ["comprendre", "compris", "avoir", "to understand", "understood"], ["apprendre", "appris", "avoir", "to learn", "learned"],
  ["mettre", "mis", "avoir", "to put", "put"], ["permettre", "permis", "avoir", "to allow", "allowed"],
  ["dire", "dit", "avoir", "to say", "said"], ["écrire", "écrit", "avoir", "to write", "wrote"],
  ["lire", "lu", "avoir", "to read", "read"], ["voir", "vu", "avoir", "to see", "saw"],
  ["boire", "bu", "avoir", "to drink", "drank"], ["croire", "cru", "avoir", "to believe", "believed"],
  ["pouvoir", "pu", "avoir", "to be able to", "could"], ["vouloir", "voulu", "avoir", "to want", "wanted"],
  ["devoir", "dû", "avoir", "to have to", "had to"], ["savoir", "su", "avoir", "to know (a fact)", "knew"],
  ["recevoir", "reçu", "avoir", "to receive", "received"], ["ouvrir", "ouvert", "avoir", "to open", "opened"],
  ["offrir", "offert", "avoir", "to offer", "offered"], ["vivre", "vécu", "avoir", "to live", "lived"],
  ["suivre", "suivi", "avoir", "to follow", "followed"], ["conduire", "conduit", "avoir", "to drive", "drove"],
  ["connaître", "connu", "avoir", "to know (a person/place)", "knew"], ["naître", "né", "être", "to be born", "was born", "were born"],
  ["mourir", "mort", "être", "to die", "died"], ["aller", "allé", "être", "to go", "went"],
  ["venir", "venu", "être", "to come", "came"], ["revenir", "revenu", "être", "to come back", "came back"],
  ["devenir", "devenu", "être", "to become", "became"], ["partir", "parti", "être", "to leave", "left"],
  ["sortir", "sorti", "être", "to go out", "went out"], ["arriver", "arrivé", "être", "to arrive", "arrived"],
  ["entrer", "entré", "être", "to enter", "entered"], ["rentrer", "rentré", "être", "to return home", "returned home"],
  ["tomber", "tombé", "être", "to fall", "fell"], ["rester", "resté", "être", "to stay", "stayed"],
  ["monter", "monté", "être", "to go up", "went up"], ["descendre", "descendu", "être", "to go down", "went down"],
  ["tenir", "tenu", "avoir", "to hold", "held"], ["dormir", "dormi", "avoir", "to sleep", "slept"],
  ["courir", "couru", "avoir", "to run", "ran"], ["coudre", "cousu", "avoir", "to sew", "sewed"],
  ["couvrir", "couvert", "avoir", "to cover", "covered"], ["cuire", "cuit", "avoir", "to cook", "cooked"],
  ["découvrir", "découvert", "avoir", "to discover", "discovered"], ["décrire", "décrit", "avoir", "to describe", "described"],
  ["disparaître", "disparu", "avoir", "to disappear", "disappeared"], ["interdire", "interdit", "avoir", "to forbid", "forbade"],
  ["produire", "produit", "avoir", "to produce", "produced"], ["promettre", "promis", "avoir", "to promise", "promised"],
  ["retourner", "retourné", "être", "to return", "returned"], ["rire", "ri", "avoir", "to laugh", "laughed"],
  ["sourire", "souri", "avoir", "to smile", "smiled"],
].map(([inf, pp, auxType, en, past, pastPl]) => ({ inf, pp, auxType, en, past, pastPl: pastPl || past }));
const EN_PRONOUN = { je: "I", tu: "you (sing.)", il: "he", elle: "she", on: "we (on)", nous: "we", vous: "you (pl.)", ils: "they (m.)", elles: "they (f.)" };
const EN_PLURAL = new Set(["tu", "nous", "vous", "ils", "elles", "on"]);

const norm = s => String(s ?? "").normalize("NFC").trim().toLowerCase();
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const pick = a => a[Math.floor(Math.random() * a.length)];
const rand = (a, b) => Math.random() * (b - a) + a;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const near = (a, b, r) => dist(a, b) < r;
const newId = () => crypto.randomBytes(3).toString("hex");
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const isFemale = p => p === "elle" || p === "elles";
const isPlural = p => ["nous", "vous", "ils", "elles"].includes(p);
const ppFor = (v, p) => v.auxType !== "être" ? v.pp : v.pp + (isFemale(p) ? "e" : "") + (isPlural(p) ? "s" : "");
function sentenceFr(o) {
  const elide = o.pronoun === "je" && "aeiouyhàâäéèêëïîôùûü".includes(o.aux[0].toLowerCase());
  return (elide ? "j'" : o.pronoun + " ") + o.aux + " " + o.pp;
}
const sentenceEn = (pronoun, v) => `${EN_PRONOUN[pronoun]} ${EN_PLURAL.has(pronoun) ? v.pastPl : v.past}`;

/* Four answer options. Authored sets are used when available (de-duplicated, correct answer guaranteed,
   everything capitalised so the right answer is not visually different); otherwise plausible
   distractors are generated from the verb itself. */
function choicesFor(correct, v) {
  const want = norm(correct), seen = new Set([want]), out = [cap(correct)];
  const add = s => { const k = norm(s); if (s && k && !seen.has(k)) { seen.add(k); out.push(cap(String(s))); } };
  const authored = authoredChoices[v.inf] || [];
  shuffle([...authored]).forEach(s => { if (out.length < 4) add(s); });
  if (out.length < 4) {
    const stem = v.inf.replace(/(er|ir|re|oir)$/, "");
    const gen = [v.inf, stem + "é", stem + "i", stem + "u", stem + "it", stem + "is", v.pp + "s", v.pp + "e", v.pp + "t"];
    shuffle(gen).forEach(s => { if (out.length < 4) add(s); });
  }
  while (out.length < 4) add(pick(verbs).pp);
  return shuffle(out);
}

/* ------------------------------------------------------------------ rooms */
const rooms = new Map();
const ms = (t, now) => Math.max(0, Math.round(t - now));
const secondsLeft = (r, now = Date.now()) => r.phase === "playing" ? Math.max(0, Math.ceil((r.endsAt - now) / 1000)) : r.seconds;
const notify = (p, type, message, sfx) => io.to(p.id).emit("notice", { type, message, sfx });
const err = (s, message) => s.emit("notice", { type: "error", message });

function makeRoom() {
  let code; do { code = newId().toUpperCase(); } while (rooms.has(code));
  const r = { code, phase: "lobby", seconds: DURATION, durationSeconds: DURATION, endsAt: 0, host: null, players: new Map(), nextN: 1, world: null,
    pickups: [], lastPickupAt: 0, relayCooldowns: {}, dirty: false, lastRoster: 0, zombieFreezeUntil: 0 };
  rooms.set(code, r);
  return r;
}

function pubPlayer(p, now) {
  const o = p.obj;
  return { n: p.n, id: p.id, name: p.name, avatar: p.avatar || { color: "#20b9a2", style: "classic" }, score: p.score, lives: p.lives, zombie: p.zombie, x: Math.round(p.x), y: Math.round(p.y),
    b: ms(p.boostUntil, now), s: ms(p.shieldUntil, now), sl: ms(p.slowUntil, now), zb: ms(p.zombieBoostUntil, now),
    crate: o ? { id: o.crate.id, x: o.crate.x, y: o.crate.y, verb: o.verb.inf, done: o.password } : null };
}
function sendRoster(r) {
  const now = Date.now(); r.dirty = false; r.lastRoster = now;
  io.to(r.code).emit("room", { code: r.code, phase: r.phase, host: r.host, seconds: secondsLeft(r, now), zf: ms(r.zombieFreezeUntil, now),
    players: [...r.players.values()].map(p => pubPlayer(p, now)), pickups: r.pickups });
}
const touch = r => { r.dirty = true; };

// Private objective: never contains the answers.
function sendMe(p) {
  const o = p.obj; if (!o) return;
  io.to(p.id).emit("me", { verb: o.verb.inf, en: o.verb.en, sentenceEn: sentenceEn(o.pronoun, o.verb), file: o.file, password: o.password,
    fileLabel: o.file ? `${o.pronoun} ${o.aux}` : null, crate: { id: o.crate.id }, computer: o.computer });
}

function newObjective(r, p) {
  const prev = p.obj?.verb.inf;
  const v = pick(verbs.filter(x => x.inf !== prev)), pronoun = pick(pronouns);
  const taken = []; r.players.forEach(q => { if (q.obj && q !== p) taken.push(q.obj.crate, q.obj.computer); });
  const crate = { id: "cr" + newId(), ...World.openPoint(r.world, taken, 220) };
  const far = [...taken, { ...crate }];
  let computer = World.openPoint(r.world, far, 220);
  for (let i = 0; i < 40 && dist(computer, crate) < 700; i++) computer = World.openPoint(r.world, far, 220);
  computer = { id: "pc" + newId(), x: computer.x, y: computer.y };
  p.obj = { verb: v, pronoun, aux: aux[v.auxType][pronoun], pp: ppFor(v, pronoun), crate, computer, file: false, password: false };
  p.pendingAttack = null;
}

function spawnPickups(r) {
  const taken = [];
  const make = type => { const pt = World.openPoint(r.world, taken, 300); taken.push(pt); return { id: type + "-" + newId(), type, x: pt.x, y: pt.y }; };
  r.pickups = [make("boost"), make("boost"), make("boost"), make("bandage")];
  r.lastPickupAt = Date.now();
}

function speedOf(r, p, now) {
  let s;
  if (p.zombie) s = now < p.zombieBoostUntil ? CFG.zombieBoostSpeed : (secondsLeft(r, now) <= CFG.finalSeconds ? CFG.zombieFinalSpeed : CFG.zombieSpeed);
  else { s = CFG.playerSpeed * (now < p.boostUntil ? CFG.boostMult : 1); if (now < p.slowUntil) s *= CFG.slowMult; }
  if (World.inWater(r.world, p.x, p.y)) s *= CFG.waterMult;
  return s;
}

function endGame(r, reason) {
  if (r.phase !== "playing") return;
  r.phase = "ended"; r.seconds = 0;
  const scores = [...r.players.values()].map(p => ({ name: p.name, score: p.score, zombie: p.zombie })).sort((a, b) => b.score - a.score);
  const top = scores[0]?.score || 0;
  io.to(r.code).emit("gameOver", { scores, winners: top > 0 ? scores.filter(s => s.score === top).map(s => s.name) : [], reason });
  sendRoster(r);
}
function checkEndConditions(r) {
  if (r.phase !== "playing") return false;
  const list = [...r.players.values()];
  if (list.length < 2) { endGame(r, "notEnough"); return true; }
  if (list.every(p => p.zombie)) { endGame(r, "allZombies"); return true; }
  return false;
}

function abortQuizzesFor(p, message) { io.to(p.id).emit("quizAbort", { message }); }

function hitPlayer(r, a, t) {
  const now = Date.now();
  if (now < t.shieldUntil || t.zombie) return;
  t.lives = Math.max(0, t.lives - 1); t.shieldUntil = now + SHIELD_MS;
  t.ignoreMoveUntil = Math.max(t.ignoreMoveUntil || 0, now + 500);
  a.score += 0.5;
  io.to(t.id).emit("hitEffect", { duration: SHIELD_MS / 1000, lives: t.lives });
  notify(t, "warning", `Zombie hit! ${t.lives} ${t.lives === 1 ? "life" : "lives"} left. Shield for 10 seconds.`);
  let msg = `Correct answer! You took a life from ${t.name}.`;
  if (t.lives === 0) {
    t.zombie = true; t.boostUntil = 0; t.slowUntil = 0; t.zombieBoostUntil = 0; t.nextZombieBoostAt = now + 20000; t.pendingAttack = null;
    a.score += 1; msg = `${t.name} converted! +1 point.`;
    notify(t, "warning", "You lost all 3 lives — you are now a zombie!", "stinger");
    abortQuizzesFor(t, "You became a zombie!");
  }
  io.to(a.id).emit("quizResult", { correct: true, explanation: msg, sfx: t.zombie ? "convert" : null });
  touch(r);
  checkEndConditions(r);
}

/* ------------------------------------------------------------------ game loop (single timer for all rooms) */
function tickRoom(r, now) {
  for (const p of r.players.values()) {
    if (p.zombie && p.nextZombieBoostAt && now >= p.nextZombieBoostAt) {
      p.zombieBoostUntil = now + 3000; p.nextZombieBoostAt = now + 20000; touch(r);
      notify(p, "success", "Zombie surge! Speed boost active for 3 seconds.");
    }
  }
  if (now - r.lastPickupAt >= PICKUP_EVERY_MS) { spawnPickups(r); touch(r); }
  const flat = []; for (const p of r.players.values()) flat.push(p.n, Math.round(p.x), Math.round(p.y));
  io.to(r.code).volatile.emit("pos", { s: secondsLeft(r, now), p: flat });
  if (r.dirty && now - r.lastRoster >= 100) sendRoster(r);
  if (now >= r.endsAt) endGame(r, "time");
}
setInterval(() => { const now = Date.now(); for (const r of rooms.values()) if (r.phase === "playing") { try { tickRoom(r, now); } catch (e) { console.error("tick", e); } } }, 1000 / CFG.tickHz);

/* ------------------------------------------------------------------ sockets */
function ctxOf(s) { const r = rooms.get(s.data.room), p = r?.players.get(s.id); return r && p ? { r, p } : null; }
function playing(s) { const c = ctxOf(s); return c && c.r.phase === "playing" ? c : null; }

// Wraps handlers: rate-limits each socket and ensures a bad payload can never crash the process.
function on(s, ev, fn) {
  s.on(ev, (...args) => {
    try {
      const t = Date.now(), d = s.data;
      d.tokens = Math.min(120, (d.tokens ?? 120) + ((t - (d.tokenAt || t)) / 1000) * 60); d.tokenAt = t;
      if (d.tokens < 1) return; d.tokens--;
      fn(...args);
    } catch (e) { console.error("handler", ev, e); }
  });
}

function join(s, r, name, avatar) {
  if (s.data.room) return;
  if (r.players.size >= MAX_PLAYERS) return err(s, "Room is full (maximum 30 players).");
  const clean = String(name ?? "").replace(/[<>]/g, "").trim().slice(0, 18) || "Player";
  s.join(r.code); s.data.room = r.code;
  const sp = pick(World.SPAWN_POINTS);
  const safeAvatar = /layne/i.test(clean) ? { color: "#20b9a2", style: "classic", accessoryColor: "#ffd166" } : { color: ["#20b9a2","#ff8a9e","#a78bfa","#ffd166","#60a5fa","#f97316","#f472b6","#a3e635","#f8fafc","#64748b"].includes(avatar?.color) ? avatar.color : "#20b9a2", style: ["classic","shades","cap","bandana","halo","horns","flower","crown","scarf","antenna"].includes(avatar?.style) ? avatar.style : "classic", accessoryColor: ["#ffd166","#ff8a9e","#a78bfa","#60a5fa","#f97316","#f8fafc","#172337","#a3e635"].includes(avatar?.accessoryColor) ? avatar.accessoryColor : "#ffd166" };
  r.players.set(s.id, { id: s.id, n: r.nextN++, name: clean, avatar: safeAvatar, x: sp.x, y: sp.y, score: 0, lives: 3, zombie: false, obj: null,
    boostUntil: 0, shieldUntil: 0, slowUntil: 0, zombieBoostUntil: 0, nextZombieBoostAt: 0, ziplineUntil: 0,
    lastMoveAt: Date.now(), ignoreMoveUntil: 0, pendingAttack: null, attackCooldownUntil: 0 });
  if (!r.host) r.host = s.id;
  s.emit("joined", { code: r.code, playerId: s.id, cfg: CFG });
  io.to(r.code).emit("notice", { type: "info", message: clean + " joined." });
  sendRoster(r);
}

function startGame(s, d) {
  const r = rooms.get(s.data.room);
  if (!r || r.host !== s.id) return err(s, "Only the host can start.");
  if (r.phase !== "lobby") return;
  if (r.players.size < 2) return err(s, "You need at least 2 players.");
  const now = Date.now(), list = [...r.players.values()];
  r.world = World.generateWorld(crypto.randomInt(1, 2 ** 31 - 1));
  const requestedMinutes = Number.parseInt(d?.durationMinutes, 10);
  const durationSeconds = Math.max(60, Math.min(1800, (Number.isFinite(requestedMinutes) ? requestedMinutes : 7) * 60));
  const requestedZombies = Number.parseInt(d?.zombieCount, 10);
  const zombieCount = Math.max(1, Math.min(3, Number.isFinite(requestedZombies) ? requestedZombies : (list.length > 12 ? 2 : 1), list.length - 1));
  r.durationSeconds = durationSeconds; r.seconds = durationSeconds;
  r.phase = "playing"; r.endsAt = now + durationSeconds * 1000; r.relayCooldowns = {}; r.zombieFreezeUntil = now + ZOMBIE_FREEZE_MS;

  // starting zombies
  let pool = [...list], chosen = [];
  if (d?.mode === "chosen") { const f = pool.find(p => p.id === d.playerId); if (f) { chosen.push(f); pool = pool.filter(p => p !== f); } }
  while (chosen.length < zombieCount && pool.length) chosen.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);

  const spawns = shuffle([...World.SPAWN_POINTS]);
  list.forEach((p, i) => {
    Object.assign(p, { score: 0, lives: 3, zombie: false, boostUntil: 0, shieldUntil: 0, slowUntil: 0, zombieBoostUntil: 0,
      nextZombieBoostAt: 0, ziplineUntil: 0, lastMoveAt: now, ignoreMoveUntil: now + 300, pendingAttack: null, attackCooldownUntil: 0 });
    const sp = spawns[i] || { x: rand(300, 3300), y: pick([100, 3500]) };
    p.x = sp.x; p.y = sp.y;
  });
  spawnPickups(r);
  list.forEach(p => newObjective(r, p));
  chosen.forEach(z => { z.zombie = true; z.lives = 0; z.nextZombieBoostAt = now + 20000; });

  io.to(r.code).emit("world", r.world);
  list.forEach(sendMe);
  sendRoster(r);
  io.to(r.code).emit("notice", { type: "success",
    message: `Match started! ${chosen.map(p => p.name).join(" and ")} ${chosen.length === 1 ? "is" : "are"} the starting zombie${chosen.length === 1 ? "" : "s"} — they are frozen for 5 seconds. Run!` });
}

io.on("connection", s => {
  on(s, "createRoom", d => join(s, makeRoom(), d?.name, d?.avatar));
  on(s, "joinRoom", d => {
    const r = rooms.get(String(d?.code ?? "").trim().toUpperCase());
    if (!r) return err(s, "Room not found. Check the code.");
    if (r.phase !== "lobby") return err(s, "That match has already started.");
    join(s, r, d?.name, d?.avatar);
  });
  on(s, "startGame", d => startGame(s, d));
  on(s, "setAvatar", d => {
    const c = ctxOf(s); if (!c || c.r.phase !== "lobby") return;
    if (/layne/i.test(c.p.name)) return err(s, "Layne's avatar is fixed.");
    const colors = ["#20b9a2","#ff8a9e","#a78bfa","#ffd166","#60a5fa","#f97316","#f472b6","#a3e635","#f8fafc","#64748b"], styles = ["classic","shades","cap","bandana","halo","horns","flower","crown","scarf","antenna"];
    const accessoryColors = ["#ffd166","#ff8a9e","#a78bfa","#60a5fa","#f97316","#f8fafc","#172337","#a3e635"];
    c.p.avatar = { color: colors.includes(d?.color) ? d.color : c.p.avatar.color, style: styles.includes(d?.style) ? d.style : c.p.avatar.style, accessoryColor: accessoryColors.includes(d?.accessoryColor) ? d.accessoryColor : (c.p.avatar.accessoryColor || "#ffd166") };
    touch(c.r); sendRoster(c.r);
  });

  on(s, "move", d => {
    const c = playing(s); if (!c) return; const { r, p } = c, now = Date.now();
    const dt = Math.min(0.5, (now - p.lastMoveAt) / 1000); p.lastMoveAt = now;
    if (now < p.ignoreMoveUntil || (p.zombie && now < r.zombieFreezeUntil) || dt <= 0) return;
    let x = Number(d?.x), y = Number(d?.y); if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const maxStep = speedOf(r, p, now) * dt * 1.4 + 14, dx = x - p.x, dy = y - p.y, l = Math.hypot(dx, dy);
    if (l > maxStep) { x = p.x + dx / l * maxStep; y = p.y + dy / l * maxStep; }
    x = Math.max(20, Math.min(World.MAP.width - 20, x)); y = Math.max(20, Math.min(World.MAP.height - 20, y));
    if (World.canMove(r.world, p.x, p.y, x, p.y)) p.x = x;
    if (World.canMove(r.world, p.x, p.y, p.x, y)) p.y = y;
  });

  on(s, "activateRelay", d => {
    const c = playing(s); if (!c) return; const { r, p } = c, relay = r.world.relays.find(x => x.id === d?.relayId);
    if (!relay) return;
    if (!near(p, relay, CFG.range.relay + TOL)) return err(s, "Move closer to the relay console.");
    const now = Date.now(), ready = r.relayCooldowns[relay.id] || 0;
    if (now < ready) return err(s, `Relay recharging for ${Math.ceil((ready - now) / 1000)} seconds.`);
    r.relayCooldowns[relay.id] = now + 20000;
    if (p.zombie) p.zombieBoostUntil = now + 3000; else p.boostUntil = now + 3000;
    notify(p, "success", p.zombie ? "Relay surge! Zombie speed is 225 for 3 seconds." : "Relay surge! Speed boost for 3 seconds.");
    touch(r);
  });

  on(s, "collectPickup", d => {
    const c = playing(s); if (!c) return; const { r, p } = c, item = r.pickups.find(x => x.id === d?.id); if (!item) return;
    if (p.zombie && item.type !== "boost") return err(s, "Zombies can only collect speed boosts.");
    if (!near(p, item, CFG.range.pickup + TOL)) return;
    const now = Date.now(); r.pickups = r.pickups.filter(x => x !== item);
    if (item.type === "boost") {
      if (p.zombie) p.zombieBoostUntil = now + BOOST_MS; else p.boostUntil = now + BOOST_MS;
      notify(p, "success", p.zombie ? "Zombie speed boost! 225 speed for 3 seconds." : "Speed boost collected! Extra speed for 3 seconds.");
    } else {
      const had = p.lives < 3; if (had) p.lives++;
      p.shieldUntil = Math.max(p.shieldUntil, now + 2500);
      notify(p, "success", had ? "Bandage collected! Restored one life." : "Bandage collected! Brief protection granted.");
    }
    touch(r);
  });

  on(s, "useZipline", d => {
    const c = playing(s); if (!c) return; const { r, p } = c, now = Date.now();
    if (now < p.ziplineUntil) return err(s, `Zipline cooling down for ${Math.ceil((p.ziplineUntil - now) / 1000)} seconds.`);
    let best = null, bd = Infinity;
    for (const z of r.world.ziplines) {
      if (d?.ziplineId && z.id !== d.ziplineId) continue;
      const d1 = dist(p, z), d2 = dist(p, { x: z.endX, y: z.endY }), m = Math.min(d1, d2);
      if (m < bd) { bd = m; best = { dest: d1 <= d2 ? { x: z.endX, y: z.endY } : { x: z.x, y: z.y } }; }
    }
    if (!best || bd > CFG.range.zip + TOL) return err(s, "Move closer to a zipline platform.");
    p.x = best.dest.x; p.y = best.dest.y; p.ziplineUntil = now + 10000; p.ignoreMoveUntil = now + 250;
    notify(p, "success", "Zipline! 10-second cooldown started.");
  });

  on(s, "useGuideStation", () => {
    const c = playing(s); if (!c || c.p.zombie || !c.p.obj) return; const { r, p } = c;
    if (!near(p, r.world.guide, CFG.range.guide + TOL)) return err(s, "Move closer to the central guidance station.");
    const o = p.obj;
    s.emit("guideTargets", { crateId: o.crate.id, crate: { x: o.crate.x, y: o.crate.y }, computer: { x: o.computer.x, y: o.computer.y } });
    notify(p, "success", "Guidance activated! Follow the arrows to your crate and computer.");
  });

  on(s, "getFile", d => {
    const c = playing(s); if (!c) return; const { r, p } = c, o = p.obj, st = r.world.stations.find(x => x.id === d?.stationId);
    if (!o || p.zombie) return;
    if (!st || !near(p, st, CFG.range.file + TOL)) return err(s, "Move closer to a file station.");
    if (o.file) return err(s, "You already have your file.");
    if (d.pronoun !== o.pronoun || d.aux !== o.aux) return err(s, "Incorrect pronoun or auxiliary. Check your objective.");
    o.file = true; p.boostUntil = Date.now() + BOOST_MS;
    notify(p, "success", "Auxiliary combo! File collected — speed boost for 3 seconds!");
    sendMe(p); touch(r);
  });

  on(s, "openCrate", d => {
    const c = playing(s); if (!c || c.p.zombie) return; const { r, p } = c;
    const owner = [...r.players.values()].find(q => q.obj?.crate.id === d?.crateId);
    if (!owner) return err(s, "Crate not found.");
    if (!near(p, owner.obj.crate, CFG.range.crate + TOL)) return err(s, "Move closer to the crate.");
    if (owner.id !== p.id) {
      p.slowUntil = Date.now() + SLOW_MS; touch(r);
      return notify(p, "warning", `This is ${owner.name}’s crate! You triggered a 5-second slow debuff.`);
    }
    const o = p.obj; if (o.password) return err(s, "You already have this password.");
    s.emit("quiz", { crateId: o.crate.id, verb: o.verb.inf, sentence: sentenceEn(o.pronoun, o.verb), choices: choicesFor(o.pp, o.verb),
      prompt: `Choose the correct passé composé past participle for “${o.verb.inf}”.` });
  });

  on(s, "answerQuiz", d => {
    const c = playing(s); if (!c || c.p.zombie) return; const { r, p } = c, o = p.obj;
    if (!o || d?.crateId !== o.crate.id || !near(p, o.crate, CFG.range.crate + 30)) { s.emit("quizAbort", { message: "You are too far from your assigned crate." }); return; }
    if (o.password) return s.emit("quizAbort", { message: "You already have this password." });
    if (norm(d.answer) === norm(o.pp)) {
      o.password = true; p.boostUntil = Date.now() + BOOST_MS;
      s.emit("quizResult", { correct: true, explanation: `Correct! ${sentenceFr(o)}. Speed boost for 3 seconds!`, sfx: "correct" });
      sendMe(p);
    } else {
      p.slowUntil = Date.now() + SLOW_MS;
      s.emit("quizResult", { correct: false, explanation: `Not quite — the correct answer is “${o.pp}”. You are slowed for 5 seconds.`, sfx: "wrong" });
    }
    touch(r);
  });

  on(s, "startZombieAttack", d => {
    const c = playing(s); if (!c) return; const { r, p: a } = c, t = r.players.get(d?.targetId), now = Date.now();
    if (!a.zombie || !t || t.zombie || dist(a, t) > CFG.range.victim + TOL) return;
    if (now < r.zombieFreezeUntil) return err(s, "The horde is still waking up…");
    if (now < a.attackCooldownUntil) return err(s, `Recovering — attack again in ${Math.ceil((a.attackCooldownUntil - now) / 1000)}s.`);
    if (now < t.shieldUntil) return err(s, `${t.name} is shielded for ${Math.ceil((t.shieldUntil - now) / 1000)} more seconds.`);
    // Re-opening the window reuses the same question, so it can't be re-rolled until an easy one appears.
    if (!a.pendingAttack || a.pendingAttack.targetId !== t.id || now > a.pendingAttack.expires) {
      const v = pick(verbs), pronoun = pick(pronouns), pp = ppFor(v, pronoun);
      a.pendingAttack = { targetId: t.id, crateId: "za" + newId(), correct: pp, expires: now + 15000,
        payload: { targetId: t.id, targetName: t.name, verb: v.inf, sentence: sentenceEn(pronoun, v), choices: choicesFor(pp, v),
          prompt: `What is the participe passé of ${v.inf.toUpperCase()}:` } };
    }
    s.emit("zombieQuiz", { ...a.pendingAttack.payload, crateId: a.pendingAttack.crateId, seconds: Math.ceil((a.pendingAttack.expires - now) / 1000) });
  });

  on(s, "answerZombieQuiz", d => {
    const c = playing(s); if (!c) return; const { r, p: a } = c, q = a.pendingAttack;
    if (!a.zombie || !q || d?.crateId !== q.crateId) return;
    const t = r.players.get(q.targetId), now = Date.now(); a.pendingAttack = null;
    if (now > q.expires || !t || t.zombie || dist(a, t) > CFG.range.victim + TOL) return s.emit("quizAbort", { message: "Attack expired. Get closer and try again." });
    if (now < t.shieldUntil) return s.emit("quizAbort", { message: `${t.name} is shielded.` });
    if (norm(d.answer) !== norm(q.correct)) {
      a.attackCooldownUntil = now + ATTACK_COOLDOWN_MS;
      return s.emit("quizResult", { correct: false, explanation: "Incorrect! The attack failed — 3 second cooldown.", sfx: "wrong" });
    }
    hitPlayer(r, a, t);
  });

  on(s, "submitComputer", d => {
    const c = playing(s); if (!c || c.p.zombie) return; const { r, p } = c, o = p.obj; if (!o) return;
    if (d?.computerId !== o.computer.id) return err(s, "That is not your computer.");
    if (!near(p, o.computer, CFG.range.pc + TOL)) return err(s, "Move closer to your computer.");
    if (!o.file || !o.password) return err(s, "You need both the file and password.");
    p.score++; p.boostUntil = Date.now() + BOOST_MS;
    notify(p, "success", `Objective complete! +1 point — 3-second speed boost! ${sentenceFr(o)}`, "point");
    newObjective(r, p); sendMe(p); touch(r);
  });

  on(s, "restartGame", () => {
    const r = rooms.get(s.data.room); if (!r || r.host !== s.id || r.phase !== "ended") return;
    r.phase = "lobby"; r.seconds = DURATION; r.world = null; r.pickups = [];
    r.players.forEach(p => Object.assign(p, { obj: null, score: 0, lives: 3, zombie: false, boostUntil: 0, shieldUntil: 0, slowUntil: 0, zombieBoostUntil: 0, pendingAttack: null }));
    sendRoster(r);
  });

  s.on("disconnect", () => {
    const r = rooms.get(s.data.room); if (!r) return;
    r.players.delete(s.id);
    if (!r.players.size) { rooms.delete(r.code); return; }
    if (r.host === s.id) r.host = r.players.keys().next().value;
    if (!checkEndConditions(r)) { if (r.phase === "playing") touch(r); else sendRoster(r); }
  });
});

if (require.main === module) server.listen(PORT, () => console.log("Passé Panic running on " + PORT));
module.exports = { app, server, io, rooms, CFG, verbs, choicesFor, sentenceEn, ppFor };