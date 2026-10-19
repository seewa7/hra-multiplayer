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
const CLASSES = require("./public/shared/classes.js"); // sdílené s klientem
const BUFFS = require("./public/shared/buffs.js"); // buffy a XP, sdílené s klientem

const PORT = 3000;
const TICK_RATE = 30; // kolikrát za sekundu se hra přepočítá
const SPEED = 90; // rychlost hráče (pixely za sekundu)

// Velikost mapy – musí sedět s public/game.js
const TILE = 16;
const MAP_W = 50; // v dlaždicích
const MAP_H = 35;

// Předměty (loot)
const ITEM_PICKUP_RADIUS = 14; // jak blízko musí hráč být, aby předmět sebral
const ITEM_LIFETIME_MS = 30000; // po této době předmět zmizí
const ITEM_FADING_MS = 5000; // posledních pár vteřin předmět bliká
const ITEM_SPAWN_INTERVAL = 6; // jak často (s) se na mapě objeví nový předmět
const ITEM_SPAWN_LIMIT = 8; // náhodné doplňování se zastaví, když je na mapě tolik předmětů
const ITEM_HARD_LIMIT = 30; // absolutní strop (i s předměty z nepřátel), nejstarší zmizí
const ENEMY_DROP_CHANCE = 0.7; // šance, že poražený nepřítel upustí předmět
const COIN_CHANCE_DROP = 0.65; // z dropu je tolik procent mince, zbytek srdce
const COIN_CHANCE_RANDOM = 0.7; // totéž pro předměty náhodně na louce

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

// Obtížnost: hra začíná klidně a postupně se zhoršuje, dokud je ve hře aspoň jeden hráč
const DIFFICULTY = {
  levelSeconds: 45, // jak často (s) stoupne úroveň
  maxLevel: 10,
  startEnemies: 2, // počet nepřátel na začátku
  maxEnemies: 8, // počet nepřátel na nejvyšší úrovni
  enemiesPerLevel: 0.7, // o kolik nepřátel víc s každou úrovní
  speedPerLevel: 0.04, // nepřátelé jsou s každou úrovní o 4 % rychlejší
  chaseStart: 90, // dosah, ze kterého nepřítel hráče vidí, na 1. úrovni
  chaseEnd: 160, // totéž na nejvyšší úrovni
  redFromLevel: 3, // od které úrovně přibývají Ohniví slizi (rychlejší)
  purpleFromLevel: 5, // od které úrovně přibývají Obří slizi (odolnější)
  spawnSafeDistance: 120, // nepřítel se neobjeví blíž než tohle k hráči
  joinProtectionMs: 3000, // nový hráč je chvíli nezranitelný
};

// Smrt a konec hry
const DEATH = {
  respawnMs: 30000, // jak dlouho je mrtvý hráč mimo hru, než se oživí
  soloRespawns: 1, // kolikrát se může oživit hráč, který hraje sám
  gameOverMs: 10000, // jak dlouho se ukazuje konec hry, než začne nová
};

// Definice nepřátel (základní enemáci - slizouni s různými vlastnostmi)
const ENEMY_DEFS = [
  { type: "slime_green", name: "Zelený sliz", color: "#2ecc71", eyeColor: "#1b5e20", speed: 45, maxHp: 2, size: 10, xp: 2 },
  { type: "slime_red",   name: "Ohnivý sliz", color: "#e74c3c", eyeColor: "#7f1d1d", speed: 65, maxHp: 3, size: 11, xp: 3 },
  { type: "slime_purple",name: "Obří sliz",   color: "#9b59b6", eyeColor: "#4a148c", speed: 35, maxHp: 5, size: 14, xp: 6 },
];

let nextEnemyId = 1;
const enemies = [];

// Náhodné místo na mapě dost daleko od hráčů (a od středu, kde se noví hráči objevují)
function safeSpawnPosition() {
  const avoid = [{ x: (MAP_W * TILE) / 2, y: (MAP_H * TILE) / 2 }, ...players.values()];
  let x, y;
  for (let i = 0; i < 30; i++) {
    x = Math.random() * (MAP_W * TILE - 60) + 30;
    y = Math.random() * (MAP_H * TILE - 60) + 30;
    if (avoid.every((a) => Math.hypot(a.x - x, a.y - y) >= DIFFICULTY.spawnSafeDistance)) break;
  }
  return { x, y };
}

// Který typ slizu přibude na dané úrovni (na začátku jen zelení)
function enemyDefIndexForLevel(level, n) {
  const pool = [0]; // zelený
  if (level >= DIFFICULTY.redFromLevel) pool.push(1);
  if (level >= DIFFICULTY.purpleFromLevel) pool.push(2);
  return pool[n % pool.length];
}

function enemyCountForLevel(level) {
  return Math.min(DIFFICULTY.maxEnemies, DIFFICULTY.startEnemies + Math.floor((level - 1) * DIFFICULTY.enemiesPerLevel));
}

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
    xp: def.xp, // kolik XP upustí po smrti
    ...safeSpawnPosition(),
    dir: "down",
    moving: true,
    wanderDir: { x: 0, y: 0 },
    wanderTimer: 0,
    hitUntil: 0,
    respawnTimer: 0,
    markedUntil: 0, // Fotograf: označený nepřítel dostává víc poškození
    stunUntil: 0, // omráčený (oslepený) nepřítel se nehýbe a nekouše
    slowUntil: 0, // zpomalený nepřítel
  };
}

// Na začátku jen pár zelených slizů, další přibývají s úrovní obtížnosti
let level = 1;
let gameOver = null; // { until, survivedMs, results } po konci hry, jinak null
let runStart = Date.now(); // kdy začala tahle hra (pro čas přežití)
let difficultyTime = 0; // kolik sekund hry s aspoň jedním hráčem
for (let i = 0; i < DIFFICULTY.startEnemies; i++) {
  enemies.push(spawnEnemy(enemyDefIndexForLevel(1, i)));
}

// ---------- Předměty na mapě (Loot) ----------
let nextItemId = 1;
const items = new Map(); // id -> { id, type, x, y }

function spawnItem(type, x, y, value) {
  // strop na počet předmětů – když je plno, zmizí ten nejstarší
  while (items.size >= ITEM_HARD_LIMIT) {
    items.delete(items.keys().next().value);
  }
  const id = nextItemId++;
  items.set(id, {
    id,
    type, // "coin" (mince), "heart" (srdíčko pro doplnění HP) nebo "xp" (krystal s XP)
    value, // jen u "xp": kolik XP dá
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    expiresAt: Date.now() + ITEM_LIFETIME_MS,
  });
}

function spawnRandomItem() {
  const type = Math.random() < COIN_CHANCE_RANDOM ? "coin" : "heart";
  const x = Math.random() * (MAP_W * TILE - 60) + 30;
  const y = Math.random() * (MAP_H * TILE - 60) + 30;
  spawnItem(type, x, y);
}

// Počáteční předměty na louce
for (let i = 0; i < 6; i++) {
  spawnRandomItem();
}

// ---------- XP, levely a buffy hráče ----------
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Připraví hráči nabídku 3 buffů, pokud mu nějaký výběr čeká a žádnou nabídku ještě nemá
function nextOffer(p) {
  while (!p.offer && p.pendingPicks > 0) {
    const pool = BUFFS.LIST.filter((b) => (p.buffs[b.id] || 0) < b.max).map((b) => b.id);
    if (pool.length === 0) {
      // všechno je na maximu -> náhrada v bodech
      p.score = (p.score || 0) + 5 * p.pendingPicks;
      p.pendingPicks = 0;
      return;
    }
    p.offer = shuffle(pool).slice(0, 3);
  }
}

function addXp(p, amount) {
  if (!amount || p.level >= BUFFS.MAX_LEVEL) return;
  p.xp += amount;
  while (p.level < BUFFS.MAX_LEVEL && p.xp >= BUFFS.xpForNext(p.level)) {
    p.xp -= BUFFS.xpForNext(p.level);
    p.level++;
    p.pendingPicks++;
  }
  if (p.level >= BUFFS.MAX_LEVEL) p.xp = 0;
  nextOffer(p);
}

