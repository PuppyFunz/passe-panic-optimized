(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const sock = io();
  const S = { screen: "landing", phase: "lobby", host: null, code: null, myId: null, seconds: 0, players: new Map(), byN: new Map(),
    world: null, pickups: [], me: null, cfg: null, guide: null, zFreeze: 0, modalOpen: false, quiz: null };
  const R = PPRender.create($("world"), $("minimap"), S);
  const coarse = matchMedia("(pointer: coarse)");
  const keys = new Set(), reqAt = {};
  let local = null, moving = false, wasMoving = false, lastSend = 0, joy = { x: 0, y: 0 }, mouseWorld = null, target = null;
  let hudDirty = true, toastTimer = 0, quizButtons = [], quizTimer = 0;
  const me = () => S.players.get(S.myId);
  const now = () => performance.now();

  /* ================================================================ UI helpers */
  function show(name) { S.screen = name; ["landing", "lobby", "game"].forEach(s => $(s).classList.toggle("hidden", s !== name)); }
  function toast(msg, type = "") { const t = $("toast"); t.textContent = msg; t.className = "toast " + type; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 3000); }
  function modal(title, desc, eyebrow = "INTERACTION") {
    S.modalOpen = true; quizButtons = []; clearTimeout(quizTimer);
    $("modalDesc").classList.remove("zombie-question"); $("modalTitle").textContent = title; $("modalDesc").textContent = desc || ""; $("modalEyebrow").textContent = eyebrow;
    $("modalContent").innerHTML = ""; $("modal").classList.remove("hidden");
  }
  function close() { S.modalOpen = false; S.quiz = null; quizButtons = []; clearTimeout(quizTimer); $("modal").classList.add("hidden"); }
  $("closeModal").addEventListener("click", close);
  $("modal").addEventListener("click", e => { if (e.target === $("modal")) close(); });
  function button(text, fn, cls = "primary modal-action") { const b = document.createElement("button"); b.className = cls; b.textContent = text; b.onclick = fn; $("modalContent").appendChild(b); return b; }
  function select(label, values) {
    const wrap = document.createElement("div"), l = document.createElement("label"), s = document.createElement("select");
    l.textContent = label; values.forEach(v => { const o = document.createElement("option"); o.value = v; o.textContent = v; s.appendChild(o); }); wrap.append(l, s);
    return { wrap, get value() { return s.value; } };
  }
  document.addEventListener("click", e => { const b = e.target.closest && e.target.closest("button"); if (b) b.blur(); }); // keep keyboard controls live after clicking a button

  /* ================================================================ audio */
  let audioCtx = null, muted = false;
  try { muted = localStorage.getItem("pp-muted") === "1"; } catch { /* storage blocked */ }
  function ensureAudio() { if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; } } if (audioCtx.state === "suspended") audioCtx.resume(); }
  function tone(freq, dur, type = "sine", gain = .08, when = 0) {
    const t = audioCtx.currentTime + when, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(.001, gain), t + .025); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    o.connect(g); g.connect(audioCtx.destination); o.start(t); o.stop(t + dur + .03);
  }
  const SFX = {
    correct: [[660, .12, "sine", .07, 0], [880, .18, "sine", .07, .1]], wrong: [[180, .25, "sawtooth", .06, 0], [130, .28, "sawtooth", .05, .12]],
    hit: [[90, .28, "sawtooth", .12, 0], [55, .35, "triangle", .1, .08]], convert: [[110, .5, "sawtooth", .1, 0], [82, .6, "sawtooth", .1, .18], [55, .7, "triangle", .08, .38]],
    point: [[523, .1, "triangle", .06, 0], [659, .12, "triangle", .06, .08], [784, .22, "triangle", .06, .16]],
    stinger: [[220, .5, "sawtooth", .07, 0], [165, .6, "sawtooth", .08, .12], [110, .7, "triangle", .08, .25]],
    gameover: [[220, .45, "sawtooth", .08, 0], [165, .55, "sawtooth", .08, .3], [82, .8, "triangle", .1, .65]],
  };
  function sfx(kind) { if (muted) return; ensureAudio(); if (audioCtx) (SFX[kind] || []).forEach(a => tone(...a)); }
  ["pointerdown", "keydown"].forEach(ev => addEventListener(ev, () => { ensureAudio(); }, { passive: true }));
  $("muteBtn").textContent = muted ? "🔇" : "🔊";
  $("muteBtn").onclick = () => { muted = !muted; try { localStorage.setItem("pp-muted", muted ? "1" : "0"); } catch { /* ignore */ } $("muteBtn").textContent = muted ? "🔇" : "🔊";  };

  /* ================================================================ landing / lobby */
  const nameValue = () => $("playerName").value.trim();
  const chosenAvatar = () => ({ color: $("avatarColor").value, style: $("avatarStyle").value, accessoryColor: $("accessoryColor").value });
  $("createBtn").onclick = () => { ensureAudio(); sock.emit("createRoom", { name: nameValue(), avatar: chosenAvatar() }); };
  $("joinBtn").onclick = () => { ensureAudio(); sock.emit("joinRoom", { code: $("roomCode").value.trim(), name: nameValue(), avatar: chosenAvatar() }); };
  function updateAvatarSettings() {
    const fixed = /layne/i.test(nameValue() || me()?.name || "");
    $("avatarColor").disabled = fixed; $("avatarStyle").disabled = fixed; $("accessoryColor").disabled = fixed;
    $("avatarNote").textContent = fixed ? "Layne's avatar is fixed and cannot be customized." : "Changes apply to your avatar in the match.";
    if (S.myId && !fixed) sock.emit("setAvatar", chosenAvatar());
  }
  $("avatarColor").addEventListener("change", updateAvatarSettings);
  $("avatarStyle").addEventListener("change", updateAvatarSettings);
  $("accessoryColor").addEventListener("change", updateAvatarSettings);
  $("playerName").addEventListener("input", () => { if (!S.myId) updateAvatarSettings(); });
  $("roomCode").addEventListener("keydown", e => { if (e.key === "Enter") $("joinBtn").click(); });
  $("playerName").addEventListener("keydown", e => { if (e.key === "Enter") ($("roomCode").value.trim() ? $("joinBtn") : $("createBtn")).click(); });
  $("startBtn").onclick = () => { ensureAudio(); sock.emit("startGame", { mode: $("zombieMode").value, playerId: $("zombiePlayer").value, zombieCount: Number($("zombieCount").value), durationMinutes: Number($("matchDuration").value) }); };
  $("leaveBtn").onclick = () => location.reload();
  $("zombieMode").onchange = () => { $("zombiePlayer").disabled = $("zombieMode").value !== "chosen"; };
  $("copyBtn").onclick = async () => { try { await navigator.clipboard.writeText(S.code); toast("Room code copied"); } catch { toast("Room code: " + S.code); } };
  $("shareGameBtn").onclick = showShareQR;
  const roomFromUrl = new URLSearchParams(location.search).get("room"); if (roomFromUrl) $("roomCode").value = roomFromUrl.toUpperCase().slice(0, 6);
  $("interactBtn").onclick = interact;
  $("helpBtn").onclick = () => {
    modal("How to play", "1. Visit a file station and pick the French pronoun + auxiliary that match your English objective. 2. Open your own crate and choose the correct past participle (keys 1–4 work too). 3. Bring both items to your computer to score. Walk over speed boosts to grab them. Shallow water slows you down. Zombies chase players; each correct answer removes a life and gives a 10-second shield.", "QUICK GUIDE");
    button("Got it", close);
  };

  function showShareQR() {
    if (!S.code) { toast("Create or join a room first", "warning"); return; }
    const url = new URL(location.href); url.search = ""; url.searchParams.set("room", S.code); url.hash = "";
    modal("Scan to join Passé Panic", "Scan this QR code with a phone camera to open the game with room code " + S.code + " pre-filled.", "SHARE THIS ROOM");
    const wrap = document.createElement("div"), qr = document.createElement("div"), link = document.createElement("a");
    wrap.className = "qr-wrap"; qr.className = "qr-code"; link.className = "share-link"; link.href = url.toString(); link.textContent = url.toString(); link.target = "_blank"; link.rel = "noopener noreferrer";
    wrap.append(qr, link); $("modalContent").appendChild(wrap);
    if (window.QRCode) new QRCode(qr, { text: url.toString(), width: 220, height: 220, colorDark: "#173321", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
    else { qr.textContent = "QR code library did not load. Use Copy Link instead."; qr.classList.add("qr-fallback"); }
    button("Copy game link", async () => { try { await navigator.clipboard.writeText(url.toString()); toast("Game link copied"); } catch { toast(url.toString()); } }, "secondary modal-action");
    button("Done", close, "ghost modal-action");
  }

  let lobbySig = "";
  function renderLobby() {
    const list = [...S.players.values()], isHost = S.host === S.myId;
    const sig = list.map(p => p.id + p.name + JSON.stringify(p.avatar || {})).join("|") + S.host + S.myId;
    if (sig === lobbySig) return; lobbySig = sig; // don't rebuild (and close an open dropdown) unless the roster really changed
    $("lobbyCode").textContent = "ROOM " + S.code; $("shareCode").textContent = S.code; $("playerCount").textContent = list.length;
    $("startBtn").classList.toggle("hidden", !isHost); $("hostSettings").classList.toggle("hidden", !isHost);
    const box = $("lobbyPlayers"); box.innerHTML = "";
    for (const p of list) { const e = document.createElement("div"); e.className = "playerrow"; e.textContent = p.name + (p.id === S.host ? " · HOST" : "") + (p.id === S.myId ? " (you)" : ""); if (!/layne/i.test(p.name)) { e.style.borderLeft = "5px solid " + (p.avatar?.color || "#20b9a2"); } box.appendChild(e); }
    if (isHost) {
      const sel = $("zombiePlayer"), prev = sel.value; sel.innerHTML = "";
      for (const p of list) { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name + (p.id === S.myId ? " (you)" : ""); sel.appendChild(o); }
      if (list.some(p => p.id === prev)) sel.value = prev; sel.disabled = $("zombieMode").value !== "chosen";
    }
  }

  /* ================================================================ network */
  sock.on("joined", d => { S.code = d.code; S.myId = d.playerId; S.cfg = d.cfg; lobbySig = ""; show("lobby"); updateAvatarSettings(); toast("Joined room " + d.code); });
  sock.on("notice", d => { toast(d.message, d.type === "error" ? "error" : d.type === "warning" ? "warning" : ""); if (d.sfx) sfx(d.sfx); });
  sock.on("world", w => { S.world = w; R.setWorld(w); });
  sock.on("me", m => { S.me = m; if (S.guide && S.guide.crateId !== m.crate.id) S.guide = null; hudDirty = true; });
  sock.on("guideTargets", g => { S.guide = g; });
  sock.on("hitEffect", d => { sfx("hit"); toast("Shield active for " + d.duration + " seconds", "warning"); });
  sock.on("quizAbort", d => { close(); toast(d.message, "warning"); });
  sock.on("quiz", d => showQuiz(d));
  sock.on("zombieQuiz", d => showZombieQuiz(d));
  sock.on("quizResult", d => { close(); sfx(d.sfx || (d.correct ? "correct" : "wrong")); toast(d.explanation, d.correct ? "" : "warning"); hudDirty = true; });
  sock.on("gameOver", d => gameOver(d));

  sock.on("room", r => {
    const t = now(), prev = S.phase, seen = new Set();
    S.code = r.code; S.host = r.host; S.seconds = r.seconds; S.pickups = r.pickups; S.zFreeze = t + r.zf; S.phase = r.phase;
    for (const q of r.players) {
      let p = S.players.get(q.id); if (!p) { p = { id: q.id, x: q.x, y: q.y }; S.players.set(q.id, p); }
      Object.assign(p, { n: q.n, name: q.name, avatar: q.avatar || { color: "#20b9a2", style: "classic" }, score: q.score, lives: q.lives, zombie: q.zombie, crate: q.crate,
        boostUntil: t + q.b, shieldUntil: t + q.s, slowUntil: t + q.sl, zBoostUntil: t + q.zb });
      S.byN.set(q.n, p); seen.add(q.id);
      if (prev !== "playing" && r.phase === "playing") { p.x = q.x; p.y = q.y; p.rx = q.x; p.ry = q.y; }
    }
    for (const [id, p] of S.players) if (!seen.has(id)) { S.players.delete(id); S.byN.delete(p.n); }
    if (prev !== r.phase) onPhase(prev, r.phase);
    if (r.phase === "lobby") renderLobby();
    hudDirty = true;
  });
  function onPhase(prev, next) {
    if (next === "playing") { close(); show("game"); S.guide = null; const p = me(); local = p ? { x: p.x, y: p.y } : null; $("hint").textContent = "Explore the map."; }
    else if (next === "ended") { /* no background music to stop */ }
    else if (next === "lobby") { close(); S.world = null; S.me = null; S.guide = null; local = null; R.clear(); lobbySig = ""; show("lobby"); renderLobby(); }
  }
  sock.on("pos", m => {
    S.seconds = m.s; const a = m.p;
    for (let i = 0; i < a.length; i += 3) { const p = S.byN.get(a[i]); if (!p) continue; p.x = a[i + 1]; p.y = a[i + 2]; if (p.id === S.myId) reconcile(p); }
  });
  // The server runs ~one latency behind our prediction, so small differences are normal; only correct real divergence.
  function reconcile(p) {
    if (!local) { local = { x: p.x, y: p.y }; return; }
    const ex = p.x - local.x, ey = p.y - local.y, e = Math.hypot(ex, ey);
    if (e > 220) { local.x = p.x; local.y = p.y; }
    else if (e > 70) { local.x += ex * .15; local.y += ey * .15; }
    else if (!moving && e > 2) { local.x += ex * .3; local.y += ey * .3; }
  }

  /* ================================================================ HUD */
  const cache = {};
  const setText = (id, v) => { if (cache[id] !== v) { cache[id] = v; $(id).textContent = v; } };
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  let boardSig = "";
  function updateHud() {
    const p = me(); if (!p) return; const o = S.me, t = S.seconds;
    setText("timer", Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0")); setText("score", String(p.score)); setText("lives", p.zombie ? "🧟" : String(p.lives));
    setText("verb", o ? o.en : "Waiting"); setText("target", o ? "English meaning: " + cap(o.sentenceEn) : "No objective");
    setText("progress", (o?.file ? "✓" : "○") + " File · " + (o?.password ? "✓" : "○") + " Password");
    const inv = `📄 ${o?.file ? o.fileLabel : "No file"}<br><br>🔑 ${o?.password ? "Password: " + o.verb : "No password"}`;
    if (cache.inv !== inv) { cache.inv = inv; $("inventory").innerHTML = inv; }
    const rows = [...S.players.values()].sort((a, b) => b.score - a.score), sig = rows.map(r => r.id + r.score + r.lives + r.zombie).join("|");
    if (sig !== boardSig) {
      boardSig = sig; const box = $("leaderboard"); box.innerHTML = "";
      rows.forEach((pl, i) => {
        const row = document.createElement("div"), name = document.createElement("span"), sc = document.createElement("b");
        row.className = "small"; row.style.cssText = "display:flex;justify-content:space-between;margin:7px 0";
        name.textContent = `${i + 1}. ${pl.zombie ? "🧟 " : ""}${pl.name}${pl.id === S.myId ? " (you)" : ""}${pl.zombie ? " · ZOMBIE" : ` · ❤️ ${pl.lives}`}`; sc.textContent = pl.score; row.append(name, sc); box.appendChild(row);
      });
    }
    updateHint(p);
  }
  const HINTS = { guide: "Central guidance station — INTERACT for target arrows", pickup: "Collect this item — INTERACT", zipline: "Zipline platform — INTERACT to ride across", relay: "Speed relay — INTERACT for a 3-second boost",
    file: "File station nearby — INTERACT", crate: "Your password crate nearby — INTERACT", otherCrate: "Someone else’s crate — INTERACT to trigger a 5-second slow!", victim: "Living player nearby — INTERACT to answer an attack question!", pc: "Your computer nearby — INTERACT" };
  function updateHint(p) {
    let txt;
    if (p.zombie) {
      const t = now(), boost = t < p.zBoostUntil, fin = S.seconds <= S.cfg.finalSeconds, sp = boost ? S.cfg.zombieBoostSpeed : fin ? S.cfg.zombieFinalSpeed : S.cfg.zombieSpeed;
      txt = t < S.zFreeze ? `🧟 The horde wakes in ${Math.ceil((S.zFreeze - t) / 1000)}s…` : `🧟 ZOMBIE: challenge nearby players! Speed ${sp}${fin ? " — FINAL 2 MINUTES!" : ""}.`;
      if (target && HINTS[target.kind] && t >= S.zFreeze) txt = HINTS[target.kind];
    } else txt = target ? HINTS[target.kind] : (S.me?.file && S.me?.password ? "You have both items. Find your computer!" : "Find your file station and assigned password crate.");
    setText("hint", txt);
  }

  /* ================================================================ interaction */
  function nearest() {
    const p = me(); if (!p || !local || !S.world || !S.cfg) return null;
    const R_ = S.cfg.range, x = local.x, y = local.y; let best = null, bd = 1e9;
    const consider = (kind, item, cx, cy, r) => { const d = Math.hypot(x - cx, y - cy); if (d < r && d < bd) { bd = d; best = { kind, item, d }; } };
    if (!p.zombie) {
      const mine = p.crate; if (mine && Math.hypot(x - mine.x, y - mine.y) < R_.crate) return { kind: "crate", item: mine, d: 0 };
      consider("guide", S.world.guide, S.world.guide.x, S.world.guide.y, R_.guide);
      for (const s of S.world.stations) consider("file", s, s.x, s.y, R_.file);
      for (const q of S.players.values()) if (q.crate && q.id !== S.myId) consider("otherCrate", q.crate, q.crate.x, q.crate.y, R_.crate);
      if (S.me) consider("pc", S.me.computer, S.me.computer.x, S.me.computer.y, R_.pc);
    } else for (const q of S.players.values()) if (!q.zombie && q.id !== S.myId && q.rx !== undefined) consider("victim", q, q.rx, q.ry, R_.victim);
    for (const it of S.pickups) if (!p.zombie || it.type === "boost") consider("pickup", it, it.x, it.y, R_.pickup);
    for (const z of S.world.ziplines) { consider("zipline", { x: z.x, y: z.y, id: z.id }, z.x, z.y, R_.zip); consider("zipline", { x: z.endX, y: z.endY, id: z.id }, z.endX, z.endY, R_.zip); }
    for (const r of S.world.relays) consider("relay", r, r.x, r.y, R_.relay);
    return best;
  }
  function interact() {
    ensureAudio(); if (S.modalOpen || S.phase !== "playing") return;
    const p = me(); if (!p) return; const t = target = nearest();
    if (p.zombie && now() < S.zFreeze) { toast("The horde is still waking up…", "warning"); return; }
    if (!t) { toast(p.zombie ? "Get close to a living player, speed boost, relay or zipline." : "Move closer to a file station, crate, computer, relay or the guidance station."); return; }
    switch (t.kind) {
      case "pickup": sock.emit("collectPickup", { id: t.item.id }); break;
      case "zipline": sock.emit("useZipline", { ziplineId: t.item.id }); break;
      case "relay": sock.emit("activateRelay", { relayId: t.item.id }); break;
      case "guide": sock.emit("useGuideStation"); break;
      case "victim": sock.emit("startZombieAttack", { targetId: t.item.id }); break;
      case "crate": case "otherCrate": sock.emit("openCrate", { crateId: t.item.id }); break;
      case "file": fileForm(t.item); break;
      case "pc": computerForm(t.item); break;
    }
  }
  function fileForm(st) {
    modal("Request grammar file", "Use the English objective below to work out the matching French pronoun and auxiliary.", "FILE STATION");
    const fields = document.createElement("div"); fields.className = "fields";
    const pSel = select("Pronoun", ["je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles"]), aSel = select("Auxiliary", ["ai", "as", "a", "avons", "avez", "ont", "suis", "es", "est", "sommes", "êtes", "sont"]);
    fields.append(pSel.wrap, aSel.wrap); $("modalContent").appendChild(fields);
    const hint = document.createElement("div"); hint.className = "result"; hint.textContent = `English objective: ${cap(S.me.sentenceEn)}. Enter its French pronoun and auxiliary below.`; $("modalContent").appendChild(hint);
    button("Request file", () => { sock.emit("getFile", { stationId: st.id, pronoun: pSel.value, aux: aSel.value }); close(); });
  }
  function computerForm(pc) {
    const o = S.me; modal("Computer directory", "Review your assigned directory, then submit your file and password.", "YOUR COMPUTER · DIRECTORY");
    const dir = document.createElement("div"); dir.className = "result directory"; dir.innerHTML = "<strong>📁 OBJECTIVE DIRECTORY</strong>";
    [`Target verb: ${o.en} (${o.verb})`, `English meaning: ${cap(o.sentenceEn)}`, `Grammar file: ${o.file ? "✓ Collected" : "○ Missing"}`, `Password: ${o.password ? "✓ Acquired" : "○ Missing"}`]
      .forEach(t => { const row = document.createElement("p"); row.textContent = t; row.style.margin = "8px 0"; dir.appendChild(row); });
    $("modalContent").appendChild(dir);
    const s = document.createElement("div"); s.className = "result"; s.textContent = "Directory access is available at your computer only. The crate remains a password quiz."; $("modalContent").appendChild(s);
    button("Submit both items", () => { sock.emit("submitComputer", { computerId: pc.id }); close(); }).disabled = !(o.file && o.password);
  }
  function answerGrid(d, evt, seconds) {
    if (seconds) {
      const bar = document.createElement("div"), i = document.createElement("i"); bar.className = "timerbar"; bar.appendChild(i); $("modalContent").appendChild(bar);
      requestAnimationFrame(() => requestAnimationFrame(() => { i.style.transition = `width ${seconds}s linear`; i.style.width = "0%"; }));
      quizTimer = setTimeout(() => { if (S.quiz === d) { close(); toast("Attack window expired.", "warning"); } }, seconds * 1000);
    }
    const grid = document.createElement("div"); grid.className = "answers";
    d.choices.forEach((v, idx) => {
      const b = document.createElement("button"), k = document.createElement("span"); k.className = "k"; k.textContent = idx + 1; b.append(k, document.createTextNode(v));
      b.onclick = () => { grid.querySelectorAll("button").forEach(x => { x.disabled = true; }); sock.emit(evt, { crateId: d.crateId, answer: v }); };
      grid.appendChild(b); quizButtons.push(b);
    });
    $("modalContent").appendChild(grid);
  }
  function showQuiz(d) {
    modal(d.verb, d.prompt + " Sentence: " + d.sentence, "PASSWORD CRATE"); S.quiz = d; answerGrid(d, "answerQuiz");
    const n = document.createElement("p"); n.textContent = "Correct answers give a temporary speed boost."; $("modalContent").appendChild(n);
  }
  function showZombieQuiz(d) {
    sfx("stinger"); modal("Attack: " + d.targetName, d.prompt, "ZOMBIE CHALLENGE"); S.quiz = d; $("modalDesc").classList.add("zombie-question");
    const sen = document.createElement("p"); sen.textContent = "Sentence: " + d.sentence; $("modalContent").appendChild(sen); answerGrid(d, "answerZombieQuiz", d.seconds);
    const n = document.createElement("p"); n.textContent = "Correct answer = take one life. Converting a player gives +1 point."; $("modalContent").appendChild(n);
  }
  function gameOver(d) {
    sfx("gameover");
    const title = d.reason === "allZombies" ? "EVERYONE IS A ZOMBIE!" : d.reason === "notEnough" ? "Not enough players left" : d.winners.length > 1 ? "It's a tie: " + d.winners.join(" & ") : d.winners.length ? d.winners[0] + " wins!" : "Match complete";
    modal(title, d.reason === "allZombies" ? "The horde has taken over the arena." : "Final scores", d.reason === "allZombies" ? "THE HORDE WINS" : "MATCH OVER");
    (d.scores || []).forEach((p, i) => { const row = document.createElement("p"); row.textContent = `${i + 1}. ${p.name} — ${p.score} points`; $("modalContent").appendChild(row); });
    if (S.host === S.myId) button("Back to lobby", () => { close(); sock.emit("restartGame"); });
    else { const w = document.createElement("p"); w.textContent = "Waiting for the host to return to the lobby…"; $("modalContent").appendChild(w); }
  }

  /* ================================================================ input + movement */
  const typing = e => { const t = e.target && e.target.tagName; return t === "INPUT" || t === "TEXTAREA" || t === "SELECT"; };
  addEventListener("keydown", e => {
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (S.screen !== "game") return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(k)) e.preventDefault();
    keys.add(k);
    if (k === "Escape" && S.modalOpen) { close(); return; }
    if (S.modalOpen) { if (/^[1-4]$/.test(k) && quizButtons[+k - 1] && !quizButtons[+k - 1].disabled) quizButtons[+k - 1].click(); return; }
    if ((k === "e" || k === " " || k === "Enter") && !e.repeat) interact();
  }, { passive: false });
  addEventListener("keyup", e => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
  addEventListener("blur", () => { keys.clear(); resetJoystick(); });

  const joystick = $("joystick"), knob = $("joystickKnob"); let joyPointer = null;
  $("world").addEventListener("pointermove", e => { if (e.pointerType === "mouse") { const r = e.target.getBoundingClientRect(); mouseWorld = { x: (e.clientX - r.left) / R.zoom + R.cam.x, y: (e.clientY - r.top) / R.zoom + R.cam.y }; } });
  function updateJoystick(e) {
    const r = joystick.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), max = r.width * .34, len = Math.hypot(dx, dy) || 1, sc = Math.min(1, max / len);
    joy = { x: dx * sc / max, y: dy * sc / max }; knob.style.transform = `translate(${dx * sc}px,${dy * sc}px)`;
  }
  function resetJoystick() { joyPointer = null; joy = { x: 0, y: 0 }; knob.style.transform = "translate(0,0)"; }
  joystick.addEventListener("pointerdown", e => { e.preventDefault(); joyPointer = e.pointerId; joystick.setPointerCapture(e.pointerId); updateJoystick(e); });
  joystick.addEventListener("pointermove", e => { if (e.pointerId === joyPointer) { e.preventDefault(); updateJoystick(e); } });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(ev => joystick.addEventListener(ev, resetJoystick));

  function direction() {
    let x = joy.x, y = joy.y;
    if (keys.has("ArrowLeft") || keys.has("a")) x--; if (keys.has("ArrowRight") || keys.has("d")) x++;
    if (keys.has("ArrowUp") || keys.has("w")) y--; if (keys.has("ArrowDown") || keys.has("s")) y++;
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; } return { x, y, moving: l > .08 };
  }
  function blockedAt(x, y, fromX = local?.x ?? x, fromY = local?.y ?? y) {
    for (const w of S.world.walls) if (x > w.x - 18 && x < w.x + w.w + 18 && y > w.y - 18 && y < w.y + w.h + 18) return true;
    const solid = { tree: 27, pine: 23, pillar: 25, bush: 17, log: 14, crystal: 18 };
    for (const d of (S.world.decor || [])) { const r = solid[d.t]; if (r && Math.hypot(x-d.x,y-d.y) < r*(d.s||1)+18) return true; }
    const inside = (pt, r, pad=0) => pt.x >= r.x-pad && pt.x <= r.x+r.w+pad && pt.y >= r.y-pad && pt.y <= r.y+r.h+pad;
    for (const e of (S.world.elevations || [])) {
      const a=inside({x:fromX,y:fromY},e), b=inside({x,y},e);
      if (a !== b && !(e.ramps || []).some(r => inside({x:fromX,y:fromY},r,20) || inside({x,y},r,20))) return true;
    }
    return false;
  }
    function inWater(x, y) { for (const l of S.world.lakes) { const a = (x - l.x) / l.rx, b = (y - l.y) / l.ry; if (a * a + b * b < 1) return true; } return false; }
  function speedOf(p, t) {
    const c = S.cfg; let s;
    if (p.zombie) s = t < p.zBoostUntil ? c.zombieBoostSpeed : (S.seconds <= c.finalSeconds ? c.zombieFinalSpeed : c.zombieSpeed);
    else { s = c.playerSpeed * (t < p.boostUntil ? c.boostMult : 1); if (t < p.slowUntil) s *= c.slowMult; }
    return inWater(local.x, local.y) ? s * c.waterMult : s;
  }
  function update(dt, t) {
    const p = me(); if (!p || !local || S.phase !== "playing") { moving = false; return; }
    target = nearest();
    // Walking over a speed boost (or a needed bandage) collects it without pressing INTERACT.
    for (const it of S.pickups) {
      if (p.zombie && it.type !== "boost") continue; if (it.type === "bandage" && p.lives >= 3) continue;
      if (Math.hypot(local.x - it.x, local.y - it.y) < S.cfg.autoPickup && t - (reqAt[it.id] || 0) > 900) { reqAt[it.id] = t; sock.emit("collectPickup", { id: it.id }); }
    }
    const d = direction(); moving = d.moving && !S.modalOpen && !(p.zombie && t < S.zFreeze);
    if (moving) {
      const sp = speedOf(p, t), nx = Math.max(20, Math.min(S.world.width - 20, local.x + d.x * sp * dt)), ny = Math.max(20, Math.min(S.world.height - 20, local.y + d.y * sp * dt));
      if (!blockedAt(nx, local.y, local.x, local.y)) local.x = nx; if (!blockedAt(local.x, ny, local.x, local.y)) local.y = ny;
      if (t - lastSend > 50) { sock.emit("move", { x: Math.round(local.x * 10) / 10, y: Math.round(local.y * 10) / 10 }); lastSend = t; }
    } else if (wasMoving) { sock.emit("move", { x: Math.round(local.x * 10) / 10, y: Math.round(local.y * 10) / 10 }); lastSend = t; }
    wasMoving = moving;
  }

  let last = performance.now(), lastHud = 0, lastMini = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = Math.min(.05, (t - last) / 1000); last = t;
    if (S.screen !== "game" || !S.world || !local) return;
    update(dt, t);
    let look = null;
    if (coarse.matches && Math.hypot(joy.x, joy.y) > .12) look = { x: joy.x * 2.1, y: joy.y * 2.1 };
    else if (mouseWorld) { const lx = mouseWorld.x - local.x, ly = mouseWorld.y - local.y, l = Math.hypot(lx, ly) || 1; look = { x: lx / l * 2.1, y: ly / l * 2.1 }; }
    R.render(dt, t, { local, me: me(), target, look, coarse: coarse.matches });
    if (t - lastMini > 120) { R.drawMini({ local }); lastMini = t; }
    if ((hudDirty && t - lastHud > 150) || t - lastHud > 1000) { updateHud(); lastHud = t; hudDirty = false; }
  }
  requestAnimationFrame(frame);
})();