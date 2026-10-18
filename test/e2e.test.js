// End-to-end test: runs the real server in-process and drives two real browsers through a whole match.
// Run with express/socket.io installed (npm install), or in an offline sandbox with NODE_PATH pointing at test/shim.
const assert = require("assert");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const srv = require("../server.js");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; let failures = 0;
async function step(name, fn) { try { await fn(); results.push("  ✓ " + name); } catch (e) { failures++; results.push("  ✗ " + name + "\n      " + String(e.message).split("\n")[0]); } }
async function until(fn, ms = 4000, label = "condition") { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error("timeout waiting for " + label); await sleep(50); } }

(async () => {
  await new Promise(r => srv.server.listen(0, r));
  const port = srv.server.address().port, base = "http://127.0.0.1:" + port;
  const browser = await chromium.launch();
  const errors = [];
  async function open(name, opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts }), page = await ctx.newPage();
    page.frames = []; page.on("websocket", ws => ws.on("framereceived", f => page.frames.push(String(f.payload))));
    page.on("pageerror", e => errors.push(name + " pageerror: " + e.message));
    page.on("console", m => { if (m.type() === "error" && !/favicon|mp3|Failed to load resource/.test(m.text())) errors.push(name + " console: " + m.text()); });
    return { ctx, page, name };
  }
  const A = await open("A"), B = await open("B");
  const room = () => [...srv.rooms.values()][0];
  const byName = n => [...room().players.values()].find(p => p.name === n);
  const teleport = async (p, x, y) => { p.x = x; p.y = y; p.ignoreMoveUntil = Date.now() + 100; };

  await step("landing page loads, name field accepts spaces", async () => {
    await A.page.goto(base); await A.page.fill("#playerName", "Alice Smith"); assert.equal(await A.page.inputValue("#playerName"), "Alice Smith");
    await A.page.keyboard.press("Space"); // typing a space in an input must not be swallowed by game keys
  });
  let code;
  await step("create room -> lobby", async () => {
    await A.page.click("#createBtn"); await A.page.waitForSelector("#lobby:not(.hidden)"); code = (await A.page.textContent("#shareCode")).trim(); assert.match(code, /^[0-9A-F]{6}$/);
  });
  await step("join via ?room= link prefills code, second player joins", async () => {
    await B.page.goto(base + "/?room=" + code); assert.equal(await B.page.inputValue("#roomCode"), code);
    await B.page.fill("#playerName", "Bob"); await B.page.click("#joinBtn"); await B.page.waitForSelector("#lobby:not(.hidden)");
    await until(async () => (await A.page.textContent("#playerCount")) === "2", 3000, "2 players");
  });
  await step("host dropdown keeps its selection across roster updates", async () => {
    await A.page.selectOption("#zombieMode", "chosen"); const bobId = byName("Bob").id; await A.page.selectOption("#zombiePlayer", bobId);
    const C = await open("C"); await C.page.goto(base + "/?room=" + code); await C.page.fill("#playerName", "Cy"); await C.page.click("#joinBtn");
    await until(async () => (await A.page.textContent("#playerCount")) === "3", 3000, "3 players");
    assert.equal(await A.page.inputValue("#zombiePlayer"), bobId); assert.equal(await A.page.inputValue("#zombieMode"), "chosen");
    await C.ctx.close(); await until(async () => (await A.page.textContent("#playerCount")) === "2", 3000, "player left");
  });
  await step("non-host cannot start; host starts match", async () => {
    assert.ok(await B.page.locator("#startBtn").evaluate(e => e.classList.contains("hidden")));
    await A.page.click("#startBtn"); await A.page.waitForSelector("#game:not(.hidden)"); await B.page.waitForSelector("#game:not(.hidden)");
    assert.equal(room().phase, "playing"); assert.ok(byName("Bob").zombie && !byName("Alice Smith").zombie);
  });
  await step("answers are never sent to clients (checked on the real WebSocket frames)", async () => {
    await sleep(400);
    const msgs = [...A.page.frames, ...B.page.frames].map(f => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
    assert.ok(msgs.length > 10, "no frames captured");
    for (const [ev, payload] of msgs) {
      if (ev === "me") { assert.ok(!("pp" in payload) && !("aux" in payload) && !("pronoun" in payload), "objective leaks answer fields"); }
      if (ev === "room") for (const p of payload.players) assert.ok(!p.crate || !("pp" in p.crate), "roster leaks pp");
    }
  });
  await step("canvas renders the world (not blank) and HUD shows English meaning", async () => {
    await sleep(600);
    const stats = await A.page.evaluate(() => { const c = document.getElementById("world"), g = c.getContext("2d"), d = g.getImageData(0, 0, c.width, c.height).data, set = new Set(); for (let i = 0; i < d.length; i += 4 * 97) set.add((d[i] >> 4) + "," + (d[i + 1] >> 4) + "," + (d[i + 2] >> 4)); return { colors: set.size, w: c.width }; });
    assert.ok(stats.colors > 12, "canvas looks blank: " + stats.colors + " colours");
    const verb = await A.page.textContent("#verb"), tgt = await A.page.textContent("#target"); assert.match(verb, /^to /); assert.match(tgt, /^English meaning: /);
    await A.page.screenshot({ path: "/tmp/shot_desktop.png" });
  });
  await step("movement: WASD moves the player, server validates the position", async () => {
    const p = byName("Alice Smith"); await teleport(p, 600, 1400); await sleep(300); const x0 = p.x;
    await A.page.keyboard.down("d"); await sleep(800); await A.page.keyboard.up("d"); await sleep(300);
    const dx = p.x - x0; assert.ok(dx > 90 && dx < 260, "moved " + dx.toFixed(0) + "px in 0.8s (expected ≈160)");
  });
  await step("server clamps teleport/speed-hack moves from a cheating client", async () => {
    const WS = require("ws"), mk = async () => { const ws = new WS(`ws://127.0.0.1:${port}/socket.io/`); ws.inbox = []; ws.on("message", m => ws.inbox.push(JSON.parse(m))); await new Promise(r => ws.on("open", r)); return ws; };
    const send = (ws, ...a) => ws.send(JSON.stringify(a)), find = (ws, ev) => ws.inbox.find(m => m[0] === ev);
    const h = await mk(), g = await mk(); send(h, "createRoom", { name: "Cheat" }); await until(() => find(h, "joined"), 2000, "joined");
    const hcode = find(h, "joined")[1].code; send(g, "joinRoom", { code: hcode, name: "Guest" }); await sleep(150); send(h, "startGame", {});
    const cr = srv.rooms.get(hcode); await until(() => cr.phase === "playing", 2000, "cheat room playing"); await sleep(400);
    const cp = [...cr.players.values()].find(p => p.name === "Guest"); cp.ignoreMoveUntil = 0; const x0 = cp.x, y0 = cp.y;
    send(g, "move", { x: x0 + 3000, y: y0 }); send(g, "move", { x: x0 - 99999, y: NaN }); send(g, "move", "garbage"); send(g, "answerQuiz"); send(g, "getFile", null); send(g, "submitComputer");
    await sleep(300); assert.ok(Math.hypot(cp.x - x0, cp.y - y0) < 140, "teleported " + Math.hypot(cp.x - x0, cp.y - y0).toFixed(0) + "px");
    for (let i = 0; i < 300; i++) send(g, "move", { x: cp.x + 1, y: cp.y }); await sleep(200); assert.ok(srv.rooms.has(hcode), "server survived malformed/flooded input");
    h.close(); g.close(); await until(() => !srv.rooms.has(hcode), 2000, "cheat room cleaned up");
  });
  const alice = () => byName("Alice Smith"), station = () => room().world.stations[0];
  await step("file station: modal opens with E, wrong answer rejected, correct answer grants file", async () => {
    const p = alice(); await teleport(p, station().x + 30, station().y + 30); await sleep(350); await A.page.keyboard.press("e");
    await A.page.waitForSelector("#modal:not(.hidden)"); assert.match(await A.page.textContent("#modalTitle"), /grammar file/i);
    const o = p.obj, wrongAux = o.aux === "ai" ? "as" : "ai";
    const sels = A.page.locator("#modalContent select"); await sels.nth(0).selectOption(o.pronoun === "je" ? "tu" : "je"); await sels.nth(1).selectOption(wrongAux);
    await A.page.click("text=Request file"); await sleep(250); assert.equal(o.file, false);
    await A.page.keyboard.press("e"); await A.page.waitForSelector("#modal:not(.hidden)");
    await A.page.locator("#modalContent select").nth(0).selectOption(o.pronoun); await A.page.locator("#modalContent select").nth(1).selectOption(o.aux);
    await A.page.click("text=Request file"); await until(() => o.file, 2000, "file granted");
    await until(async () => /✓ File/.test(await A.page.textContent("#progress")), 2000, "HUD progress");
  });
  await step("crate quiz: 4 distinct capitalised options, keyboard shortcut answers, password granted", async () => {
    const p = alice(), o = p.obj; await teleport(p, o.crate.x + 40, o.crate.y); await sleep(350); await A.page.keyboard.press("e");
    await A.page.waitForSelector("#modalContent .answers button");
    const labels = await A.page.$$eval("#modalContent .answers button", bs => bs.map(b => b.lastChild.textContent));
    assert.equal(labels.length, 4); assert.equal(new Set(labels.map(s => s.toLowerCase())).size, 4, "duplicate options: " + labels);
    assert.ok(labels.every(s => s[0] === s[0].toUpperCase()), "uncapitalised option (visual tell): " + labels);
    const idx = labels.findIndex(s => s.toLowerCase() === o.pp.toLowerCase()); assert.ok(idx >= 0, "correct answer missing: " + labels + " vs " + o.pp);
    await A.page.keyboard.press(String(idx + 1)); await until(() => o.password, 2000, "password granted");
    await until(async () => (await A.page.locator("#modal").getAttribute("class")).includes("hidden"), 2000, "modal closed");
  });
  await step("other player's crate triggers the slow trap (and not your own priority)", async () => {
    const p = alice(), bob = byName("Bob"); await teleport(p, bob.obj.crate.x + 30, bob.obj.crate.y); await sleep(350); await A.page.keyboard.press("e");
    await until(() => p.slowUntil > Date.now(), 2000, "slow applied"); p.slowUntil = 0;
  });
  await step("computer: submit scores a point and rolls a new objective", async () => {
    const p = alice(), o = p.obj, verb0 = o.verb.inf; await teleport(p, o.computer.x + 30, o.computer.y); await sleep(350); await A.page.keyboard.press("e");
    await A.page.waitForSelector("text=Submit both items"); await A.page.click("text=Submit both items"); await until(() => p.score === 1, 2000, "score");
    assert.notEqual(p.obj.verb.inf, verb0); assert.equal(p.obj.file, false);
    await until(async () => (await A.page.textContent("#score")) === "1", 2500, "HUD score");
  });
  await step("zombie is frozen for 5s, then a correct attack removes a life and closes its modal", async () => {
    const bob = byName("Bob"), a = alice(); a.shieldUntil = 0; await teleport(a, 1000, 1000); await teleport(bob, 1040, 1000); const lv = a.lives;
    await B.page.keyboard.press("e"); await sleep(300); assert.equal(await B.page.locator("#modal").evaluate(e => e.classList.contains("hidden")), true, "attack allowed during freeze");
    room().zombieFreezeUntil = 0; await sleep(300); await B.page.keyboard.press("e"); await B.page.waitForSelector("#modal:not(.hidden)");
    assert.match(await B.page.textContent("#modalDesc"), /participe passé of [A-ZÉÈÂÊÎÔÛÇ]+:/); assert.match(await B.page.textContent("#modalContent"), /Sentence: /);
    const q = bob.pendingAttack; assert.ok(q);
    // closing and re-opening must reuse the same question
    await B.page.keyboard.press("Escape"); await B.page.keyboard.press("e"); await B.page.waitForSelector("#modal:not(.hidden)"); assert.equal(bob.pendingAttack.crateId, q.crateId);
    const labels = await B.page.$$eval("#modalContent .answers button", bs => bs.map(b => b.lastChild.textContent)); const idx = labels.findIndex(s => s.toLowerCase() === q.correct.toLowerCase()); assert.ok(idx >= 0);
    await B.page.keyboard.press(String(idx + 1)); await until(() => a.lives === lv - 1, 2000, "life lost");
    await until(async () => (await B.page.locator("#modal").getAttribute("class")).includes("hidden"), 2000, "zombie modal closes after a hit");
  });
  await step("wrong zombie answer triggers a cooldown", async () => {
    const bob = byName("Bob"), a = alice(); a.shieldUntil = 0; bob.attackCooldownUntil = 0; await sleep(200);
    await B.page.keyboard.press("e"); await B.page.waitForSelector("#modal:not(.hidden)"); const q = bob.pendingAttack;
    const labels = await B.page.$$eval("#modalContent .answers button", bs => bs.map(b => b.lastChild.textContent)); const idx = labels.findIndex(s => s.toLowerCase() !== q.correct.toLowerCase());
    await B.page.keyboard.press(String(idx + 1)); await until(() => bob.attackCooldownUntil > Date.now(), 2000, "cooldown");
  });
  await step("shielded players can't be attacked; conversion awards +1 and ends when all are zombies", async () => {
    const bob = byName("Bob"), a = alice(); a.shieldUntil = 0; a.lives = 1; bob.attackCooldownUntil = 0; await sleep(200);
    await B.page.keyboard.press("e"); await B.page.waitForSelector("#modal:not(.hidden)"); const q = bob.pendingAttack;
    const labels = await B.page.$$eval("#modalContent .answers button", bs => bs.map(b => b.lastChild.textContent)); const idx = labels.findIndex(s => s.toLowerCase() === q.correct.toLowerCase());
    const s0 = bob.score; await B.page.keyboard.press(String(idx + 1));
    await until(() => room().phase === "ended", 3000, "game ended"); assert.equal(bob.score, s0 + 1);
    await A.page.waitForSelector("#modalTitle:has-text('EVERYONE IS A ZOMBIE')", { timeout: 3000 });
  });
  await step("host returns everyone to the lobby (modal closes for non-host too)", async () => {
    const hostPage = A, other = B; assert.equal(room().host, byName("Alice Smith").id);
    await hostPage.page.click("text=Back to lobby"); await other.page.waitForSelector("#lobby:not(.hidden)", { timeout: 3000 }); await hostPage.page.waitForSelector("#lobby:not(.hidden)", { timeout: 3000 });
    assert.ok(await other.page.locator("#modal").evaluate(e => e.classList.contains("hidden")), "game-over modal lingered in the lobby");
  });
  await step("second match: fresh world, new spawn points, start works again", async () => {
    const seed0 = room().world?.seed; await A.page.click("#startBtn");
    await until(() => room().phase === "playing", 3000, "restart"); assert.ok(room().world.seed !== seed0);
    await A.page.waitForSelector("#game:not(.hidden)"); await B.page.waitForSelector("#game:not(.hidden)"); await sleep(500);
  });
  await step("timer ends the match", async () => {
    room().endsAt = Date.now() + 300; await until(() => room().phase === "ended", 3000, "time over"); await A.page.waitForSelector("#modal:not(.hidden)", { timeout: 3000 });
  });
  await step("disconnect during a match ends it cleanly when fewer than 2 players remain", async () => {
    const hostPage = A; await hostPage.page.click("text=Back to lobby");
    await until(() => room().phase === "lobby", 3000, "lobby"); await A.page.click("#startBtn"); await until(() => room().phase === "playing", 3000, "playing");
    const other = B; await other.ctx.close(); await until(() => room() && room().phase === "ended", 3000, "ended after disconnect");
  });

  // mobile layout smoke test
  const M = await open("M", { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await step("mobile layout: joystick, interact button and minimap visible during a match", async () => {
    srv.rooms.clear(); await M.page.goto(base); await M.page.fill("#playerName", "Mia"); await M.page.click("#createBtn"); await M.page.waitForSelector("#lobby:not(.hidden)");
    const mcode = (await M.page.textContent("#shareCode")).trim(); const P = await open("P"); await P.page.goto(base + "/?room=" + mcode); await P.page.fill("#playerName", "Pat"); await P.page.click("#joinBtn");
    await until(async () => (await M.page.textContent("#playerCount")) === "2", 3000, "2 players"); await M.page.click("#startBtn"); await M.page.waitForSelector("#game:not(.hidden)"); await sleep(900);
    for (const sel of ["#joystick", "#interactBtn", "#minimap", "#world"]) assert.ok(await M.page.locator(sel).isVisible(), sel + " hidden");
    await M.page.screenshot({ path: "/tmp/shot_mobile.png" }); await P.ctx.close();
  });

  console.log("\nE2E results:\n" + results.join("\n")); 
  if (errors.length) { failures++; console.log("\n  ✗ browser errors:\n    " + [...new Set(errors)].join("\n    ")); } else console.log("\n  ✓ no browser console/page errors");
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  await browser.close(); process.exit(failures ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });