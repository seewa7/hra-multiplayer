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
let difficultyLevel = 1; // úroveň obtížnosti ze serveru
let soloMode = false; // hraju sám (omezený počet oživení)
let soloRespawns = 1; // kolik oživení má hráč, který hraje sám
let gameOver = null; // po konci hry { remainingMs, survivedMs, results }
let adamState = null; // boss Adam ze serveru (nebo null)
let adamIn = null; // za kolik sekund se boss objeví (null = už je tu / byl poražen)
let adamAttackId = 0;
let adamAttackT0 = 0;
const bossFx = new Map(); // id -> efekt bosse (projektily, varování, zóny)
const players = new Map(); // id -> { ...data ze serveru, rx, ry (pozice pro kreslení) }
const enemies = new Map(); // id -> { ...data ze serveru, rx, ry }
const items = new Map(); // id -> { id, type, x, y }

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
    if (msg.level) difficultyLevel = msg.level;
    soloMode = !!msg.solo;
    soloRespawns = msg.soloRespawns || 1;
    gameOver = msg.gameOver || null;

    // Boss Adam a jeho efekty (server posílá jen to, co se má nakreslit)
    adamState = msg.adam || null;
    adamIn = msg.adamIn ?? null;
    if (adamState && adamState.attack && adamState.attack.id !== adamAttackId) {
      adamAttackId = adamState.attack.id;
      adamAttackT0 = performance.now() - adamState.attack.elapsed; // lokální čas začátku útoku
    }
    const seenFx = new Set();
    for (const f of msg.bossFx || []) {
      seenFx.add(f.id);
      const old = bossFx.get(f.id);
      bossFx.set(f.id, { ...f, t0: old ? old.t0 : performance.now() - f.age, rx: old ? old.rx : f.x, ry: old ? old.ry : f.y });
    }
    for (const id of bossFx.keys()) if (!seenFx.has(id)) bossFx.delete(id);

    // Aktualizace hráčů
    const seenPlayers = new Set();
    for (const p of msg.players) {
      seenPlayers.add(p.id);
      const old = players.get(p.id);
      // animT0 = lokální čas, kdy akce začala (server posílá jen "kolik ms už uběhlo",
      // takže se nemusí řešit rozdíl hodin mezi počítači)
      const animT0 = p.animId ? (old && old.animId === p.animId ? old.animT0 : performance.now() - p.animElapsed) : 0;
      // rx/ry = kde hráče kreslíme; plynule se posouvá za skutečnou pozicí
      players.set(p.id, { ...p, animT0, rx: old ? old.rx : p.x, ry: old ? old.ry : p.y });
    }
    for (const id of players.keys()) if (!seenPlayers.has(id)) players.delete(id);

    // Aktualizace nepřátel
    if (msg.enemies) {
      const seenEnemies = new Set();
      for (const en of msg.enemies) {
        seenEnemies.add(en.id);
        const old = enemies.get(en.id);
        enemies.set(en.id, { ...en, rx: old ? old.rx : en.x, ry: old ? old.ry : en.y });
      }
      for (const id of enemies.keys()) if (!seenEnemies.has(id)) enemies.delete(id);
    }

    // Aktualizace předmětů (loot)
    if (msg.items) {
      const seenItems = new Set();
      for (const it of msg.items) {
        seenItems.add(it.id);
        items.set(it.id, it);
      }
      for (const id of items.keys()) if (!seenItems.has(id)) items.delete(id);
    }
  }
};

function send(msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------- Přihlášení ----------
const joinScreen = document.getElementById("join");
const nameInput = document.getElementById("nameInput");
nameInput.value = localStorage.getItem("jmeno") || "";
{
  const saved = localStorage.getItem("trida");
  const radio = saved && document.querySelector(`input[name="cls"][value="${saved}"]`);
  if (radio) radio.checked = true;
}

document.getElementById("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim() || "Hráč";
  try { localStorage.setItem("jmeno", name); } catch {}
  const cls = document.querySelector('input[name="cls"]:checked').value;
  try { localStorage.setItem("trida", cls); } catch {}
  const join = () => send({ type: "join", name, cls });
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
// Schopnosti třídy: klávesa -> slot (server rozhodne, jestli a co se stane)
const ABILITY_KEYS = { KeyQ: "q", KeyE: "e" };

addEventListener("keydown", (e) => {
  // výběr buffu klávesami 1 / 2 / 3
  const pick = /^(Digit|Numpad)([1-3])$/.exec(e.code);
  const meNow = players.get(myId);
  if (pick && meNow && meNow.offer) {
    const id = meNow.offer[Number(pick[2]) - 1];
    if (id) send({ type: "pickBuff", id });
    e.preventDefault();
    return;
  }
  if (ABILITY_KEYS[e.code] && myId !== null) {
    if (!e.repeat) send({ type: "ability", slot: ABILITY_KEYS[e.code] });
    e.preventDefault();
    return;
  }
  if (e.code === "Space" && myId !== null) {
    send({ type: "attack" });
    e.preventDefault();
    return;
  }
  if (setKey(e.code, true)) e.preventDefault();
});
addEventListener("keyup", (e) => setKey(e.code, false));
addEventListener("blur", () => { for (const code in KEYS) setKey(code, false); });

// Kliknutím myši lze také zaútočit
canvas.addEventListener("mousedown", () => {
  if (myId !== null) send({ type: "attack" });
});

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

// ---------- Fotograf (spritesheety) ----------
// Atlasy vyrábí tools/build_photographer_atlas.py (kotva = střed chodidel je ve všech
// snímcích na stejném místě, takže postava při změně animace neposkočí).
const PHOTO_SCALE = 0.09; // kolik pixelů mapy odpovídá jednomu pixelu obrázku (jen měřítko)
const WALK_FRAME_MS = 100;
const DIR_ROW = { down: 0, left: 1, right: 2, up: 3 };
const photo = { ready: false, sheets: {} };

fetch("assets/photographer/atlas.json")
  .then((r) => r.json())
  .then((atlas) =>
    Promise.all(
      Object.entries(atlas.sheets).map(
        ([name, sh]) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              photo.sheets[name] = { ...sh, img };
              resolve();
            };
            img.onerror = reject;
            img.src = "assets/photographer/" + sh.file;
          })
      )
    )
  )
  .then(() => {
    photo.ready = true;
    drawThumb("thumb-photographer", () => photoFrame("walk", 0, "down"));
  })
  .catch((err) => console.warn("Sprity Fotografa se nenačetly, kreslí se základní postava:", err));

