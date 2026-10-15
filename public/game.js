// =============================================================
//  KLIENT – běží v prohlížeči každého hráče.
//  Posílá serveru klávesy a kreslí to, co mu server pošle.
// =============================================================

const TILE = 16;
const MAP_W = 50; // musí sedět se server.js
const MAP_H = 35;

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const hud = document.getElementById("hud");

let scale = 3; // jak moc zvětšit pixely
let myId = null;
let connected = false;
const players = new Map(); // id -> { ...data ze serveru, rx, ry (pozice pro kreslení) }

// ---------- Připojení k serveru ----------
// Připojíme se na stejnou adresu, ze které se stránka načetla.
const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);

ws.onopen = () => (connected = true);
ws.onclose = () => {
  connected = false;
  hud.textContent = "Odpojeno od serveru – obnov stránku (F5)";
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);

  if (msg.type === "welcome") {
    myId = msg.id;
  }

  if (msg.type === "state") {
    const seen = new Set();
    for (const p of msg.players) {
      seen.add(p.id);
      const old = players.get(p.id);
      // rx/ry = kde hráče kreslíme; plynule se posouvá za skutečnou pozicí
      players.set(p.id, { ...p, rx: old ? old.rx : p.x, ry: old ? old.ry : p.y });
    }
    for (const id of players.keys()) if (!seen.has(id)) players.delete(id);
  }
};

function send(msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------- Přihlášení ----------
const joinScreen = document.getElementById("join");
const nameInput = document.getElementById("nameInput");
nameInput.value = localStorage.getItem("jmeno") || "";

document.getElementById("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim() || "Hráč";
  try { localStorage.setItem("jmeno", name); } catch {}
  const join = () => send({ type: "join", name });
  ws.readyState === WebSocket.OPEN ? join() : ws.addEventListener("open", join);
  joinScreen.style.display = "none";
});

// ---------- Ovládání ----------
const KEYS = {
  ArrowUp: "up", KeyW: "up",
  ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left",
  ArrowRight: "right", KeyD: "right",
};
const input = { up: false, down: false, left: false, right: false };

function setKey(code, pressed) {
  const k = KEYS[code];
  if (!k || myId === null) return false;
  if (input[k] !== pressed) {
    input[k] = pressed;
    send({ type: "input", ...input }); // posíláme jen když se něco změní
  }
  return true;
}
addEventListener("keydown", (e) => { if (setKey(e.code, true)) e.preventDefault(); });
addEventListener("keyup", (e) => setKey(e.code, false));
addEventListener("blur", () => { for (const code in KEYS) setKey(code, false); });

// ---------- Mapa ----------
// Náhodné, ale pro všechny stejné – "náhoda" se počítá z pozice dlaždice.
function hash(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const mapCanvas = document.createElement("canvas");
mapCanvas.width = MAP_W * TILE;
mapCanvas.height = MAP_H * TILE;
(function drawMap() {
  const m = mapCanvas.getContext("2d");
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const px = tx * TILE, py = ty * TILE;
      m.fillStyle = (tx + ty) % 2 ? "#5fa83f" : "#5aa23b";
      m.fillRect(px, py, TILE, TILE);

      // stébla trávy
      for (let i = 0; i < 4; i++) {
        const r = hash(tx * 7 + i, ty * 13 + i);
        m.fillStyle = "#4b8f30";
        m.fillRect(px + Math.floor(r * 15), py + Math.floor(hash(tx + i * 31, ty) * 14), 1, 2);
      }

      const r = hash(tx, ty);
      if (r < 0.05) {
        // kytička
        const colors = ["#fff", "#f7d33c", "#e74c3c"];
        m.fillStyle = colors[Math.floor(hash(ty, tx) * 3)];
        m.fillRect(px + 7, py + 6, 1, 1); m.fillRect(px + 6, py + 7, 1, 1);
        m.fillRect(px + 8, py + 7, 1, 1); m.fillRect(px + 7, py + 8, 1, 1);
        m.fillStyle = "#f39c12";
        m.fillRect(px + 7, py + 7, 1, 1);
      } else if (r < 0.07) {
        // kamínek
        m.fillStyle = "#8a8a8a"; m.fillRect(px + 5, py + 9, 4, 3);
        m.fillStyle = "#b0b0b0"; m.fillRect(px + 6, py + 9, 2, 1);
      }
    }
  }
})();

