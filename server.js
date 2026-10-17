// =============================================================
//  SERVER – běží na jednom počítači (tzv. "host").
//  1) Posílá prohlížečům soubory hry ze složky /public
//  2) Přes WebSocket přijímá od hráčů stisknuté klávesy,
//     počítá, kde kdo stojí, a 30x za sekundu to posílá všem.
// =============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");

const PORT = 3000;
const TICK_RATE = 30; // kolikrát za sekundu se hra přepočítá
const SPEED = 90; // rychlost hráče (pixely za sekundu)

// Velikost mapy – musí sedět s public/game.js
const TILE = 16;
const MAP_W = 50; // v dlaždicích
const MAP_H = 35;

// ---------- 1) Obyčejný webový server pro soubory hry ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};

const httpServer = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(__dirname, "public", path.normalize(urlPath));

  // bezpečnost: nepustit nikoho mimo složku public
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403);
    return res.end();
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Nenalezeno");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------- 2) WebSocket server pro multiplayer ----------
const wss = new WebSocketServer({ server: httpServer });

const COLORS = ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#e67e22", "#1abc9c", "#ff6fae"];
let nextId = 1;
const players = new Map(); // id -> hráč

// Definice nepřátel (základní enemáci - slizouni s různými vlastnostmi)
const ENEMY_DEFS = [
  { type: "slime_green", name: "Zelený sliz", color: "#2ecc71", eyeColor: "#1b5e20", speed: 45, maxHp: 2, size: 10 },
  { type: "slime_red",   name: "Ohnivý sliz", color: "#e74c3c", eyeColor: "#7f1d1d", speed: 65, maxHp: 3, size: 11 },
  { type: "slime_purple",name: "Obří sliz",   color: "#9b59b6", eyeColor: "#4a148c", speed: 35, maxHp: 5, size: 14 },
];

let nextEnemyId = 1;
const enemies = [];

function spawnEnemy(defIndex) {
  const def = ENEMY_DEFS[defIndex % ENEMY_DEFS.length];
  return {
    id: nextEnemyId++,
    type: def.type,
    name: def.name,
    color: def.color,
    eyeColor: def.eyeColor,
    speed: def.speed,
    hp: def.maxHp,
    maxHp: def.maxHp,
    size: def.size,
    x: Math.random() * (MAP_W * TILE - 60) + 30,
    y: Math.random() * (MAP_H * TILE - 60) + 30,
    dir: "down",
    moving: true,
    wanderDir: { x: 0, y: 0 },
    wanderTimer: 0,
    hitUntil: 0,
    respawnTimer: 0,
  };
}

// Spustíme 6 základních enemáků na mapě
for (let i = 0; i < 6; i++) {
  enemies.push(spawnEnemy(i));
}

// ---------- Předměty na mapě (Loot) ----------
let nextItemId = 1;
const items = new Map(); // id -> { id, type, x, y }

function spawnItem(type, x, y) {
  const id = nextItemId++;
  items.set(id, {
    id,
    type, // "coin" (mince) nebo "heart" (srdíčko pro doplnění HP)
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
  });
}

function spawnRandomItem() {
  const type = Math.random() < 0.7 ? "coin" : "heart";
  const x = Math.random() * (MAP_W * TILE - 60) + 30;
  const y = Math.random() * (MAP_H * TILE - 60) + 30;
  spawnItem(type, x, y);
}