// Vrací { img, sx, sy, sw, sh, ax, ay } pro daný snímek
function photoFrame(sheetName, frame, dir) {
  const sh = photo.sheets[sheetName];
  return {
    img: sh.img,
    sx: frame * sh.cellW,
    sy: DIR_ROW[dir] * sh.cellH,
    sw: sh.cellW,
    sh: sh.cellH,
    ax: sh.anchorX,
    ay: sh.anchorY,
  };
}

// Který snímek se má teď ukázat (stav -> sheet + číslo snímku)
function photographerFrame(p, now) {
  const dir = p.animDir || p.dir;
  if (p.anim === "idle") return photoFrame("walk", 0, dir);
  if (p.anim === "walk") return photoFrame("walk", Math.floor(now / WALK_FRAME_MS) % 6, dir);

  // útok: snímek podle času od začátku akce (časování je ve shared/classes.js)
  const timing = CLASSES.photographer.abilities[p.anim].frames;
  let t = now - p.animT0;
  let frame = timing.length - 1;
  for (let i = 0; i < timing.length; i++) {
    if (t < timing[i]) { frame = i; break; }
    t -= timing[i];
  }
  return photoFrame(p.anim, frame, dir);
}

// Momentka zasahuje dokola (360°), ale záblesk ve spritu je jen ve směru pohledu –
// proto se ve chvíli zásahu kolem Fotografa na okamžik ukáže kruh dosahu.
function drawSnapshotRing(ctx, p, x, y, now) {
  if (p.anim !== "snapshot") return;
  const ab = CLASSES.photographer.abilities.snapshot;
  const total = ab.frames.reduce((a, b) => a + b, 0);
  const hitAt = ab.frames.slice(0, ab.hitFrame).reduce((a, b) => a + b, 0);
  const t = now - p.animT0;
  if (t < hitAt || t > total) return;
  const fade = 1 - (t - hitAt) / (total - hitAt); // po zásahu pomalu zmizí
  drawAttackSlash(ctx, x, y - 4, ab.range - 4, Math.max(0, fade));
}

function drawPhotographer(ctx, p, x, y, now) {
  const f = photographerFrame(p, now);
  ctx.drawImage(
    f.img, f.sx, f.sy, f.sw, f.sh,
    Math.round(x - f.ax * PHOTO_SCALE), Math.round(y - f.ay * PHOTO_SCALE),
    f.sw * PHOTO_SCALE, f.sh * PHOTO_SCALE
  );
}

// Náhledy tříd na přihlašovací obrazovce
function drawThumb(canvasId, getFrame) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, c.width, c.height);
  const f = getFrame();
  const k = Math.min((c.height - 6) / f.sh, 1) * (f.thumbScale || 1);
  const w = f.sw * k, h = f.sh * k;
  g.drawImage(f.img, f.sx, f.sy, f.sw, f.sh, c.width / 2 - f.ax * k, c.height - 4 - f.ay * k, w, h);
}

// ---------- Nepřátelé (Slizouni - pixel art) ----------
const SLIME_FRAMES = [
  // normální stav (10x8)
  [
    "..XXXXXX..",
    ".XWWXXXXX.",
    "XXXXXXXXXX",
    "XEEXXXEEXX",
    "XEEXXXEEXX",
    "XXXXXXXXXX",
    "XXXXXXXXXX",
    ".XXXXXXXX.",
  ],
  // poskočení / zmáčknutí (12x7)
  [
    "...XXXXXX...",
    "..XWWXXXXX..",
    ".XXXXXXXXXX.",
    "XXEEXXXEEXXX",
    "XXEEXXXEEXXX",
    "XXXXXXXXXXXX",
    ".XXXXXXXXXX.",
  ],
];