// ---------- Postavička (pixel art) ----------
// H = vlasy, S = kůže, E = oči, C = tričko (barva hráče), P = kalhoty, B = boty
const HEADS = {
  down:  ["..HHHHHH..", ".HHHHHHHH.", ".HSSSSSSH.", ".SSESSESS.", ".SSSSSSSS.", "..SSSSSS.."],
  up:    ["..HHHHHH..", ".HHHHHHHH.", ".HHHHHHHH.", ".HHHHHHHH.", ".SHHHHHHS.", "..SSSSSS.."],
  right: ["..HHHHHH..", ".HHHHHHHH.", ".HHHSSSSS.", ".HHSSSSES.", ".SSSSSSSS.", "..SSSSSS.."],
};
HEADS.left = HEADS.right.map((row) => [...row].reverse().join(""));
const BODY = [".CCCCCCCC.", "CCCCCCCCCC", "SCCCCCCCCS", "SCCCCCCCCS", ".PPPPPPPP."];
const LEGS = [
  [".PPP..PPP.", ".PP....PP.", ".BB....BB."], // stojí
  [".PPP..PPP.", ".BB....PP.", ".......BB."], // krok 1
  [".PPP..PPP.", ".PP....BB.", ".BB......."], // krok 2
];

const spriteCache = new Map();
function getSprite(color, dir, legs) {
  const key = color + dir + legs;
  if (spriteCache.has(key)) return spriteCache.get(key);

  const rows = [...HEADS[dir], ...BODY, ...LEGS[legs]];
  const pal = { H: "#4a2c17", S: "#f2c79a", E: "#111", C: color, P: "#2c3e70", B: "#222" };
  const c = document.createElement("canvas");
  c.width = 10;
  c.height = rows.length;
  const g = c.getContext("2d");
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (pal[ch]) { g.fillStyle = pal[ch]; g.fillRect(x, y, 1, 1); }
    });
  });
  spriteCache.set(key, c);
  return c;
}

// ---------- Kreslení ----------
function resize() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  scale = Math.max(2, Math.round(Math.min(innerWidth, innerHeight) / 220));
}
addEventListener("resize", resize);
resize();

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  // plynulý pohyb mezi aktualizacemi ze serveru
  for (const p of players.values()) {
    const t = Math.min(1, dt * 15);
    p.rx += (p.x - p.rx) * t;
    p.ry += (p.y - p.ry) * t;
  }

  // kamera sleduje mě
  const me = players.get(myId);
  const viewW = canvas.width / scale, viewH = canvas.height / scale;
  const camX = Math.round((me ? me.rx : (MAP_W * TILE) / 2) - viewW / 2);
  const camY = Math.round((me ? me.ry : (MAP_H * TILE) / 2) - viewH / 2);

  // pozadí = voda
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#2f6fa8";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // svět (zvětšený)
  ctx.setTransform(scale, 0, 0, scale, -camX * scale, -camY * scale);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#e3c983"; // písek kolem mapy
  ctx.fillRect(-4, -4, MAP_W * TILE + 8, MAP_H * TILE + 8);
  ctx.drawImage(mapCanvas, 0, 0);

  // hráči – seřazení podle y, aby ten níž byl "před" tím výš
  const list = [...players.values()].sort((a, b) => a.ry - b.ry);
  const walk = [1, 0, 2, 0][Math.floor(now / 120) % 4];

  for (const p of list) {
    const x = Math.round(p.rx), y = Math.round(p.ry);
    ctx.fillStyle = "rgba(0,0,0,0.25)"; // stín
    ctx.fillRect(x - 4, y - 1, 8, 2);
    ctx.fillRect(x - 5, y, 10, 1);
    ctx.drawImage(getSprite(p.color, p.dir, p.moving ? walk : 0), x - 5, y - 14);
  }

  // jména (v normálním rozlišení, aby byl text ostrý)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = "bold 13px monospace";
  ctx.textAlign = "center";
  ctx.lineWidth = 3;
  for (const p of list) {
    const sx = (Math.round(p.rx) - camX) * scale;
    const sy = (Math.round(p.ry) - camY - 16) * scale;
    ctx.strokeStyle = "#000";
    ctx.strokeText(p.name, sx, sy);
    ctx.fillStyle = p.id === myId ? "#ffeb3b" : "#fff";
    ctx.fillText(p.name, sx, sy);
  }

  // HUD
  if (connected) {
    hud.textContent = `Hráči online: ${players.size}\n` + list.map((p) => "• " + p.name).join("\n");
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