// Počáteční předměty na louce
for (let i = 0; i < 6; i++) {
  spawnRandomItem();
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws) => {
  const id = nextId++;
  let player = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Hráč se připojuje se jménem
    if (msg.type === "join" && !player) {
      const name = String(msg.name || "Hráč").trim().slice(0, 16) || "Hráč";
      player = {
        id,
        name,
        color: COLORS[(id - 1) % COLORS.length],
        x: (MAP_W * TILE) / 2 + (Math.random() - 0.5) * 100,
        y: (MAP_H * TILE) / 2 + (Math.random() - 0.5) * 100,
        dir: "down",
        moving: false,
        input: { up: false, down: false, left: false, right: false },
        hp: 3,
        maxHp: 3,
        score: 0,
        invulnerableUntil: 0,
        attackUntil: 0,
        lastAttack: 0,
      };
      players.set(id, player);
      send(ws, { type: "welcome", id });
      console.log(`+ ${name} se připojil (${players.size} hráčů)`);
    }

    // Hráč poslal, které klávesy drží
    if (msg.type === "input" && player) {
      player.input = {
        up: !!msg.up,
        down: !!msg.down,
        left: !!msg.left,
        right: !!msg.right,
      };
    }

    // Hráč zaútočil (klávesa Space nebo klik myší)
    if (msg.type === "attack" && player && player.hp > 0) {
      const now = Date.now();
      if (now - player.lastAttack > 300) {
        player.lastAttack = now;
        player.attackUntil = now + 180;

        // Dosah útoku před hráčem
        let ax = player.x;
        let ay = player.y;
        if (player.dir === "left") ax -= 18;
        if (player.dir === "right") ax += 18;
        if (player.dir === "up") ay -= 18;
        if (player.dir === "down") ay += 18;

        for (const e of enemies) {
          if (e.hp <= 0) continue;
          const dist = Math.hypot(e.x - ax, e.y - ay);
          if (dist < 22) {
            e.hp -= 1;
            e.hitUntil = now + 200;

            // Odhození nepřítele (knockback)
            const angle = Math.atan2(e.y - player.y, e.x - player.x);
            e.x += Math.cos(angle) * 22;
            e.y += Math.sin(angle) * 22;
            e.x = Math.max(10, Math.min(MAP_W * TILE - 10, e.x));
            e.y = Math.max(10, Math.min(MAP_H * TILE - 10, e.y));

            if (e.hp <= 0) {
              player.score = (player.score || 0) + 1;
              e.respawnTimer = 4; // oživí se za 4 vteřiny

              // Šance na vypadnutí lootu z poraženého nepřítele
              if (Math.random() < 0.7) {
                const dropType = Math.random() < 0.65 ? "coin" : "heart";
                spawnItem(dropType, e.x, e.y);
              }
            }
          }
        }
      }
    }
  });

  ws.on("close", () => {
    if (player) {
      players.delete(id);
      console.log(`- ${player.name} se odpojil (${players.size} hráčů)`);
    }
  });
});

// ---------- 3) Herní smyčka ----------
// Server je "šéf" – jen on rozhoduje, kde kdo je a co dělají nepřátelé.
let itemSpawnTimer = 0;