function applyBuff(p, id) {
  const def = BUFFS.byId[id];
  if (!def || (p.buffs[id] || 0) >= def.max) return false;
  p.buffs[id] = (p.buffs[id] || 0) + 1;
  if (id === "heart") {
    p.maxHp += 1;
    p.hp += 1;
  } else if (id === "shield") {
    p.shield += 1; // nový štít je hned nabitý
  } else if (id === "regen") {
    p.regenAt = Date.now() + BUFFS.regenIntervalMs(p.buffs.regen);
  }
  return true;
}

// Společné zranění nepřítele (hrdina i fotograf). Řeší označení, smrt, skóre a loot.
function hurtEnemy(e, dmg, player, now, knockback) {
  if (e.hp <= 0) return;
  dmg *= BUFFS.damageMult(player.buffs); // buff Větší síla
  if (now < e.markedUntil) dmg *= CLASSES.MARK_BONUS;
  e.hp -= dmg;
  e.hitUntil = now + 200;

  if (knockback) {
    // Odhození nepřítele (knockback)
    const angle = Math.atan2(e.y - player.y, e.x - player.x);
    e.x += Math.cos(angle) * 22;
    e.y += Math.sin(angle) * 22;
    e.x = Math.max(10, Math.min(MAP_W * TILE - 10, e.x));
    e.y = Math.max(10, Math.min(MAP_H * TILE - 10, e.y));
  }

  if (e.hp <= 1e-6) {
    e.hp = 0;
    player.score = (player.score || 0) + 1;
    e.respawnTimer = 4; // oživí se za 4 vteřiny

    // XP krystal vypadne z každého poraženého nepřítele
    spawnItem("xp", e.x, e.y, e.xp);

    // Šance na vypadnutí lootu z poraženého nepřítele
    if (Math.random() < ENEMY_DROP_CHANCE) {
      const dropType = Math.random() < COIN_CHANCE_DROP ? "coin" : "heart";
      spawnItem(dropType, e.x, e.y);
    }
  }
}

function markEnemy(e, now) {
  if (e.hp > 0) e.markedUntil = now + CLASSES.MARK_MS; // obnoví čas, bonus se nesčítá
}

// ---------- Schopnosti Fotografa ----------
const FACING = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] };
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

// Spustí schopnost (animaci). Zásah se projeví až ve správném snímku – viz resolveAction.
function startAbility(p, name, now) {
  const ab = CLASSES[p.cls] && CLASSES[p.cls].abilities[name];
  if (!ab || p.hp <= 0) return;
  if (p.action && now < p.action.endAt) return; // předchozí animace ještě běží
  if (now < p.cooldowns[name]) return; // cooldown

  p.cooldowns[name] = now + ab.cooldown * BUFFS.cooldownMult(p.buffs); // buff Rychlejší útoky
  p.action = {
    id: ++p.actionSeq,
    name,
    dir: p.dir, // směr animace se uzamkne po celou animaci
    roots: ab.roots !== false, // jestli postava během animace stojí (základní útok ne)
    start: now,
    hitAt: now + sum(ab.frames.slice(0, ab.hitFrame)),
    endAt: now + sum(ab.frames),
    resolved: false,
  };
}

// Vyhodnotí zásah schopnosti – volá se jednou, když animace dojde na "zásahový" snímek.
function resolveAction(p, now) {
  const a = p.action;
  const ab = CLASSES[p.cls].abilities[a.name];
  const [fx, fy] = FACING[a.dir];

  for (const e of enemies) {
    if (e.hp <= 0) continue;
    const vx = e.x - p.x;
    const vy = e.y - p.y;
    const dist = Math.hypot(vx, vy);
    const reach = (e.size || 10) / 2;

    if (a.name === "snapshot" || a.name === "strong_flash") {
      // kužel před postavou: dosah + úhel (minDot -1 = dokola, 360°)
      if (dist > ab.range + reach) continue;
      if (dist > 6 && (vx * fx + vy * fy) / dist < ab.minDot) continue;
    } else if (a.name === "perfect_shot") {
      // dlouhý úzký paprsek ve směru postavy
      const along = vx * fx + vy * fy;
      const across = Math.abs(vx * fy - vy * fx);
      if (along < -reach || along > ab.length + reach || across > ab.halfWidth + reach) continue;
    }

    hurtEnemy(e, ab.damage, p, now, false);
    if (a.name === "strong_flash") {
      e.stunUntil = Math.max(e.stunUntil, now + ab.stunMs);
      e.slowUntil = Math.max(e.slowUntil, now + ab.stunMs + ab.slowMs);
    } else {
      markEnemy(e, now); // Momentka i Perfektní záběr označují zasažené
    }
  }
}

