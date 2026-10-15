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
  });

  ws.on("close", () => {
    if (player) {
      players.delete(id);
      console.log(`- ${player.name} se odpojil (${players.size} hráčů)`);
    }
  });
});

// ---------- 3) Herní smyčka ----------
// Server je "šéf" – jen on rozhoduje, kde kdo je. Klienti mu
// posílají jen klávesy, takže nikdo nemůže podvádět s pozicí.
setInterval(() => {
  const dt = 1 / TICK_RATE;

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

  // pošli všem aktuální stav
  const state = JSON.stringify({
    type: "state",
    players: [...players.values()].map(({ input, ...rest }) => rest),
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
