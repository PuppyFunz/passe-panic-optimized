"use strict";
/*
 * Passé Panic renderer.
 * The static world (ground, roads, lakes, decor, walls, stations, hub) never changes during a match, so it is
 * painted once into 512px chunk canvases (LRU-cached) and blitted each frame. Only dynamic things
 * (pickups, crates, players, arrows, prompts) are drawn per frame, and only if they are on screen.
 */
window.PPRender = (function () {
  const CH = 512, TILE = 60, MAX_CHUNKS = 40, CHUNK_BUDGET = 4, CENTER = 2000, RING_R = 1320;
  const GROUND = { north: ["#a6cdbb", "#9bc4b1"], west: ["#a8b890", "#9db086"], east: ["#7fb865", "#74ae5b"], south: ["#86d58f", "#7acb86"] };
  const WALL = {
    lab: { fill: "#aebec2", edge: "#667982" }, rock: { fill: "#8e9998", edge: "#596a68" },
    ruin: { fill: "#9ba698", edge: "#4a5d48" }, hedge: { fill: "#3f9a4c", edge: "#2a6c38" },
  };
  const TAU = Math.PI * 2;

  function hash(a, b) { let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function biomeAt(x, y) { const dx = x - CENTER, dy = y - CENTER; if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "west" : "east"; return dy < 0 ? "north" : "south"; }
  function rr(g, x, y, w, h, r, fill, stroke) { g.beginPath(); g.roundRect(x, y, w, h, r); if (fill) g.fill(); if (stroke) g.stroke(); }
  function ell(g, x, y, rx, ry) { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, TAU); g.fill(); }

  if (!CanvasRenderingContext2D.prototype.roundRect) { // older Safari / Chrome
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      r = Math.min(typeof r === "number" ? r : (r && r[0]) || 0, w / 2, h / 2);
      this.moveTo(x + r, y); this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r); this.closePath();
    };
  }

  function create(canvas, mini, S) {
    const ctx = canvas.getContext("2d"), mctx = mini.getContext("2d");
    const mqCoarse = matchMedia("(pointer: coarse)"), mqLand = matchMedia("(orientation: landscape)");
    const cam = { x: 0, y: 0, ready: false, zoom: 1 };
    const chunks = new Map(), buckets = new Map();
    let world = null, miniStatic = null, built = 0, size = { w: 960, h: 620, dpr: 1 }, sizeDirty = true;
    const avatar = new Image(); avatar.src = "/layne-avatar.webp";
    new ResizeObserver(() => { sizeDirty = true; }).observe(canvas);

    /* ---------------------------------------------------------------- decor generation (client-side, from the seed) */
    function decorBlocked(x, y, w) {
      const dc = Math.hypot(x - CENTER, y - CENTER);
      if (dc < 340 || Math.abs(dc - RING_R) < 65 || Math.abs(x - CENTER) < 70 || Math.abs(y - CENTER) < 70) return true;
      for (const k of w.walls) if (x > k.x - 45 && x < k.x + k.w + 45 && y > k.y - 45 && y < k.y + k.h + 45) return true;
      for (const l of w.lakes) { const a = (x - l.x) / l.rx, b = (y - l.y) / l.ry; if (a * a + b * b < 1.4) return true; }
      for (const s of w.stations) if (Math.hypot(x - s.x, y - s.y) < 90) return true;
      for (const r of w.relays) if (Math.hypot(x - r.x, y - r.y) < 100) return true;
      for (const z of w.ziplines) if (Math.hypot(x - z.x, y - z.y) < 90 || Math.hypot(x - z.endX, y - z.endY) < 90) return true;
      return false;
    }
    const DECOR_ODDS = { // cumulative thresholds per biome: [type, upToProbability]
      north: [["tree", .12], ["rock", .20], ["flower", .29], ["mushroom", .34], ["log", .39]], west: [["rock", .28], ["pine", .45], ["flower", .51], ["crystal", .56], ["log", .60]],
      east: [["pillar", .13], ["tree", .25], ["bush", .35], ["rock", .41], ["crystal", .47], ["mushroom", .52]], south: [["reed", .20], ["flower", .39], ["tree", .48], ["bush", .55], ["mushroom", .61], ["log", .66]],
    };
    function buildDecor(w) {
      const items = Array.isArray(w.decor) ? w.decor : (() => {
        const rng = mulberry32((w.seed ^ 0x9e3779b9) >>> 0), G = 120, generated = [];
        for (let gy = 40; gy < w.height - 40; gy += G) for (let gx = 40; gx < w.width - 40; gx += G) {
          const x = gx + rng() * G, y = gy + rng() * G, roll = rng(), v = rng(), sz = .8 + rng() * .5;
          const hit = DECOR_ODDS[biomeAt(x, y)].find(o => roll < o[1]);
          if (hit && !decorBlocked(x, y, w)) generated.push({ t: hit[0], x, y, s: sz, v });
        }
        return generated.sort((a, b) => a.y - b.y);
      })();
      for (const d of items) for (let cy = Math.floor((d.y - 80) / CH); cy <= Math.floor((d.y + 80) / CH); cy++) for (let cx = Math.floor((d.x - 80) / CH); cx <= Math.floor((d.x + 80) / CH); cx++) {
        const k = cy * 100 + cx; (buckets.get(k) || buckets.set(k, []).get(k)).push(d);
      }
    }

    /* ---------------------------------------------------------------- static painting */
    function paintDecor(g, d) {
      const { x, y, s, v } = d;
      g.save(); g.translate(x, y); g.scale(s, s);
      switch (d.t) {
        case "tree": g.fillStyle = "#4c8e4399"; ell(g, 4, 12, 24, 12); g.fillStyle = "#805a3d"; g.fillRect(-5, -2, 10, 24);
          g.fillStyle = v > .6 ? "#3d9a54" : "#55ad59"; g.beginPath(); g.arc(0, -10, 25, 0, TAU); g.arc(-14, 1, 17, 0, TAU); g.arc(14, 2, 17, 0, TAU); g.fill(); break;
        case "pine": g.fillStyle = "#00000022"; ell(g, 3, 20, 18, 7); g.fillStyle = "#6b4a30"; g.fillRect(-4, 8, 8, 14);
          g.fillStyle = "#2f7d4a"; for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(0, -34 + i * 14); g.lineTo(-22 + i * 2, -6 + i * 14); g.lineTo(22 - i * 2, -6 + i * 14); g.fill(); } break;
        case "rock": g.fillStyle = "#b9bfc3"; g.strokeStyle = "#808b91"; g.lineWidth = 3; g.beginPath(); g.ellipse(0, 0, 14, 10, .4, 0, TAU); g.fill(); g.stroke();
          g.fillStyle = "#d3d9dc"; g.beginPath(); g.ellipse(-3, -3, 6, 4, .4, 0, TAU); g.fill(); break;
        case "flower": for (let i = 0; i < 4; i++) { g.fillStyle = ["#ff8aa0", "#ffe27a", "#fff", "#b79bff"][(i + (v * 4 | 0)) & 3]; g.beginPath(); g.arc(-12 + i * 8, (i & 1) * 6 - 3, 4, 0, TAU); g.fill(); } break;
        case "reed": g.strokeStyle = "#437b4a"; g.lineWidth = 4; for (let i = 0; i < 5; i++) { g.beginPath(); g.moveTo(i * 9 - 18, 18); g.quadraticCurveTo(i * 9 - 28, -2, i * 9 - 20, -26); g.stroke(); } break;
        case "pillar": g.fillStyle = "#00000022"; ell(g, 4, 56, 30, 9); g.fillStyle = "#6f7b72"; g.fillRect(-14, -20, 28, v > .5 ? 74 : 46); g.fillStyle = "#b7c1b0"; g.fillRect(-20, -28, 40, 12);
          g.fillRect(-20, v > .5 ? 50 : 22, 40, 12); g.fillStyle = "#526d4b"; g.beginPath(); g.ellipse(0, -18, 22, 8, .2, 0, TAU); g.fill(); break;
        case "bush": g.fillStyle = "#00000022"; ell(g, 2, 12, 22, 7); g.fillStyle = v > .5 ? "#4aa05a" : "#3c8f4d"; g.beginPath(); g.arc(-10, 2, 13, 0, TAU); g.arc(8, 0, 15, 0, TAU); g.arc(0, -8, 13, 0, TAU); g.fill(); break;
        case "mushroom": g.fillStyle = "#f4ead5"; g.fillRect(-4, -2, 8, 14); g.fillStyle = v > .5 ? "#c75c67" : "#e2a34d"; g.beginPath(); g.arc(0, -3, 13, Math.PI, TAU); g.fill(); g.fillStyle = "#fff4db"; ell(g, -4, -7, 2, 2); ell(g, 5, -4, 2, 2); break;
        case "log": g.fillStyle = "#76533a"; g.save(); g.rotate(-.22 + v*.4); rr(g, -23, -7, 46, 14, 6, true, false); g.fillStyle = "#b58a5e"; g.beginPath(); g.ellipse(-21, 0, 4, 7, 0, 0, TAU); g.fill(); g.restore(); break;
        case "crystal": g.fillStyle = "#5bc8d8"; g.strokeStyle = "#d7fbff"; g.lineWidth = 2; g.beginPath(); g.moveTo(0,-24); g.lineTo(13,-5); g.lineTo(7,13); g.lineTo(-8,13); g.lineTo(-13,-5); g.closePath(); g.fill(); g.stroke(); g.fillStyle = "#e5ffff88"; g.beginPath(); g.moveTo(0,-24); g.lineTo(2,5); g.lineTo(-8,13); g.lineTo(-13,-5); g.closePath(); g.fill(); break;
      }
      g.restore();
    }
    function paintWall(g, w) {
      const c = WALL[w.kind] || WALL.rock;
      g.fillStyle = "#00000030"; rr(g, w.x + 4, w.y + 9, w.w, w.h, 12, true, false);
      g.fillStyle = c.fill; g.strokeStyle = c.edge; g.lineWidth = 5; rr(g, w.x, w.y, w.w, w.h, 12, true, true);
      g.save(); g.beginPath(); g.roundRect(w.x, w.y, w.w, w.h, 12); g.clip();
      if (w.kind === "lab") {
        g.fillStyle = "#6b8490"; g.fillRect(w.x + 14, w.y + 14, w.w - 28, w.h - 28); g.fillStyle = "#b9e3e8";
        for (let wy = w.y + 28; wy < w.y + w.h - 34; wy += 44) for (let wx = w.x + 28; wx < w.x + w.w - 34; wx += 42) g.fillRect(wx, wy, 18, 22);
      } else if (w.kind === "ruin") {
        g.strokeStyle = "#cfd6c6"; g.lineWidth = 2;
        for (let by = w.y + 30; by < w.y + w.h; by += 34) { g.beginPath(); g.moveTo(w.x, by); g.lineTo(w.x + w.w, by); g.stroke(); }
        for (let by = w.y; by < w.y + w.h; by += 34) for (let bx = w.x + 14 + ((by / 34 | 0) % 2) * 20; bx < w.x + w.w; bx += 42) { g.beginPath(); g.moveTo(bx, by); g.lineTo(bx, by + 34); g.stroke(); }
        g.fillStyle = "#526d4bcc"; for (let i = 0; i < w.w / 60; i++) ell(g, w.x + 20 + i * 55 + hash(w.x, i) * 20, w.y + 4, 26, 12);
      } else if (w.kind === "hedge") {
        g.fillStyle = "#58b862"; for (let hx = w.x + 10; hx < w.x + w.w; hx += 30) for (let hy = w.y + 10; hy < w.y + w.h; hy += 30) { g.beginPath(); g.arc(hx + hash(hx, hy) * 10, hy + hash(hy, hx) * 10, 15, 0, TAU); g.fill(); }
        g.fillStyle = "#ff8aa0"; for (let i = 0; i < w.w * w.h / 9000; i++) { g.beginPath(); g.arc(w.x + hash(w.x, i + 3) * w.w, w.y + hash(w.y, i + 9) * w.h, 3.5, 0, TAU); g.fill(); }
      } else { // rock
        g.fillStyle = "#a9b2a8"; g.beginPath(); g.moveTo(w.x + 14, w.y + w.h * .4); g.lineTo(w.x + w.w * .25, w.y + 14); g.lineTo(w.x + w.w * .75, w.y + 20); g.lineTo(w.x + w.w - 14, w.y + w.h * .5); g.lineTo(w.x + w.w * .5, w.y + w.h * .6); g.closePath(); g.fill();
        g.strokeStyle = "#6f7d7b"; g.lineWidth = 3; g.beginPath(); g.moveTo(w.x + w.w * .5, w.y + w.h * .6); g.lineTo(w.x + w.w * .55, w.y + w.h - 8); g.moveTo(w.x + w.w * .25, w.y + 14); g.lineTo(w.x + 12, w.y + w.h * .8); g.stroke();
      }
      g.restore();
    }
    function paintHubObjects(g) {
      const gs = world.guide;
      g.fillStyle = "#c9d0d6"; g.beginPath(); g.arc(gs.x, gs.y, 330, 0, TAU); g.fill();
      g.strokeStyle = "#a3aeb7"; g.lineWidth = 10; g.stroke(); g.lineWidth = 3; g.beginPath(); g.arc(gs.x, gs.y, 250, 0, TAU); g.stroke();
      g.save(); g.translate(gs.x, gs.y); g.fillStyle = "#354a68"; g.strokeStyle = "#d8f3ff"; g.lineWidth = 5; g.beginPath(); g.arc(0, 0, 34, 0, TAU); g.fill(); g.stroke();
      g.fillStyle = "#80e7ff"; g.beginPath(); g.arc(0, 0, 24, 0, TAU); g.fill(); g.fillStyle = "#17334d"; g.font = "bold 27px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("✦", 0, 1);
      g.fillStyle = "#fff"; g.strokeStyle = "#17334d"; g.lineWidth = 4; g.font = "bold 13px sans-serif"; g.strokeText("GUIDE", 0, 49); g.fillText("GUIDE", 0, 49); g.restore();
      for (const z of world.ziplines) {
        g.strokeStyle = "#4b4b55"; g.lineWidth = 7; g.beginPath(); g.moveTo(z.x, z.y); g.lineTo(z.endX, z.endY); g.stroke();
        for (const [x, y] of [[z.x, z.y], [z.endX, z.endY]]) { g.fillStyle = "#795a3a"; g.fillRect(x - 10, y - 22, 20, 44); g.fillStyle = "#e9d9a8"; g.fillRect(x - 15, y - 25, 30, 10); }
        g.fillStyle = "#fff3c4"; g.strokeStyle = "#3a3a44"; g.lineWidth = 4; g.font = "bold 15px sans-serif"; g.textAlign = "center";
        const tx = (z.x + z.endX) / 2 + (z.x === z.endX ? 70 : 0), ty = (z.y + z.endY) / 2 - (z.x === z.endX ? 0 : 24);
        g.strokeText("ZIPLINE · " + z.label, tx, ty); g.fillText("ZIPLINE · " + z.label, tx, ty);
      }
      for (const r of world.relays) {
        g.save(); g.translate(r.x, r.y); g.fillStyle = "#35465d"; g.strokeStyle = "#b7f4ff"; g.lineWidth = 5; rr(g, -27, -25, 54, 50, 9, true, true);
        g.fillStyle = "#56d8ec"; rr(g, -17, -15, 34, 30, 5, true, false); g.fillStyle = "#17364a"; g.font = "bold 18px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("⚡", 0, 1);
        g.fillStyle = "#fff"; g.strokeStyle = "#17364a"; g.lineWidth = 4; g.font = "bold 12px sans-serif"; g.strokeText(r.label, 0, 43); g.fillText(r.label, 0, 43); g.restore();
      }
      for (const st of world.stations) {
        g.fillStyle = "#2d9a5d"; g.strokeStyle = "#e2ffd0"; g.lineWidth = 4; rr(g, st.x - 26, st.y - 22, 52, 44, 10, true, true);
        g.fillStyle = "#fff3c4"; g.strokeStyle = "#b78b40"; rr(g, st.x - 14, st.y - 19, 28, 36, 4, true, true);
        g.fillStyle = "#d99d42"; g.fillRect(st.x - 8, st.y - 10, 16, 3); g.fillRect(st.x - 8, st.y - 2, 16, 3); g.fillRect(st.x - 8, st.y + 6, 12, 3);
        g.fillStyle = "#fff"; g.strokeStyle = "#1d5c3a"; g.lineWidth = 4; g.font = "bold 11px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.strokeText("FILES", st.x, st.y + 34); g.fillText("FILES", st.x, st.y + 34);
      }
    }
    function paintChunk(g, cx, cy) {
      const ox = cx * CH, oy = cy * CH, ex = Math.min(ox + CH, world.width), ey = Math.min(oy + CH, world.height);
      g.translate(-ox, -oy);
      for (let ty = Math.floor(oy / TILE); ty * TILE < ey; ty++) for (let tx = Math.floor(ox / TILE); tx * TILE < ex; tx++) {
        const jx = (hash(tx, ty) - .5) * 260, jy = (hash(ty, tx + 7) - .5) * 260;
        g.fillStyle = GROUND[biomeAt(tx * TILE + 30 + jx, ty * TILE + 30 + jy)][(tx + ty) & 1]; g.fillRect(tx * TILE, ty * TILE, TILE + 1, TILE + 1);
        if (hash(tx + 31, ty + 17) > .6) { g.fillStyle = "#0000001a"; ell(g, tx * TILE + 18, ty * TILE + 22, 3, 7); ell(g, tx * TILE + 25, ty * TILE + 26, 3, 6); }
      }
      g.lineCap = "butt"; // roads: axes + relay ring
      for (const [w, c] of [[84, "#cdb07b"], [56, "#dcc596"]]) {
        g.strokeStyle = c; g.lineWidth = w; g.beginPath(); g.moveTo(CENTER, 0); g.lineTo(CENTER, world.height); g.moveTo(0, CENTER); g.lineTo(world.width, CENTER); g.stroke();
        g.lineWidth = w * .78; g.beginPath(); g.arc(CENTER, CENTER, RING_R, 0, TAU); g.stroke();
      }
      // Elevated plateaus: layered cliff faces, top surface, edge highlights and visible ramps.
      for (const e of (world.elevations || [])) {
        if (e.x + e.w + 30 < ox || e.x > ex + 30 || e.y + e.h + 30 < oy || e.y > ey + 30) continue;
        g.fillStyle = "#263d2c55"; g.fillRect(e.x + 24, e.y + 28, e.w, e.h);
        g.fillStyle = e.level > 1 ? "#555d7c" : "#6d765e"; g.fillRect(e.x, e.y + 22 + (e.level || 1)*5, e.w, e.h);
        g.fillStyle = e.level > 1 ? "#a7a3d6" : "#a6c98a"; g.fillRect(e.x, e.y, e.w, e.h);
        g.strokeStyle = e.level > 1 ? "#f0e7ff" : "#e3efbd"; g.lineWidth = 12; g.strokeRect(e.x + 4, e.y + 4, e.w - 8, e.h - 8);
        g.strokeStyle = "#657d54"; g.lineWidth = 5; g.strokeRect(e.x + 14, e.y + 14, e.w - 28, e.h - 28);
        for (const r of (e.ramps || [])) {
          g.fillStyle = "#a58b63"; g.fillRect(r.x, r.y, r.w, r.h);
          g.strokeStyle = "#e1c58e"; g.lineWidth = 5; g.strokeRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6);
          g.strokeStyle = "#785e3f"; g.lineWidth = 3;
          for (let yy = r.y + 18; yy < r.y + r.h; yy += 24) { g.beginPath(); g.moveTo(r.x + 8, yy); g.lineTo(r.x + r.w - 8, yy); g.stroke(); }
          g.fillStyle = "#263d2c"; g.font = "bold 20px sans-serif"; g.textAlign = "center"; g.fillText("RAMP ↑", r.x + r.w/2, r.y + r.h/2);
        }
        g.fillStyle = "#334b2c"; g.font = "bold 28px sans-serif"; g.textAlign = "center"; g.fillText("HIGH GROUND", e.x + e.w/2, e.y + 52);
      }
      for (const l of world.lakes) {
        if (l.x + l.rx + 20 < ox || l.x - l.rx - 20 > ex || l.y + l.ry + 20 < oy || l.y - l.ry - 20 > ey) continue;
        g.fillStyle = "#e3f7ff"; ell(g, l.x, l.y, l.rx + 10, l.ry + 8); g.fillStyle = "#65b8d8"; ell(g, l.x, l.y, l.rx, l.ry);
        g.fillStyle = "#9ce2f4"; ell(g, l.x - l.rx * .22, l.y - l.ry * .25, l.rx * .45, l.ry * .28);
      }
      g.font = "bold 42px sans-serif"; g.textAlign = "center"; g.fillStyle = "#ffffff55";
      for (const [t, x, y] of [["RESEARCH GROUNDS", 2000, 330], ["ROCKY HIGHLANDS", 400, 2200], ["OVERGROWN RUINS", 3550, 2200], ["FLOODED GARDENS", 2000, 3750]]) g.fillText(t, x, y);
      const list = buckets.get(cy * 100 + cx); if (list) for (const d of list) paintDecor(g, d);
      for (const w of world.walls) if (w.x < ex + 20 && w.x + w.w > ox - 20 && w.y < ey + 20 && w.y + w.h > oy - 20) paintWall(g, w);
      paintHubObjects(g);
      g.strokeStyle = "#548c43"; g.lineWidth = 14; g.strokeRect(0, 0, world.width, world.height);
    }
    function getChunk(cx, cy) {
      const k = cy * 100 + cx; let c = chunks.get(k);
      if (c) { chunks.delete(k); chunks.set(k, c); return c; }
      if (built >= CHUNK_BUDGET) return null;
      built++; c = document.createElement("canvas"); c.width = c.height = CH; paintChunk(c.getContext("2d"), cx, cy); chunks.set(k, c);
      if (chunks.size > MAX_CHUNKS) chunks.delete(chunks.keys().next().value);
      return c;
    }

    /* ---------------------------------------------------------------- minimap */
    function buildMini(w) {
      const m = mini.width / w.width, c = document.createElement("canvas"); c.width = c.height = mini.width; const g = c.getContext("2d");
      for (let y = 0; y < w.height; y += 90) for (let x = 0; x < w.width; x += 90) { g.fillStyle = GROUND[biomeAt(x + 45, y + 45)][0]; g.fillRect(x * m, y * m, 90 * m + 1, 90 * m + 1); }
      g.strokeStyle = "#cdb07b"; g.lineWidth = 3; g.beginPath(); g.moveTo(CENTER * m, 0); g.lineTo(CENTER * m, c.height); g.moveTo(0, CENTER * m); g.lineTo(c.width, CENTER * m); g.stroke();
      g.beginPath(); g.arc(CENTER * m, CENTER * m, RING_R * m, 0, TAU); g.stroke();
      g.fillStyle = "#65b8d8"; for (const l of w.lakes) ell(g, l.x * m, l.y * m, l.rx * m, l.ry * m);
      for (const e of (w.elevations || [])) { g.fillStyle = "#c9d995"; g.fillRect(e.x*m,e.y*m,e.w*m,e.h*m); g.strokeStyle = "#556e48"; g.lineWidth = 1.5; g.strokeRect(e.x*m,e.y*m,e.w*m,e.h*m); for (const r of (e.ramps || [])) { g.fillStyle = "#b99a6b"; g.fillRect(r.x*m,r.y*m,r.w*m,r.h*m); } }
      for (const k of w.walls) { g.fillStyle = WALL[k.kind].edge; g.fillRect(k.x * m, k.y * m, Math.max(2, k.w * m), Math.max(2, k.h * m)); }
      g.fillStyle = "#2d9a5d"; for (const s of w.stations) g.fillRect(s.x * m - 2.5, s.y * m - 2.5, 5, 5);
      g.fillStyle = "#80e7ff"; g.beginPath(); g.arc(CENTER * m, CENTER * m, 4, 0, TAU); g.fill();
      miniStatic = c;
    }
    function drawMini(fr) {
      if (!world || !miniStatic || !fr.local) return;
      const m = mini.width / world.width; mctx.clearRect(0, 0, mini.width, mini.height); mctx.drawImage(miniStatic, 0, 0);
      for (const it of S.pickups) { mctx.fillStyle = it.type === "boost" ? "#ffd84d" : "#ff6b81"; mctx.beginPath(); mctx.arc(it.x * m, it.y * m, 3, 0, TAU); mctx.fill(); }
      if (S.guide) for (const [t, c] of [[S.guide.crate, "#f0b541"], [S.guide.computer, "#39b9ed"]]) { mctx.fillStyle = c; mctx.fillRect(t.x * m - 3, t.y * m - 3, 6, 6); }
      mctx.strokeStyle = "#fff8"; mctx.lineWidth = 1; mctx.strokeRect(cam.x * m, cam.y * m, (size.w / cam.zoom) * m, (size.h / cam.zoom) * m);
      mctx.fillStyle = "#fff"; mctx.strokeStyle = "#0b1524"; mctx.lineWidth = 2; mctx.beginPath(); mctx.arc(fr.local.x * m, fr.local.y * m, 4, 0, TAU); mctx.stroke(); mctx.fill();
    }

    /* ---------------------------------------------------------------- dynamic layer */
    function drawPickups(t, vx, vy, vw, vh) {
      S.pickups.forEach((it, i) => {
        if (it.x < vx - 60 || it.x > vx + vw + 60 || it.y < vy - 60 || it.y > vy + vh + 60) return;
        const bob = Math.sin(t / 280 + i * 1.7) * 4;
        ctx.save(); ctx.translate(it.x, it.y);
        ctx.fillStyle = it.type === "boost" ? "#ffe36e44" : "#ffffff55"; ctx.beginPath(); ctx.arc(0, 0, 30 + Math.sin(t / 300 + i) * 3, 0, TAU); ctx.fill();
        ctx.translate(0, bob);
        if (it.type === "boost") { ctx.fillStyle = "#ffd84d"; ctx.strokeStyle = "#b97820"; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(-14, -20); ctx.lineTo(4, -20); ctx.lineTo(-3, -3); ctx.lineTo(15, -3); ctx.lineTo(-10, 24); ctx.lineTo(-4, 5); ctx.lineTo(-18, 5); ctx.closePath(); ctx.fill(); ctx.stroke(); }
        else { ctx.fillStyle = "#fff6df"; ctx.strokeStyle = "#d85d68"; ctx.lineWidth = 4; rr(ctx, -15, -15, 30, 30, 5, true, true); ctx.fillStyle = "#e85d72"; ctx.fillRect(-3, -11, 6, 22); ctx.fillRect(-11, -3, 22, 6); }
        ctx.fillStyle = "#fff"; ctx.strokeStyle = "#0008"; ctx.lineWidth = 3; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center";
        const label = it.type === "boost" ? "SPEED" : "BANDAGE"; ctx.strokeText(label, 0, 40); ctx.fillText(label, 0, 40); ctx.restore();
      });
    }
    function drawCrates(vx, vy, vw, vh) {
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (const pl of S.players.values()) {
        const c = pl.crate; if (!c || c.x < vx - 80 || c.x > vx + vw + 80 || c.y < vy - 80 || c.y > vy + vh + 80) continue;
        ctx.fillStyle = "#b78342"; ctx.strokeStyle = "#704923"; ctx.lineWidth = 4; rr(ctx, c.x - 27, c.y - 22, 54, 44, 7, true, true);
        ctx.fillStyle = "#e3b968"; ctx.fillRect(c.x - 26, c.y - 5, 52, 8);
        ctx.fillStyle = c.done ? "#2d9a5d" : "#fff0b8"; ctx.font = "bold 22px sans-serif"; ctx.fillText(c.done ? "✓" : "🔑", c.x, c.y - 1);
        ctx.font = "bold 19px sans-serif"; ctx.lineWidth = 4; ctx.strokeStyle = "#fff7d8"; ctx.strokeText(c.verb, c.x, c.y + 42); ctx.fillStyle = "#26374b"; ctx.fillText(c.verb, c.x, c.y + 42);
        ctx.font = "bold 11px sans-serif"; ctx.strokeStyle = "#0009"; ctx.lineWidth = 3; ctx.fillStyle = "#fff"; const lab = pl.id === S.myId ? "YOUR CRATE" : pl.name + "’S CRATE";
        ctx.strokeText(lab, c.x, c.y - 34); ctx.fillText(lab, c.x, c.y - 34);
      }
      const pc = S.me && S.me.computer;
      if (pc) {
        ctx.fillStyle = "#526a82"; ctx.strokeStyle = "#344658"; ctx.lineWidth = 3; rr(ctx, pc.x - 27, pc.y - 22, 54, 43, 7, true, true);
        ctx.fillStyle = "#73d8ef"; rr(ctx, pc.x - 20, pc.y - 15, 40, 27, 4, true, false); ctx.fillStyle = "#f8ffff"; ctx.fillRect(pc.x - 11, pc.y + 22, 22, 4);
        ctx.fillStyle = "#344658"; ctx.font = "bold 10px sans-serif"; ctx.fillText("DIR", pc.x, pc.y + 1);
        ctx.fillStyle = "#fff"; ctx.strokeStyle = "#0009"; ctx.lineWidth = 3; ctx.font = "bold 11px sans-serif"; ctx.strokeText("YOUR COMPUTER", pc.x, pc.y + 38); ctx.fillText("YOUR COMPUTER", pc.x, pc.y + 38);
      }
    }
    function drawPlayer(pl, px, py, t, look) {
      const mine = pl.id === S.myId, boost = t < pl.boostUntil || t < pl.zBoostUntil, shield = t < pl.shieldUntil;
      const body = pl.zombie ? "#7b4b9e" : (/layne/i.test(pl.name) ? "#20b9a2" : (pl.avatar?.color || (mine ? "#20b9a2" : "#ff8a9e")));
      ctx.fillStyle = "#0003"; ctx.beginPath(); ctx.ellipse(px, py + 16, 17, 7, 0, 0, TAU); ctx.fill();
      if (shield) { ctx.beginPath(); ctx.arc(px, py, 27 + Math.sin(t / 150) * 1.5, 0, TAU); ctx.strokeStyle = "#79aaff"; ctx.lineWidth = 3; ctx.stroke(); }
      if (boost) { ctx.beginPath(); ctx.arc(px, py, 24, 0, TAU); ctx.strokeStyle = "#ffd66b"; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.fillStyle = body; ctx.beginPath(); ctx.arc(px, py, 18, 0, TAU); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.arc(px, py, 16, 0, TAU); ctx.clip();
      if (/layne/i.test(pl.name) && avatar.complete && avatar.naturalWidth) ctx.drawImage(avatar, px - 16, py - 16, 32, 32);
      else {
        ctx.fillStyle = body; ctx.fillRect(px - 16, py - 16, 32, 32); ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(px - 6, py - 4, 4, 0, TAU); ctx.arc(px + 6, py - 4, 4, 0, TAU); ctx.fill();
        ctx.fillStyle = "#172337"; ctx.beginPath(); ctx.arc(px - 5 + look.x, py - 4 + look.y, 1.7, 0, TAU); ctx.arc(px + 7 + look.x, py - 4 + look.y, 1.7, 0, TAU); ctx.fill();
        if (pl.avatar?.style === "shades") { ctx.fillStyle = "#182536"; ctx.fillRect(px-13,py-7,11,6); ctx.fillRect(px+2,py-7,11,6); ctx.fillRect(px-2,py-5,4,2); }
        else if (pl.avatar?.style === "cap") { ctx.fillStyle = "#26364d"; ctx.beginPath(); ctx.arc(px,py-11,13,Math.PI,TAU); ctx.fill(); ctx.fillRect(px-2,py-12,16,4); }
        else if (pl.avatar?.style === "bandana") { ctx.fillStyle = "#f4e2a2"; ctx.fillRect(px-16,py-10,32,5); ctx.beginPath(); ctx.moveTo(px+12,py-8); ctx.lineTo(px+21,py-3); ctx.lineTo(px+12,py-2); ctx.fill(); }
      }
      ctx.restore();
      // Wearables are intentionally drawn outside the body circle so silhouettes read clearly.
      const style = pl.avatar?.style, ac = pl.avatar?.accessoryColor || "#ffd166";
      ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = ac; ctx.fillStyle = ac;
      if (style === "halo") { ctx.lineWidth = 4; ctx.beginPath(); ctx.ellipse(px, py-25, 15, 5, -.12, 0, TAU); ctx.stroke(); }
      else if (style === "horns") { ctx.beginPath(); ctx.moveTo(px-12,py-12); ctx.lineTo(px-18,py-28); ctx.lineTo(px-3,py-18); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.moveTo(px+12,py-12); ctx.lineTo(px+18,py-28); ctx.lineTo(px+3,py-18); ctx.closePath(); ctx.fill(); }
      else if (style === "flower") { for(let i=0;i<5;i++){const a=Math.PI+i*Math.PI/4; const fx=px+Math.cos(a)*17, fy=py-9+Math.sin(a)*11; ctx.fillStyle=[ac,"#ff8a9e","#fff4da"][i%3]; ctx.beginPath(); ctx.arc(fx,fy,4.5,0,TAU); ctx.fill(); } }
      else if (style === "crown") { ctx.beginPath(); ctx.moveTo(px-14,py-15); ctx.lineTo(px-12,py-27); ctx.lineTo(px-4,py-20); ctx.lineTo(px,py-30); ctx.lineTo(px+5,py-20); ctx.lineTo(px+13,py-27); ctx.lineTo(px+15,py-15); ctx.closePath(); ctx.fill(); }
      else if (style === "antenna") { ctx.lineWidth=3; ctx.beginPath(); ctx.moveTo(px,py-16); ctx.lineTo(px+4,py-29); ctx.stroke(); ctx.beginPath(); ctx.arc(px+5,py-31,4,0,TAU); ctx.fill(); }
      else if (style === "scarf") { ctx.fillStyle=ac; ctx.beginPath(); ctx.arc(px,py+9,20,.18,Math.PI-.18); ctx.lineWidth=6; ctx.strokeStyle=ac; ctx.stroke(); ctx.beginPath(); ctx.moveTo(px+12,py+13); ctx.lineTo(px+22,py+22); ctx.lineTo(px+12,py+21); ctx.closePath(); ctx.fill(); }
      else if (style === "shades") { ctx.fillStyle=ac; ctx.fillRect(px-14,py-8,12,7); ctx.fillRect(px+2,py-8,12,7); ctx.fillRect(px-2,py-6,4,2); }
      else if (style === "cap") { ctx.fillStyle=ac; ctx.beginPath(); ctx.arc(px,py-11,13,Math.PI,TAU); ctx.fill(); ctx.fillRect(px-2,py-12,17,4); }
      else if (style === "bandana") { ctx.fillStyle=ac; ctx.fillRect(px-16,py-11,32,5); ctx.beginPath(); ctx.moveTo(px+12,py-8); ctx.lineTo(px+22,py-3); ctx.lineTo(px+12,py-2); ctx.fill(); }
      ctx.restore();
      ctx.strokeStyle = pl.zombie ? "#dcb5ff" : "#fff4da"; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(px, py, 18, 0, TAU); ctx.stroke();
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "bold 12px sans-serif"; ctx.fillStyle = "#172337"; ctx.fillText(pl.zombie ? "🧟" : pl.name[0].toUpperCase(), px, py + 10);
      const label = pl.zombie ? `${pl.name} · ZOMBIE` : pl.name; ctx.font = "bold 10px sans-serif";
      const tw = Math.max(64, ctx.measureText(label).width + 14); ctx.fillStyle = pl.zombie ? "#642b85" : "#304b34"; rr(ctx, px - tw / 2, py - 39, tw, 16, 6, true, false);
      ctx.fillStyle = "#fff"; ctx.fillText(label, px, py - 28);
      if (!pl.zombie) { ctx.fillStyle = "#fff"; rr(ctx, px - 17, py + 23, 34, 5, 2, true, false); ctx.fillStyle = "#e85d72"; ctx.fillRect(px - 17, py + 23, 34 * (pl.lives / 3), 5); }
    }
    const PROMPT = { guide: "Guidance", file: "Request file", crate: "Open crate", otherCrate: "Trap! Not yours", victim: "Attack!", pc: "Computer", pickup: "Collect", zipline: "Zipline", relay: "Speed relay" };
    function drawPrompt(target, pos, t, coarse) {
      if (!target) return;
      const pulse = 1 + Math.sin(t / 180) * .08, bad = target.kind === "otherCrate";
      ctx.strokeStyle = bad ? "#ff8aa0" : "#ffffff"; ctx.lineWidth = 3; ctx.setLineDash([8, 6]); ctx.beginPath(); ctx.arc(pos.x, pos.y, 46 * pulse, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      const txt = (coarse ? "TAP · " : "E · ") + PROMPT[target.kind]; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const w = ctx.measureText(txt).width + 18, y = pos.y - 72; ctx.fillStyle = bad ? "#8a2f48" : "#17304a"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; rr(ctx, pos.x - w / 2, y - 12, w, 24, 12, true, true);
      ctx.fillStyle = "#fff"; ctx.fillText(txt, pos.x, y);
    }
    function arrow(sx, sy, ang, label, color, w, h) {
      const R = Math.min(w, h) * .34, edge = 30, ax = Math.max(edge, Math.min(w - edge, sx + Math.cos(ang) * R)), ay = Math.max(edge, Math.min(h - edge, sy + Math.sin(ang) * R));
      ctx.save(); ctx.translate(ax, ay); ctx.rotate(ang); ctx.fillStyle = color; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(15, 0); ctx.lineTo(-9, -9); ctx.lineTo(-5, 0); ctx.lineTo(-9, 9); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
      ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.fillStyle = "#172337"; ctx.strokeText(label, ax, ay - 15); ctx.fillText(label, ax, ay - 15);
    }
    function drawArrows(fr, w, h) {
      const me = fr.me, sx = (fr.local.x - cam.x) * cam.zoom, sy = (fr.local.y - cam.y) * cam.zoom;
      const to = (tgt, label, color) => { if (Math.hypot(tgt.x - fr.local.x, tgt.y - fr.local.y) > 180) arrow(sx, sy, Math.atan2(tgt.y - fr.local.y, tgt.x - fr.local.x), label, color, w, h); };
      to(world.guide, "CENTRE GUIDE", "#64d7ff");
      if (me && me.zombie) {
        const near = []; for (const q of S.players.values()) if (!q.zombie && q.id !== S.myId) near.push({ q, d: Math.hypot(q.rx - fr.local.x, q.ry - fr.local.y) });
        near.sort((a, b) => a.d - b.d).slice(0, 3).forEach((e, i) => to({ x: e.q.rx, y: e.q.ry }, `${i + 1}. ${e.q.name}`, ["#e94b55", "#ff9f43", "#ffda55"][i]));
      } else if (S.guide) { to(S.guide.crate, "YOUR CRATE", "#f0b541"); to(S.guide.computer, "YOUR COMPUTER", "#39b9ed"); }
    }

    /* ---------------------------------------------------------------- frame */
    function render(dt, t, fr) {
      if (!world || !fr.local) return;
      if (sizeDirty) { size = { w: canvas.clientWidth || 960, h: canvas.clientHeight || 620, dpr: Math.min(devicePixelRatio || 1, 2) }; sizeDirty = false;
        canvas.width = Math.round(size.w * size.dpr); canvas.height = Math.round(size.h * size.dpr); }
      const w = size.w, h = size.h, zoom = mqCoarse.matches ? (mqLand.matches ? .62 : .72) : 1, vw = w / zoom, vh = h / zoom;
      cam.zoom = zoom; const tx = Math.max(0, Math.min(world.width - vw, fr.local.x - vw / 2)), ty = Math.max(0, Math.min(world.height - vh, fr.local.y - vh / 2));
      if (!cam.ready || Math.abs(tx - cam.x) > 400 || Math.abs(ty - cam.y) > 400) { cam.x = tx; cam.y = ty; cam.ready = true; }
      else { const k = 1 - Math.exp(-14 * dt); cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k; }
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0); ctx.fillStyle = "#86c96a"; ctx.fillRect(0, 0, w, h);
      ctx.save(); ctx.scale(zoom, zoom); ctx.translate(-cam.x, -cam.y); built = 0;
      for (let cy = Math.floor(cam.y / CH); cy <= Math.floor((cam.y + vh) / CH); cy++) for (let cx = Math.floor(cam.x / CH); cx <= Math.floor((cam.x + vw) / CH); cx++) {
        if (cx < 0 || cy < 0 || cx * CH >= world.width || cy * CH >= world.height) continue;
        const c = getChunk(cx, cy); if (c) ctx.drawImage(c, cx * CH, cy * CH, CH + 1, CH + 1);
      }
      drawPickups(t, cam.x, cam.y, vw, vh); drawCrates(cam.x, cam.y, vw, vh);
      const k = 1 - Math.exp(-14 * dt), vis = [];
      for (const pl of S.players.values()) {
        if (pl.rx === undefined) { pl.rx = pl.x; pl.ry = pl.y; }
        if (pl.id === S.myId) { pl.rx = fr.local.x; pl.ry = fr.local.y; }
        else { if (Math.abs(pl.x - pl.rx) > 500 || Math.abs(pl.y - pl.ry) > 500) { pl.rx = pl.x; pl.ry = pl.y; } pl.mvx = pl.x - pl.rx; pl.mvy = pl.y - pl.ry; pl.rx += pl.mvx * k; pl.ry += pl.mvy * k; }
        if (pl.rx > cam.x - 60 && pl.rx < cam.x + vw + 60 && pl.ry > cam.y - 80 && pl.ry < cam.y + vh + 60) vis.push(pl);
      }
      vis.sort((a, b) => a.ry - b.ry);
      for (const pl of vis) {
        let look = { x: 0, y: 0 };
        if (pl.id === S.myId) look = fr.look || look; else { const l = Math.hypot(pl.mvx, pl.mvy); if (l > 3) look = { x: pl.mvx / l * 2.1, y: pl.mvy / l * 2.1 }; }
        drawPlayer(pl, pl.rx, pl.ry, t, look);
      }
      if (fr.target) { const tp = fr.target.kind === "victim" ? { x: fr.target.item.rx, y: fr.target.item.ry } : fr.target.item; drawPrompt(fr.target, tp, t, fr.coarse); }
      ctx.restore();
      drawArrows(fr, w, h);
    }

    return {
      setWorld(w) { world = w; chunks.clear(); buckets.clear(); buildDecor(w); buildMini(w); cam.ready = false; },
      clear() { world = null; chunks.clear(); buckets.clear(); miniStatic = null; cam.ready = false; },
      render, drawMini, get zoom() { return cam.zoom; }, cam,
    };
  }
  return { create, biomeAt };
})();