// ---------- Smrt hráče, oživení a konec hry ----------
function killPlayer(p, now) {
  p.hp = 0;
  p.action = null;
  p.moving = false;
  p.input = { up: false, down: false, left: false, right: false };

  // Sám: jen omezený počet oživení. S ostatními se oživíš vždy (hra končí, až zemřou všichni).
  if (players.size === 1 && p.soloRespawnsUsed >= DEATH.soloRespawns) {
    p.respawnAt = Infinity;
  } else {
    if (players.size === 1) p.soloRespawnsUsed++;
    p.respawnAt = now + DEATH.respawnMs;
  }
  console.log(`  ☠ ${p.name} zemřel`);
  checkGameOver(now);
}

function respawnPlayer(p, now) {
  p.hp = p.maxHp;
  p.x = (MAP_W * TILE) / 2 + (Math.random() - 0.5) * 50;
  p.y = (MAP_H * TILE) / 2 + (Math.random() - 0.5) * 50;
  p.invulnerableUntil = now + DIFFICULTY.joinProtectionMs;
  p.respawnAt = 0;
  console.log(`  ✚ ${p.name} se oživil`);
}

// Hra končí, když jsou všichni hráči mrtví zároveň (sólo hráč jen když mu nezbývá oživení)
function checkGameOver(now) {
  if (gameOver || players.size === 0) return;
  const all = [...players.values()];
  if (!all.every((p) => p.hp <= 0)) return;
  if (all.length === 1 && Number.isFinite(all[0].respawnAt)) return; // sólo hráč se ještě oživí

  gameOver = {
    until: now + DEATH.gameOverMs,
    survivedMs: now - runStart,
    results: all
      .map((p) => ({ name: p.name, cls: p.cls, score: p.score || 0, level: p.level }))
      .sort((a, b) => b.score - a.score),
  };
  console.log(`  GAME OVER (přežili jste ${Math.round(gameOver.survivedMs / 1000)} s)`);
}