setInterval(() => {
  const dt = 1 / TICK_RATE;
  const now = Date.now();

  // 3a) Pohyb hráčů
  for (const p of players.values()) {
    let dx = 0, dy = 0;
    if (p.input.left) dx -= 1;
    if (p.input.right) dx += 1;
    if (p.input.up) dy -= 1;
    if (p.input.down) dy += 1;

    // aby šikmý pohyb nebyl rychlejší
    if (dx && dy) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }

    p.x += dx * SPEED * dt;
    p.y += dy * SPEED * dt;

    // nepustit hráče z mapy
    p.x = Math.max(8, Math.min(MAP_W * TILE - 8, p.x));
    p.y = Math.max(8, Math.min(MAP_H * TILE - 2, p.y));

    p.moving = dx !== 0 || dy !== 0;
    if (dx < 0) p.dir = "left";
    else if (dx > 0) p.dir = "right";
    else if (dy < 0) p.dir = "up";
    else if (dy > 0) p.dir = "down";
  }

  // 3b) AI nepřátel a kolize
  for (const e of enemies) {
    if (e.hp <= 0) {
      e.respawnTimer -= dt;
      if (e.respawnTimer <= 0) {
        // Respawn na náhodném místě
        e.hp = e.maxHp;
        e.x = Math.random() * (MAP_W * TILE - 60) + 30;
        e.y = Math.random() * (MAP_H * TILE - 60) + 30;
      }
      continue;
    }

    // Najdi nejbližšího živého hráče
    let nearest = null;
    let minDist = Infinity;
    for (const p of players.values()) {
      if (p.hp <= 0) continue;
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (d < minDist) {
        minDist = d;
        nearest = p;
      }
    }

    let edx = 0, edy = 0;
    const CHASE_RADIUS = 160;

    if (nearest && minDist < CHASE_RADIUS) {
      // Pronásledování hráče
      const angle = Math.atan2(nearest.y - e.y, nearest.x - e.x);
      edx = Math.cos(angle);
      edy = Math.sin(angle);
    } else {
      // Náhodné bloumání po louce
      e.wanderTimer -= dt;
      if (e.wanderTimer <= 0) {
        if (Math.random() < 0.3) {
          e.wanderDir = { x: 0, y: 0 };
        } else {
          const angle = Math.random() * Math.PI * 2;
          e.wanderDir = { x: Math.cos(angle), y: Math.sin(angle) };
        }
        e.wanderTimer = 1.5 + Math.random() * 2;
      }
      edx = e.wanderDir.x;
      edy = e.wanderDir.y;
    }

    e.x += edx * e.speed * dt;
    e.y += edy * e.speed * dt;

    e.x = Math.max(10, Math.min(MAP_W * TILE - 10, e.x));
    e.y = Math.max(10, Math.min(MAP_H * TILE - 10, e.y));

    e.moving = edx !== 0 || edy !== 0;
    if (Math.abs(edx) > Math.abs(edy)) {
      e.dir = edx > 0 ? "right" : "left";
    } else if (edy !== 0) {
      e.dir = edy > 0 ? "down" : "up";
    }

    // Kolize s hráči
    for (const p of players.values()) {
      if (p.hp <= 0) continue;
      const dist = Math.hypot(p.x - e.x, p.y - e.y);
      const hitRadius = (e.size || 10) + 6;

      if (dist < hitRadius && now > p.invulnerableUntil) {
        p.hp -= 1;
        p.invulnerableUntil = now + 1200; // 1.2s imunita proti další ráně

        // Odhození hráče od nepřítele
        const angle = Math.atan2(p.y - e.y, p.x - e.x);
        p.x += Math.cos(angle) * 25;
        p.y += Math.sin(angle) * 25;
        p.x = Math.max(8, Math.min(MAP_W * TILE - 8, p.x));
        p.y = Math.max(8, Math.min(MAP_H * TILE - 2, p.y));

        if (p.hp <= 0) {
          // Hráč byl zasažen a ztratil všechny životy -> respawn
          p.hp = p.maxHp;
          p.x = (MAP_W * TILE) / 2 + (Math.random() - 0.5) * 50;
          p.y = (MAP_H * TILE) / 2 + (Math.random() - 0.5) * 50;
          p.invulnerableUntil = now + 2000;
        }
      }
    }
  }

  // 3c) Sbírání předmětů (lootu) hráči a obnova na mapě
  for (const p of players.values()) {
    if (p.hp <= 0) continue;
    for (const [itemId, item] of items.entries()) {
      const dist = Math.hypot(p.x - item.x, p.y - item.y);
      if (dist < 14) {
        if (item.type === "coin") {
          p.score = (p.score || 0) + 1;
          items.delete(itemId);
        } else if (item.type === "heart") {
          if (p.hp < p.maxHp) {
            p.hp = Math.min(p.maxHp, p.hp + 1);
            items.delete(itemId);
          }
        }
      }
    }
  }

  // Průběžné doplňování předmětů na mapě
  itemSpawnTimer += dt;
  if (itemSpawnTimer > 6 && items.size < 8) {
    itemSpawnTimer = 0;
    spawnRandomItem();
  }

  // 3d) Pošli všem aktuální stav
  const state = JSON.stringify({
    type: "state",
    players: [...players.values()].map(({ input, ...rest }) => ({
      ...rest,
      invulnerable: now < rest.invulnerableUntil,
      attacking: now < rest.attackUntil,
    })),
    enemies: enemies.filter((e) => e.hp > 0).map((e) => ({
      id: e.id,
      type: e.type,
      name: e.name,
      color: e.color,
      eyeColor: e.eyeColor,
      size: e.size,
      x: Math.round(e.x * 10) / 10,
      y: Math.round(e.y * 10) / 10,
      dir: e.dir,
      hp: e.hp,
      maxHp: e.maxHp,
      hit: now < e.hitUntil,
    })),
    items: [...items.values()].map((it) => ({
      id: it.id,
      type: it.type,
      x: it.x,
      y: it.y,
    })),
  });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(state);
  }
}, 1000 / TICK_RATE);

// ---------- Start ----------
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("\n  Server hry běží!\n");
  console.log(`  Na tomhle počítači:   http://localhost:${PORT}`);
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === "IPv4" && !i.internal) {
        console.log(`  Ostatní na stejné WiFi: http://${i.address}:${PORT}`);
      }
    }
  }
  console.log("\n  (ukončit: Ctrl + C)\n");
});