const slimeSpriteCache = new Map();
function getSlimeSprite(color, eyeColor, hit, frameIndex) {
  const key = `${color}_${eyeColor}_${hit}_${frameIndex}`;
  if (slimeSpriteCache.has(key)) return slimeSpriteCache.get(key);

  const rows = SLIME_FRAMES[frameIndex % SLIME_FRAMES.length];
  const c = document.createElement("canvas");
  c.width = rows[0].length;
  c.height = rows.length;
  const g = c.getContext("2d");

  const pal = {
    X: hit ? "#ffffff" : color,
    W: hit ? "#ffffff" : "rgba(255,255,255,0.75)",
    E: hit ? "#ff7777" : eyeColor,
  };

  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (pal[ch]) {
        g.fillStyle = pal[ch];
        g.fillRect(x, y, 1, 1);
      }
    });
  });

  slimeSpriteCache.set(key, c);
  return c;
}

// Úder hrdiny zasahuje dokola (360°), proto se kreslí kruhový záblesk kolem postavy
function drawAttackSlash(ctx, x, y, radius = CLASSES.hero.attack.range - 6, alpha = 1) {
  const r = radius;
  const cy = y - 6;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#ffeb3b";
  ctx.beginPath();
  ctx.ellipse(x, cy, r, r * 0.85, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(x, cy, r, r * 0.85, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ---------- Předměty na zemi (Loot - pixel art) ----------
function drawCoin(ctx, x, y, now) {
  const floatY = y + Math.sin(now / 180 + x) * 2;
  // stín mince
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(x - 3, y - 1, 6, 2);

  // zlatá mince
  ctx.fillStyle = "#d4af37";
  ctx.fillRect(x - 3, floatY - 6, 6, 6);
  ctx.fillStyle = "#f1c40f";
  ctx.fillRect(x - 2, floatY - 5, 4, 4);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x - 1, floatY - 4, 2, 2);
}

function drawGem(ctx, x, y, now, value) {
  // XP krystal: čím víc XP, tím větší
  const r = value >= 5 ? 5 : value >= 3 ? 4 : 3;
  const floatY = y + Math.sin(now / 220 + x) * 2;
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(x - r, y - 1, r * 2, 2);
  const cy = Math.round(floatY) - r - 2;
  // kosočtverec po řádcích
  for (let i = -r; i <= r; i++) {
    const w = r - Math.abs(i);
    ctx.fillStyle = "#1b7fd1";
    ctx.fillRect(x - w, cy + i, w * 2 + 1, 1);
    if (w > 0) {
      ctx.fillStyle = "#4cc9ff";
      ctx.fillRect(x - w + 1, cy + i, Math.max(1, w * 2 - 1), 1);
    }
  }
  ctx.fillStyle = "#e8fbff";
  ctx.fillRect(x - 1, cy - r + 2, 1, 1);
}

function drawHeart(ctx, x, y, now) {
  const floatY = y + Math.sin(now / 200 + x) * 2;
  // stín srdíčka
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(x - 4, y - 1, 8, 2);

  // červené srdíčko
  ctx.fillStyle = "#e74c3c";
  ctx.fillRect(x - 3, floatY - 6, 2, 2);
  ctx.fillRect(x + 1, floatY - 6, 2, 2);
  ctx.fillRect(x - 4, floatY - 4, 8, 2);
  ctx.fillRect(x - 3, floatY - 2, 6, 2);
  ctx.fillRect(x - 1, floatY, 2, 1);

  // odlesk
  ctx.fillStyle = "#ff7675";
  ctx.fillRect(x - 2, floatY - 5, 1, 1);
}

// ---------- Výběr buffu po postupu na další level ----------
const buffPicker = document.getElementById("buffPicker");
const buffCards = document.getElementById("buffCards");
const buffTitle = document.getElementById("buffTitle");
let shownOffer = ""; // aby se karty nepřekreslovaly každý snímek

function updateBuffPicker(me) {
  const offer = me && me.offer;
  if (!offer) {
    if (shownOffer) { buffPicker.classList.remove("show"); shownOffer = ""; }
    return;
  }
  const key = offer.join(",") + "|" + me.pendingPicks + "|" + me.level;
  if (key === shownOffer) return;
  shownOffer = key;

  buffTitle.textContent = `LEVEL ${me.level}!` + (me.pendingPicks > 1 ? `  (čeká ${me.pendingPicks} výběrů)` : "");
  buffCards.textContent = "";
  offer.forEach((id, i) => {
    const b = BUFFS.byId[id];
    const have = (me.buffs && me.buffs[id]) || 0;
    const btn = document.createElement("button");
    btn.type = "button";
    for (const [cls, text] of [
      ["icon", b.icon], ["name", b.name], ["desc", b.desc],
      ["have", have ? `máš ×${have} → ×${have + 1} (max ${b.max})` : `max ${b.max}`], ["key", `[${i + 1}]`],
    ]) {
      const el = document.createElement("div");
      el.className = cls;
      el.textContent = text;
      btn.appendChild(el);
    }
    btn.addEventListener("click", () => { send({ type: "pickBuff", id }); btn.blur(); });
    buffCards.appendChild(btn);
  });
  buffPicker.classList.add("show");
}

// ---------- Boss Adam: sprity, efekty a UI ----------
// Atlasy a kotvy vyrábí tools/build_adam_atlas.py (snímky v originálních sheetech přetékají přes hranice
// buněk, proto se neořezávají po mřížce). Kotva bosse = střed mezi chodidly (boss neposkakuje), kotva VFX = střed efektu.
const adamImgs = {};
let adamAtlas = null;
let adamLoaded = 0;
fetch("assets/adam/atlas.json")
  .then((r) => r.json())
  .then((atlas) => {
    adamAtlas = atlas.sheets;
    for (const [key, sh] of Object.entries(adamAtlas)) {
      const img = new Image();
      img.onload = () => adamLoaded++;
      img.onerror = () => console.warn("Sprite bosse se nenačetl:", sh.file);
      img.src = "assets/adam/" + sh.file;
      adamImgs[key] = img;
    }
  })
  .catch((err) => console.warn("Atlas bosse se nenačetl:", err));
function adam_ready() { return adamAtlas && adamLoaded === Object.keys(adamAtlas).length; }

const ATTACK_LABELS = { neural: "Neural Network", barbell: "Barbell Shockwave", overclock: "Overclock Cables" };

// Který snímek bosse se má teď ukázat (útok = podle času od začátku, jinak klidová póza podle fáze)
function adamPose(b, now) {
  if (b.defeated) return { sheet: "neural", frame: 0 };
  if (b.attack) {
    const cfg = ADAM.attacks[b.attack.type];
    let t = (now - adamAttackT0) / b.attack.speed; // čas v základních ms (útok ve fázi 3 běží rychleji)
    if (b.attack.type === "barbell") {
      t -= cfg.telegraphMs;
      if (t < 0) return { sheet: "barbell", frame: 0 }; // varovný kruh, boss zvedá činku
    }
    let frame = cfg.frames.length - 1;
    for (let i = 0; i < cfg.frames.length; i++) {
      if (t < cfg.frames[i]) { frame = i; break; }
      t -= cfg.frames[i];
    }
    return { sheet: b.attack.type, frame };
  }
  return { sheet: ["neural", "barbell", "overclock"][b.phase - 1], frame: 0 };
}

function drawAdam(ctx, b, now) {
  const pose = adamPose(b, now);
  const sh = adamAtlas[pose.sheet];
  const [ax, ay] = sh.anchors[pose.frame];
  const S = ADAM.scale.boss;
  const x = Math.round(b.x), y = Math.round(b.y);

  // lehké pohupování (boss se nehýbe z místa, jen "dýchá"); poražený stojí klidně
  const bob = b.defeated ? 0 : Math.sin((now / ADAM.bob.periodMs) * Math.PI * 2) * ADAM.bob.amplitude;
  const lift = Math.max(0, bob); // stín se při nadzvednutí trochu zmenší a zesvětlí

  // stín (dvě vrstvy: měkký okraj a tmavší střed)
  ctx.fillStyle = `rgba(0,0,0,${0.22 - lift * 0.04})`;
  ctx.beginPath();
  ctx.ellipse(x, y, 30 - lift, 9 - lift * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = `rgba(0,0,0,${0.3 - lift * 0.05})`;
  ctx.beginPath();
  ctx.ellipse(x, y, 22 - lift, 6 - lift * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();

  // poražený boss se pomalu ztrácí; při přechodu do další fáze bliká
  ctx.save();
  if (b.defeated) ctx.globalAlpha = Math.max(0.25, 1 - b.defeatedAgo / (ADAM.defeatedLingerMs * 1.2));
  const flash = b.hit || (b.blink && Math.floor(now / 90) % 2 === 0);
  if (flash) ctx.filter = "brightness(1.9)";
  ctx.drawImage(
    adamImgs[pose.sheet], pose.frame * sh.cellW, 0, sh.cellW, sh.cellH,
    Math.round(x - ax * S), Math.round(y - ay * S - bob), sh.cellW * S, sh.cellH * S
  );
  ctx.restore();

  // označený (Fotograf) boss má nad sebou žlutou šipku
  if (b.marked) {
    const by = y - 56 + Math.round(Math.sin(now / 120));
    ctx.fillStyle = "#000"; ctx.fillRect(x - 3, by - 1, 7, 1); ctx.fillRect(x - 2, by, 5, 1); ctx.fillRect(x - 1, by + 1, 3, 1); ctx.fillRect(x, by + 2, 1, 1);
    ctx.fillStyle = "#ffe14d"; ctx.fillRect(x - 2, by - 1, 5, 1); ctx.fillRect(x - 1, by, 3, 1); ctx.fillRect(x, by + 1, 1, 1);
  }
}

// Nakreslí snímek VFX se středem v (x, y), případně otočený (0 = doprava) a průhledný
function drawVfx(ctx, sheet, frame, x, y, scale, angle = 0, alpha = 1) {
  const img = adamImgs[sheet];
  const sh = adamAtlas[sheet];
  const [ax, ay] = sh.anchors[frame];
  const W = sh.cellW, H = sh.cellH;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(Math.round(x), Math.round(y));
  if (angle) ctx.rotate(angle);
  ctx.drawImage(img, frame * W, 0, W, H, -ax * scale, -ay * scale, W * scale, H * scale);
  ctx.restore();
}

// Zóna dohasíná: posledních 500 ms bliká
const zoneAlpha = (age, life, now) => (life - age < 500 ? (Math.floor(now / 70) % 2 ? 0.35 : 0.9) : 0.65 + 0.25 * Math.sin(now / 160));

function drawBossGroundFx(ctx, now) {
  if (!adam_ready()) return;
  const A = ADAM.attacks;
  for (const f of bossFx.values()) {
    const age = now - f.t0;
    if (f.kind === "shock") {
      // varovný kruh -> centrální náraz -> expandující prstenec -> rozpad (časy dostaneme ze serveru)
      const [impact, expandStart, expandEnd] = f.t;
      const frame = age < impact ? 0 : age < expandStart ? 1 : age < expandEnd ? 2 : 3;
      const alpha = frame === 0 ? 0.55 + 0.35 * Math.sin(age / 70) : 1;
      drawVfx(ctx, "vfxShock", frame, f.x, f.y, ADAM.scale.barbell, 0, alpha);
    } else if (f.kind === "oc_aim") {
      // varovný pruh na zemi ve směru výstřelu; těsně před výstřelem bliká rychleji
      const left = f.life - age;
      const on = left > 150 ? Math.floor(now / 110) % 2 === 0 : Math.floor(now / 50) % 2 === 0;
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.angle);
      const len = A.overclock.maxRange, w = A.overclock.lineWidth;
      ctx.fillStyle = on ? "rgba(255, 40, 60, 0.38)" : "rgba(0, 235, 255, 0.28)";
      ctx.fillRect(0, -w / 2, len, w);
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      for (let d = 0; d < len; d += 16) ctx.fillRect(d, -1, 8, 2); // čárkovaná osa
      ctx.restore();
    } else if (f.kind === "neural_mark") {
      // značka dopadu neuronového projektilu
      const r = A.neural.impactRadius + 5;
      ctx.save();
      ctx.strokeStyle = `rgba(60, 255, 190, ${0.55 + 0.35 * Math.sin(now / 60)})`;
      ctx.fillStyle = "rgba(60, 255, 190, 0.14)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    } else if (f.kind === "neural_zone" && age >= A.neural.impactMs) {
      drawVfx(ctx, "vfxNeural", 3, f.x, f.y, ADAM.scale.neural, 0, zoneAlpha(age, f.life, now));
    } else if (f.kind === "oc_zone" && age >= A.overclock.impactMs) {
      drawVfx(ctx, "vfxOverclock", 3, f.x, f.y, ADAM.scale.overclock, 0, zoneAlpha(age, f.life, now));
    }
  }
}

function drawBossAirFx(ctx, now) {
  if (!adam_ready()) return;
  const A = ADAM.attacks;
  for (const f of bossFx.values()) {
    const age = now - f.t0;
    // plynulý pohyb projektilů mezi zprávami ze serveru
    f.rx += (f.x - f.rx) * Math.min(1, 0.5);
    f.ry += (f.y - f.ry) * Math.min(1, 0.5);
    if (f.kind === "neural_proj") {
      drawVfx(ctx, "vfxNeural", age < A.neural.spawnMs ? 0 : 1, f.rx, f.ry, ADAM.scale.neural, age < A.neural.spawnMs ? 0 : f.angle);
    } else if (f.kind === "neural_impact") {
      drawVfx(ctx, "vfxNeural", 2, f.x, f.y, ADAM.scale.neural);
    } else if (f.kind === "oc_proj") {
      drawVfx(ctx, "vfxOverclock", age < A.overclock.spawnMs ? 0 : 1, f.rx, f.ry, ADAM.scale.overclock, f.angle);
    } else if (f.kind === "oc_impact") {
      drawVfx(ctx, "vfxOverclock", 2, f.x, f.y, ADAM.scale.overclock);
    }
  }
}

const bossBar = document.getElementById("bossBar");
const bossName = document.getElementById("bossName");
const bossSub = document.getElementById("bossSub");
const bossFill = document.getElementById("bossFill");
const bossHp = document.getElementById("bossHp");
const victoryBox = document.getElementById("victory");

function updateBossUi() {
  const b = adamState;
  if (!b) {
    bossBar.classList.remove("show");
    victoryBox.classList.remove("show");
    return;
  }
  bossBar.classList.add("show");
  bossName.textContent = b.name;
  bossFill.style.width = (b.maxHp ? (b.hp / b.maxHp) * 100 : 0) + "%";
  bossHp.textContent = `${Math.ceil(b.hp)} / ${Math.ceil(b.maxHp)}`;
  bossSub.textContent = b.defeated
    ? "Poražen"
    : b.phaseName + (b.attack ? `  ·  ${ATTACK_LABELS[b.attack.type]}` : b.blink ? "  ·  mění fázi…" : "");
  victoryBox.classList.toggle("show", b.defeated);
}

// ---------- Smrt a konec hry ----------
const deathBanner = document.getElementById("deathBanner");
const deathSub = document.getElementById("deathSub");
const deathHint = document.getElementById("deathHint");
const gameOverBox = document.getElementById("gameOver");
const goInfo = document.getElementById("goInfo");
const goTable = document.getElementById("goTable");
const goNext = document.getElementById("goNext");
let shownResults = ""; // aby se tabulka nepřekreslovala každý snímek

function formatTime(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function updateDeathUi(me) {
  // konec hry
  if (gameOver) {
    deathBanner.classList.remove("show");
    gameOverBox.classList.add("show");
    goNext.textContent = `Nová hra za ${Math.ceil(gameOver.remainingMs / 1000)} s…`;
    const key = JSON.stringify(gameOver.results) + gameOver.survivedMs;
    if (key !== shownResults) {
      shownResults = key;
      goInfo.textContent = `Přežili jste ${formatTime(gameOver.survivedMs)}`;
      goTable.textContent = "";
      const head = goTable.insertRow();
      for (const h of ["#", "Hráč", "Level", "Body"]) {
        const th = document.createElement("th");
        th.textContent = h;
        head.appendChild(th);
      }
      gameOver.results.forEach((r, i) => {
        const row = goTable.insertRow();
        for (const text of [i + 1, r.name, r.level, r.score]) row.insertCell().textContent = text;
      });
    }
    return;
  }
  gameOverBox.classList.remove("show");
  shownResults = "";

  // jsem mrtvý a čekám na oživení
  if (me && me.dead) {
    deathBanner.classList.add("show");
    if (me.respawnIn == null) {
      deathSub.textContent = "Už se neoživíš";
      deathHint.textContent = "Hra skončila";
    } else {
      deathSub.textContent = `Oživení za ${Math.ceil(me.respawnIn / 1000)} s`;
      deathHint.textContent = soloMode
        ? "Hraješ sám – tohle bylo tvoje jediné oživení, další smrt znamená konec hry"
        : "Hra skončí, jen když zemřete všichni naráz – drž spoluhráče naživu";
    }
  } else {
    deathBanner.classList.remove("show");
  }
}

// ---------- Lišta XP dole na obrazovce ----------
const xpBar = document.getElementById("xpBar");
const xpFill = document.getElementById("xpFill");
const xpTxt = document.getElementById("xpTxt");
const xpLvl = document.getElementById("xpLvl");
let shownXp = ""; // aby se DOM neměnil každý snímek
let shownLevel = 0;

function updateXpBar(me) {
  if (!me) { xpBar.classList.remove("show"); return; }
  xpBar.classList.add("show");
  const maxed = me.level >= BUFFS.MAX_LEVEL;
  const key = `${me.level}|${me.xp}|${me.xpNext}|${me.pendingPicks}`;
  if (key === shownXp) return;
  shownXp = key;

  xpLvl.textContent = `LVL ${me.level}`;
  xpFill.style.width = (maxed ? 100 : Math.min(100, (me.xp / me.xpNext) * 100)) + "%";
  xpTxt.textContent = maxed
    ? "MAX LEVEL"
    : `${me.xp} / ${me.xpNext} XP  ·  zbývá ${me.xpNext - me.xp}` + (me.pendingPicks > 0 ? "  ·  vyber si buff!" : "");

  if (shownLevel && me.level > shownLevel) {
    xpBar.classList.remove("levelup");
    void xpBar.offsetWidth; // restart animace
    xpBar.classList.add("levelup");
  }
  shownLevel = me.level;
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

  // plynulý pohyb hráčů
  for (const p of players.values()) {
    const t = Math.min(1, dt * 15);
    p.rx += (p.x - p.rx) * t;
    p.ry += (p.y - p.ry) * t;
  }

  // plynulý pohyb nepřátel
  for (const en of enemies.values()) {
    const t = Math.min(1, dt * 15);
    en.rx += (en.x - en.rx) * t;
    en.ry += (en.y - en.ry) * t;
  }

  // kamera sleduje mě
  const me = players.get(myId);
  // mrtvý hráč sleduje živého spoluhráče (když žádný není, zůstane kamera na něm)
  const camTarget = me && me.dead ? [...players.values()].find((p) => !p.dead) || me : me;
  const viewW = canvas.width / scale, viewH = canvas.height / scale;
  const camX = Math.round((camTarget ? camTarget.rx : (MAP_W * TILE) / 2) - viewW / 2);
  const camY = Math.round((camTarget ? camTarget.ry : (MAP_H * TILE) / 2) - viewH / 2);

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

  // Vykreslení entit – seřazení podle y (depth sorting)
  const renderables = [
    ...[...players.values()].filter((p) => !p.dead).map((p) => ({ type: "player", obj: p, y: p.ry })),
    ...[...enemies.values()].map((e) => ({ type: "enemy", obj: e, y: e.ry })),
    ...[...items.values()].map((it) => ({ type: "item", obj: it, y: it.y })),
    ...(adamState && adam_ready() ? [{ type: "adam", obj: adamState, y: adamState.y }] : []),
  ].sort((a, b) => a.y - b.y);

  const walk = [1, 0, 2, 0][Math.floor(now / 120) % 4];
  const slimeAnim = Math.floor(now / 180) % 2;

  drawBossGroundFx(ctx, now); // varování, prstenec a zóny na zemi (pod postavami)

  for (const item of renderables) {
    if (item.type === "adam") {
      drawAdam(ctx, item.obj, now);
    } else if (item.type === "player") {
      const p = item.obj;
      const x = Math.round(p.rx), y = Math.round(p.ry);

      // stín
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(x - 4, y - 1, 8, 2);
      ctx.fillRect(x - 5, y, 10, 1);

      // blikání při nesmrtelnosti po zásahu
      if (p.invulnerable && Math.floor(now / 100) % 2 === 0) {
        ctx.globalAlpha = 0.4;
      }
      if (p.cls === "photographer" && photo.ready) {
        drawPhotographer(ctx, p, x, y, now);
        drawSnapshotRing(ctx, p, x, y, now);
      } else {
        ctx.drawImage(getSprite(p.color, p.dir, p.moving ? walk : 0), x - 5, y - 14);
      }
      ctx.globalAlpha = 1.0;

      // buff Štít: modrý kruh kolem hráče, dokud je štít nabitý
      if (p.shield > 0) {
        ctx.strokeStyle = "rgba(120, 205, 255, 0.85)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(x, y - (p.cls === "photographer" ? 9 : 7), 10, p.cls === "photographer" ? 13 : 11, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // vizuální efekt útoku
      if (p.attacking && p.cls !== "photographer") {
        drawAttackSlash(ctx, x, y);
      }
    } else if (item.type === "enemy") {
      const en = item.obj;
      const ex = Math.round(en.rx), ey = Math.round(en.ry);
      const sprite = getSlimeSprite(en.color, en.eyeColor, en.hit, slimeAnim);
      const k = en.boss ? 2 : 1; // boss je dvakrát větší
      const sw = sprite.width * k;
      const sh = sprite.height * k;

      // stín slizu
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(ex - Math.floor(sw / 2), ey - 1, sw, 2);

      // tělo slizu
      ctx.drawImage(sprite, ex - Math.floor(sw / 2), ey - sh, sw, sh);

      // Fotograf: označený nepřítel má nad sebou žlutou šipku, omráčený kroužící hvězdičky
      if (en.marked) {
        const by = ey - sh - (en.hp < en.maxHp || en.boss ? 10 : 6) + Math.round(Math.sin(now / 120));
        ctx.fillStyle = "#000";
        ctx.fillRect(ex - 3, by - 1, 7, 1);
        ctx.fillRect(ex - 2, by, 5, 1);
        ctx.fillRect(ex - 1, by + 1, 3, 1);
        ctx.fillRect(ex, by + 2, 1, 1);
        ctx.fillStyle = "#ffe14d";
        ctx.fillRect(ex - 2, by - 1, 5, 1);
        ctx.fillRect(ex - 1, by, 3, 1);
        ctx.fillRect(ex, by + 1, 1, 1);
      }
      if (en.stunned) {
        ctx.fillStyle = "#fff";
        for (let i = 0; i < 3; i++) {
          const a = now / 150 + (i * Math.PI * 2) / 3;
          ctx.fillRect(Math.round(ex + Math.cos(a) * 6), Math.round(ey - sh - 2 + Math.sin(a) * 2), 1, 1);
        }
      }

      // malý ukazatel životů nepřítele (pokud je zraněný)
      if (en.hp < en.maxHp || en.boss) {
        const barW = en.boss ? 28 : 12;
        const barX = ex - barW / 2;
        const barY = ey - sh - 4;
        ctx.fillStyle = "#c0392b";
        ctx.fillRect(barX, barY, barW, 2);
        ctx.fillStyle = "#2ecc71";
        ctx.fillRect(barX, barY, Math.round(barW * (en.hp / en.maxHp)), 2);
      }
    } else if (item.type === "item") {
      const it = item.obj;
      // předmět, který brzy zmizí, bliká
      if (it.fading && Math.floor(now / 150) % 2 === 0) continue;
      if (it.type === "coin") {
        drawCoin(ctx, Math.round(it.x), Math.round(it.y), now);
      } else if (it.type === "xp") {
        drawGem(ctx, Math.round(it.x), Math.round(it.y), now, it.value || 1);
      } else if (it.type === "heart") {
        drawHeart(ctx, Math.round(it.x), Math.round(it.y), now);
      }
    }
  }

  drawBossAirFx(ctx, now); // letící projektily nad postavami

  // Texty a jména (v normálním rozlišení pro ostrý text)
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Jména hráčů
  ctx.font = "bold 13px monospace";
  ctx.textAlign = "center";
  ctx.lineWidth = 3;
  for (const p of players.values()) {
    if (p.dead) continue;
    const sx = (Math.round(p.rx) - camX) * scale;
    const sy = (Math.round(p.ry) - camY - (p.cls === "photographer" ? 24 : 16)) * scale;
    ctx.strokeStyle = "#000";
    ctx.strokeText(p.name, sx, sy);
    ctx.fillStyle = p.id === myId ? "#ffeb3b" : "#fff";
    ctx.fillText(p.name, sx, sy);
  }

  // Štítky nepřátel
  ctx.font = "bold 10px monospace";
  for (const en of enemies.values()) {
    if (!en.boss && enemies.size > 8) continue; // u hejna by jména jen zaplavila obrazovku
    const sx = (Math.round(en.rx) - camX) * scale;
    const sy = (Math.round(en.ry) - camY - (en.boss ? 11 + 16 : 11)) * scale;
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.strokeText(en.name, sx, sy);
    ctx.fillStyle = en.color;
    ctx.fillText(en.name, sx, sy);
  }

  // HUD
  if (connected) {
    let hudText = `Hráči online: ${players.size}  |  Enemáci na mapě: ${enemies.size}  |  Obtížnost: úroveň ${difficultyLevel}\n`;
    if (adamIn != null) hudText += `Boss Adam přijde za ${Math.floor(adamIn / 60)}:${String(adamIn % 60).padStart(2, "0")}\n`;
    const boss = [...enemies.values()].find((e) => e.boss);
    if (boss) hudText += `⚠ BOSS ${boss.name}: ${Math.ceil(boss.hp)}/${Math.ceil(boss.maxHp)} HP\n`;
    if (me) {
      const hearts = me.dead
        ? "💀 mrtvý"
        : "❤️".repeat(Math.max(0, me.hp || 0)) + "🖤".repeat(Math.max(0, (me.maxHp || 3) - (me.hp || 0)));
      hudText += `Životy: ${hearts}  |  Skóre: ${me.score || 0} ⚔️\n`;
      // oživení: sám jen omezeně, v týmu hra končí, až zemřou všichni
      hudText += soloMode
        ? `Oživení: ${Math.max(0, soloRespawns - (me.soloRespawnsUsed || 0))} z ${soloRespawns} (hraješ sám)\n`
        : `Tým: hra končí, až zemřete všichni naráz\n`;
      const owned = BUFFS.LIST.filter((b) => me.buffs && me.buffs[b.id]).map((b) => `${b.icon}×${me.buffs[b.id]}`);
      if (me.buffs && me.buffs.shield) owned.push(`(štít ${me.shield}/${me.buffs.shield})`);
      if (owned.length) hudText += `Buffy: ${owned.join("  ")}\n`;
      if (me.cls === "photographer") {
        const ab = CLASSES.photographer.abilities;
        const cd = (name) => (me.cd && me.cd[name] > 0 ? (me.cd[name] / 1000).toFixed(1) + " s" : "připraveno");
        hudText += `[WASD / Šipky] Pohyb   [Mezerník / Klik] ${ab.snapshot.label}\n`;
        hudText += `[Q] ${ab.strong_flash.label}: ${cd("strong_flash")}   [E] ${ab.perfect_shot.label}: ${cd("perfect_shot")}\n`;
        hudText += `🪙 Mince (+1 bod)  ❤️ Srdce (+1 HP)\n\n`;
      } else {
        hudText += `[WASD / Šipky] Pohyb   [Mezerník / Klik] Útok  |  🪙 Mince (+1 bod)  ❤️ Srdce (+1 HP)\n\n`;
      }
    }
    hudText += `Žebříček:\n`;
    hudText += [...players.values()]
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map((p) =>
        p.dead
          ? `• ${p.name} (LVL ${p.level || 1}): ${p.score || 0} bodů 💀 ${p.respawnIn == null ? "konec" : "oživení za " + Math.ceil(p.respawnIn / 1000) + " s"}`
          : `• ${p.name} (LVL ${p.level || 1}): ${p.score || 0} bodů (${p.hp || 0}/${p.maxHp || 3} HP)`
      )
      .join("\n");
    hud.textContent = hudText;
  }

  updateBuffPicker(me);
  updateXpBar(me);
  updateDeathUi(me);
  updateBossUi();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// náhled Hrdiny na přihlašovací obrazovce
drawThumb("thumb-hero", () => ({
  img: getSprite("#e74c3c", "down", 0), sx: 0, sy: 0, sw: 10, sh: 14, ax: 5, ay: 14, thumbScale: 3.4,
}));