// Nová hra: všechno se vrátí na začátek (hráči zůstávají ve hře se jménem a třídou)
function resetRun(now) {
  level = 1;
  difficultyTime = 0;
  itemSpawnTimer = 0;
  runStart = now;
  gameOver = null;

  for (const p of players.values()) {
    Object.assign(p, {
      x: (MAP_W * TILE) / 2 + (Math.random() - 0.5) * 100,
      y: (MAP_H * TILE) / 2 + (Math.random() - 0.5) * 100,
      dir: "down",
      moving: false,
      hp: 3,
      maxHp: 3,
      score: 0,
      level: 1,
      xp: 0,
      buffs: {},
      shield: 0,
      shieldAt: 0,
      regenAt: 0,
      pendingPicks: 0,
      offer: null,
      invulnerableUntil: now + DIFFICULTY.joinProtectionMs,
      attackUntil: 0,
      lastAttack: 0,
      action: null,
      cooldowns: { snapshot: 0, strong_flash: 0, perfect_shot: 0 },
      respawnAt: 0,
      soloRespawnsUsed: 0,
    });
  }

  enemies.length = 0;
  for (let i = 0; i < DIFFICULTY.startEnemies; i++) {
    enemies.push(spawnEnemy(enemyDefIndexForLevel(1, i)));
  }
  items.clear();
  for (let i = 0; i < 6; i++) spawnRandomItem();
  console.log("  Nová hra!");
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
      const cls = msg.cls === "photographer" ? "photographer" : "hero"; // klient nesmí poslat nic jiného
      player = {
        id,
        name,
        cls,
        color: COLORS[(id - 1) % COLORS.length],
        x: (MAP_W * TILE) / 2 + (Math.random() - 0.5) * 100,
        y: (MAP_H * TILE) / 2 + (Math.random() - 0.5) * 100,
        dir: "down",
        moving: false,
        input: { up: false, down: false, left: false, right: false },
        hp: 3,
        maxHp: 3,
        score: 0,
        invulnerableUntil: Date.now() + DIFFICULTY.joinProtectionMs, // chvíli po vstupu nezranitelný
        attackUntil: 0,
        lastAttack: 0,
        level: 1,
        xp: 0,
        buffs: {}, // id buffu -> kolikrát vybrán
        shield: 0, // aktuálně nabité štíty
        shieldAt: 0, // kdy se dobije další štít
        regenAt: 0, // kdy přibude další život z Regenerace
        pendingPicks: 0, // kolik výběrů buffu na hráče čeká
        offer: null, // aktuální nabídka 3 buffů (nebo null)
        respawnAt: 0, // kdy se mrtvý hráč oživí (Infinity = nikdy, hra končí)
        soloRespawnsUsed: 0, // kolik oživení už využil, když hrál sám
        action: null, // běžící schopnost třídy (Fotograf)
        actionSeq: 0,
        cooldowns: { snapshot: 0, strong_flash: 0, perfect_shot: 0 },
      };
      if (players.size === 0) runStart = Date.now(); // hra se počítá od vstupu prvního hráče
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
      if (player.cls === "photographer") {
        startAbility(player, "snapshot", now); // základní útok Fotografa
      } else if (now - player.lastAttack > CLASSES.hero.attack.cooldown * BUFFS.cooldownMult(player.buffs)) {
        player.lastAttack = now;
        player.attackUntil = now + 180;

        // Základní útok zasáhne všechny nepřátele v kruhu kolem hráče (360°), směr nehraje roli
        const atk = CLASSES.hero.attack;
        for (const e of enemies) {
          if (e.hp <= 0) continue;
          const dist = Math.hypot(e.x - player.x, e.y - player.y);
          if (dist <= atk.range + (e.size || 10) / 2) hurtEnemy(e, atk.damage, player, now, atk.knockback);
        }
      }
    }

    // Hráč si vybral buff z nabídky po postupu na další level
    if (msg.type === "pickBuff" && player && player.offer && player.offer.includes(msg.id)) {
      if (applyBuff(player, msg.id)) player.pendingPicks--;
      player.offer = null;
      nextOffer(player);
    }

    // Schopnost třídy na klávesách Q / E (zatím jen Fotograf)
    if (msg.type === "ability" && player && player.hp > 0 && player.cls === "photographer") {
      const abilities = CLASSES.photographer.abilities;
      const name = Object.keys(abilities).find((n) => abilities[n].slot === msg.slot && msg.slot !== "attack");
      if (name) startAbility(player, name, Date.now());
    }
  });

  ws.on("close", () => {
    if (player) {
      players.delete(id);
      console.log(`- ${player.name} se odpojil (${players.size} hráčů)`);
      checkGameOver(Date.now()); // odešel poslední živý hráč?
    }
  });
});

// ---------- 3) Herní smyčka ----------
// Server je "šéf" – jen on rozhoduje, kde kdo je a co dělají nepřátelé.
let itemSpawnTimer = 0;

// Sestaví stav hry a pošle ho všem hráčům
function broadcastState(now) {
  const state = JSON.stringify({
    type: "state",
    level,
    solo: players.size === 1, // hraješ sám -> omezený počet oživení
    soloRespawns: DEATH.soloRespawns,
    gameOver: gameOver && {
      remainingMs: Math.max(0, gameOver.until - now),
      survivedMs: gameOver.survivedMs,
      results: gameOver.results,
    },
    players: [...players.values()].map(({ input, action, cooldowns, actionSeq, shieldAt, regenAt, respawnAt, ...rest }) => {
      const busy = action && now < action.endAt;
      return {
        ...rest,
        xpNext: BUFFS.xpForNext(rest.level),
        dead: rest.hp <= 0,
        // za jak dlouho se mrtvý hráč oživí (null = nikdy, hra pro něj končí)
        respawnIn: rest.hp <= 0 && Number.isFinite(respawnAt) ? Math.max(0, respawnAt - now) : null,
        invulnerable: now < rest.invulnerableUntil,
        attacking: now < rest.attackUntil,
        // animace: klient podle toho vybírá snímky (čas od začátku akce posíláme, ne absolutní čas)
        anim: busy ? action.name : rest.moving ? "walk" : "idle",
        animId: busy ? action.id : 0,
        animElapsed: busy ? now - action.start : 0,
        animDir: busy ? action.dir : rest.dir,
        // zbývající cooldowny v ms (pro HUD)
        cd: rest.cls === "photographer"
          ? {
              snapshot: Math.max(0, cooldowns.snapshot - now),
              strong_flash: Math.max(0, cooldowns.strong_flash - now),
              perfect_shot: Math.max(0, cooldowns.perfect_shot - now),
            }
          : undefined,
      };
    }),
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
      hp: Math.round(e.hp * 100) / 100,
      maxHp: e.maxHp,
      hit: now < e.hitUntil,
      marked: now < e.markedUntil,
      stunned: now < e.stunUntil,
    })),
    items: [...items.values()].map((it) => ({
      id: it.id,
      type: it.type,
      x: it.x,
      y: it.y,
      value: it.value,
      fading: it.expiresAt - now < ITEM_FADING_MS, // klient pak předmět nechá blikat
    })),
  });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(state);
  }
}

setInterval(() => {
  const dt = 1 / TICK_RATE;
  const now = Date.now();

  // Konec hry: všechno stojí, ukazuje se výsledek; pak začne nová hra
  if (gameOver) {
    if (now < gameOver.until) {
      broadcastState(now);
      return;
    }
    resetRun(now);
  }

  // 3-0) Obtížnost: stoupá, dokud někdo hraje; když hru všichni opustí, začne se znovu
  if (players.size > 0) {
    difficultyTime += dt;
    const newLevel = Math.min(DIFFICULTY.maxLevel, 1 + Math.floor(difficultyTime / DIFFICULTY.levelSeconds));
    if (newLevel > level) {
      level = newLevel;
      console.log(`  Úroveň obtížnosti: ${level}`);
      for (let n = enemies.length; n < enemyCountForLevel(level); n++) {
        enemies.push(spawnEnemy(enemyDefIndexForLevel(level, n)));
      }
    }
  } else if (level > 1 || difficultyTime > 0) {
    level = 1;
    difficultyTime = 0;
    enemies.length = DIFFICULTY.startEnemies;
  }

  // 3a) Pohyb hráčů
  for (const p of players.values()) {
    // mrtvý hráč čeká na oživení a nic nedělá
    if (p.hp <= 0) {
      if (now >= p.respawnAt) respawnPlayer(p, now);
      else {
        p.moving = false;
        continue;
      }
    }

    // schopnost Fotografa: zásah ve správném snímku animace a po dobu animace stojí
    if (p.action && !p.action.resolved && now >= p.action.hitAt) {
      p.action.resolved = true;
      resolveAction(p, now);
    }
    if (p.action && p.action.roots && now < p.action.endAt) {
      p.moving = false;
      continue; // schopnost Q / E: pozice i směr jsou uzamčené do konce animace
    }

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

    const speed = SPEED * BUFFS.speedMult(p.buffs); // buff Rychlé nohy
    p.x += dx * speed * dt;
    p.y += dy * speed * dt;

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
        e.markedUntil = e.stunUntil = e.slowUntil = 0;
        Object.assign(e, safeSpawnPosition());
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
    const t = (level - 1) / (DIFFICULTY.maxLevel - 1); // 0 na 1. úrovni, 1 na nejvyšší
    const CHASE_RADIUS = DIFFICULTY.chaseStart + (DIFFICULTY.chaseEnd - DIFFICULTY.chaseStart) * t;
    const stunned = now < e.stunUntil;
    const speed =
      e.speed *
      (1 + DIFFICULTY.speedPerLevel * (level - 1)) * // rychlejší s úrovní obtížnosti
      (now < e.slowUntil ? CLASSES.photographer.abilities.strong_flash.slowFactor : 1); // zpomalení od Fotografa

    if (stunned) {
      // omráčený (oslepený) nepřítel stojí
    } else if (nearest && minDist < CHASE_RADIUS) {
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

    e.x += edx * speed * dt;
    e.y += edy * speed * dt;

    e.x = Math.max(10, Math.min(MAP_W * TILE - 10, e.x));
    e.y = Math.max(10, Math.min(MAP_H * TILE - 10, e.y));

    // Nepřítel nemůže projít skrz hráče: když se s ním překrývá, vytlačí se ven.
    // (bodyDist je menší než hitRadius níž, takže se hráče pořád dotkne a kousne)
    const bodyDist = (e.size || 10) + 4;
    for (const p of players.values()) {
      if (p.hp <= 0) continue;
      let ox = e.x - p.x;
      let oy = e.y - p.y;
      let od = Math.hypot(ox, oy);
      if (od >= bodyDist) continue;
      if (od < 0.001) { ox = 1; oy = 0; od = 1; } // přesný překryv: vytlač kamkoliv
      e.x = p.x + (ox / od) * bodyDist;
      e.y = p.y + (oy / od) * bodyDist;
      e.x = Math.max(10, Math.min(MAP_W * TILE - 10, e.x));
      e.y = Math.max(10, Math.min(MAP_H * TILE - 10, e.y));
    }

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

      if (!stunned && dist < hitRadius && now > p.invulnerableUntil) {
        if (p.shield > 0) {
          p.shield--; // štít zásah zablokuje
          p.shieldAt = now + BUFFS.SHIELD_RECHARGE_MS;
        } else {
          p.hp -= 1;
        }
        p.invulnerableUntil = now + 1200; // 1.2s imunita proti další ráně

        // Odhození hráče od nepřítele
        const angle = Math.atan2(p.y - e.y, p.x - e.x);
        p.x += Math.cos(angle) * 25;
        p.y += Math.sin(angle) * 25;
        p.x = Math.max(8, Math.min(MAP_W * TILE - 8, p.x));
        p.y = Math.max(8, Math.min(MAP_H * TILE - 2, p.y));

        if (p.hp <= 0) killPlayer(p, now); // ztratil všechny životy
      }
    }
  }

  // 3b2) Buffy: dobíjení štítů a regenerace životů
  for (const p of players.values()) {
    if (p.shield < (p.buffs.shield || 0) && now >= p.shieldAt) {
      p.shield++;
      p.shieldAt = now + BUFFS.SHIELD_RECHARGE_MS;
    }
    if (p.buffs.regen && now >= p.regenAt) {
      if (p.hp > 0 && p.hp < p.maxHp) p.hp++;
      p.regenAt = now + BUFFS.regenIntervalMs(p.buffs.regen);
    }
  }

  // 3c) Sbírání předmětů (lootu) hráči a obnova na mapě
  for (const p of players.values()) {
    if (p.hp <= 0) continue;
    for (const [itemId, item] of items.entries()) {
      const dist = Math.hypot(p.x - item.x, p.y - item.y);
      if (dist < ITEM_PICKUP_RADIUS * BUFFS.pickupMult(p.buffs)) {
        if (item.type === "xp") {
          addXp(p, item.value);
          items.delete(itemId);
        } else if (item.type === "coin") {
          p.score = (p.score || 0) + 1;
          addXp(p, 1); // mince dává i 1 XP
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
  // Nesebrané předměty po čase zmizí (jinak by se mapa zaplnila srdci,
  // která nikdo nechce, a nové předměty by se přestaly objevovat)
  for (const [itemId, item] of items.entries()) {
    if (now >= item.expiresAt) items.delete(itemId);
  }

  itemSpawnTimer += dt;
  if (itemSpawnTimer > ITEM_SPAWN_INTERVAL && items.size < ITEM_SPAWN_LIMIT) {
    itemSpawnTimer = 0;
    spawnRandomItem();
  }

  // 3d) Pošli všem aktuální stav
  broadcastState(now);
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
