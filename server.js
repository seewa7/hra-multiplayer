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
const ADAM = require("./public/shared/adam.js"); // boss Adam (čísla souboje), sdílené s klientem

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
  levelSeconds: 30, // jak často (s) stoupne úroveň; nepřátelé jsou pořád silnější a je jich víc
  startEnemies: 2, // počet nepřátel na začátku
  maxEnemies: 50, // strop počtu běžných nepřátel
  enemiesPerLevel: 1.2, // o kolik nepřátel víc s každou úrovní
  speedPerLevel: 0.03, // nepřátelé jsou s každou úrovní o 3 % rychlejší...
  maxSpeedMult: 1.5, // ...nejvýš na 150 % (ať nejsou rychlejší než hráč s buffy)
  hpPerLevel: 0.12, // životy nepřátel rostou o 12 % za úroveň (bez stropu)
  xpPerLevel: 0.08, // XP z nepřátel roste o 8 % za úroveň
  redFromLevel: 3, // od které úrovně přibývají Ohniví slizi (rychlejší)
  purpleFromLevel: 5, // od které úrovně přibývají Obří slizi (odolnější)
  bossFirstLevel: 8, // od které úrovně se objeví boss...
  bossEvery: 8, // ...a pak znovu po tolika úrovních
  spawnSafeDistance: 120, // nepřítel se neobjeví blíž než tohle k hráči
  spawnRingMin: 210, // nepřátelé se objevují v kruhu kolem hráče (mimo obrazovku)
  spawnRingMax: 260,
  joinProtectionMs: 3000, // nový hráč je chvíli nezranitelný
};

// Cheaty pro testování (např. bosse). Vypnout jde spuštěním serveru s CHEATS=0:  CHEATS=0 npm start
const CHEATS_ENABLED = process.env.CHEATS !== "0";

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

// Kde se objeví nový nepřítel: v kruhu kolem náhodného živého hráče, těsně mimo obrazovku
// (jako ve Vampire Survivors), dost daleko od všech hráčů. Bez hráčů kdekoliv mimo střed mapy.
function safeSpawnPosition() {
  const alive = [...players.values()].filter((p) => p.hp > 0);
  const avoid = [{ x: (MAP_W * TILE) / 2, y: (MAP_H * TILE) / 2 }, ...players.values()];
  let x, y;
  for (let i = 0; i < 40; i++) {
    if (alive.length) {
      const p = alive[Math.floor(Math.random() * alive.length)];
      const angle = Math.random() * Math.PI * 2;
      const d = DIFFICULTY.spawnRingMin + Math.random() * (DIFFICULTY.spawnRingMax - DIFFICULTY.spawnRingMin);
      x = Math.max(30, Math.min(MAP_W * TILE - 30, p.x + Math.cos(angle) * d));
      y = Math.max(30, Math.min(MAP_H * TILE - 30, p.y + Math.sin(angle) * d));
    } else {
      x = Math.random() * (MAP_W * TILE - 60) + 30;
      y = Math.random() * (MAP_H * TILE - 60) + 30;
    }
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

// Rychlost nepřátel roste s úrovní, ale má strop
function speedMultForLevel(level) {
  return Math.min(DIFFICULTY.maxSpeedMult, 1 + DIFFICULTY.speedPerLevel * (level - 1));
}

// Boss: velký, pomalý, hodně životů a XP; po smrti se neoživuje
const BOSS_DEF = {
  type: "slime_boss", name: "Král slizů", color: "#f1c40f", eyeColor: "#7a4b00",
  speed: 38, maxHp: 22, size: 22, xp: 30, boss: true,
};

// Vlastnosti nepřítele podle úrovně (životy a XP rostou, aby byly nepřátelé postupně silnější)
function enemyStatsFor(def, lvl) {
  const hp = Math.round(def.maxHp * (1 + DIFFICULTY.hpPerLevel * (lvl - 1)) * 10) / 10;
  return {
    type: def.type,
    name: def.name,
    color: def.color,
    eyeColor: def.eyeColor,
    speed: def.speed,
    hp,
    maxHp: hp,
    size: def.size,
    xp: Math.round(def.xp * (1 + DIFFICULTY.xpPerLevel * (lvl - 1))), // kolik XP upustí po smrti
    boss: !!def.boss,
  };
}

function createEnemy(def) {
  return {
    id: nextEnemyId++,
    ...enemyStatsFor(def, level),
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

function spawnEnemy(defIndex) {
  return createEnemy(ENEMY_DEFS[defIndex % ENEMY_DEFS.length]);
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

// Společné zranění hráče (kontakt se slizem i útoky bosse): štít zásah zablokuje, pak ubývají životy.
// Vrací true, když hráč opravdu dostal zásah (ne když je nezranitelný).
function hurtPlayer(p, dmg, now, from, opts = {}) {
  if (p.hp <= 0 || now < p.invulnerableUntil) return false;
  if (p.god) return false; // cheat: god mode (nezraní ho nic, ani boss)
  if (p.shield > 0) {
    p.shield--; // štít zásah zablokuje
    p.shieldAt = now + BUFFS.SHIELD_RECHARGE_MS;
  } else {
    p.hp -= dmg;
  }
  p.invulnerableUntil = now + (opts.invulMs ?? 1200); // imunita proti další ráně

  if (from && opts.knockback) {
    // Odhození hráče od zdroje zásahu
    const angle = Math.atan2(p.y - from.y, p.x - from.x);
    p.x += Math.cos(angle) * opts.knockback;
    p.y += Math.sin(angle) * opts.knockback;
    p.x = Math.max(8, Math.min(MAP_W * TILE - 8, p.x));
    p.y = Math.max(8, Math.min(MAP_H * TILE - 2, p.y));
  }
  if (p.hp <= 0) killPlayer(p, now); // ztratil všechny životy
  return true;
}

// ---------- Boss Adam ----------
// Boss stojí uprostřed arény a nehýbe se. Server rozhoduje o všem (životy, fáze, výběr útoku a cíle,
// dráhy projektilů, zásahy). Klienti dostanou ve stavu `adam` a `bossFx` jen to, co mají nakreslit.
const adam = {
  spawned: false,
  defeated: false, // v téhle hře už byl poražen (znovu se neobjeví)
  e: null, // záznam bosse v poli `enemies` (kvůli zásahům hráčů)
  state: "idle", // idle | phase | defeated
  phase: 1,
  attack: null, // běžící útok
  nextAttackAt: 0,
  phaseBlinkUntil: 0,
  defeatedAt: 0,
  history: [], // posledních použitých útoků
  lastTargetId: null,
  attackSeq: 0,
  fxSeq: 0,
  fx: [], // projektily, varování a zóny
};

const rand = (min, max) => min + Math.random() * (max - min);
const adamPivot = () => ({ x: (MAP_W * TILE) / 2 + ADAM.offset.x, y: (MAP_H * TILE) / 2 + ADAM.offset.y });
const sumFrames = (arr, n = arr.length) => arr.slice(0, n).reduce((a, b) => a + b, 0);
const alivePlayers = () => [...players.values()].filter((p) => p.hp > 0);

function resetAdam() {
  Object.assign(adam, {
    spawned: false, defeated: false, e: null, state: "idle", phase: 1, attack: null,
    nextAttackAt: 0, phaseBlinkUntil: 0, defeatedAt: 0, history: [], lastTargetId: null, fx: [],
  });
}

function spawnAdam(now) {
  const pos = adamPivot();
  const hp = ADAM.baseHp * (1 + ADAM.hpPerExtraPlayer * (players.size - 1));
  adam.e = {
    id: nextEnemyId++,
    adam: true, // zvláštní nepřítel: nehýbe se, neútočí kontaktem, nejde odhodit ani omráčit
    type: "adam",
    name: ADAM.name,
    color: "#fff", eyeColor: "#000",
    speed: 0,
    hp, maxHp: hp,
    size: ADAM.size,
    xp: ADAM.xp,
    x: pos.x, y: pos.y,
    dir: "down", moving: false,
    wanderDir: { x: 0, y: 0 }, wanderTimer: 0,
    hitUntil: 0, respawnTimer: 0, markedUntil: 0, stunUntil: 0, slowUntil: 0,
  };
  // Souboj s bossem: všichni ostatní nepřátelé zmizí a nové se objeví, až když je boss poražen
  enemies.length = 0;
  enemies.push(adam.e);
  Object.assign(adam, { spawned: true, state: "idle", phase: 1, attack: null, history: [], fx: [] });
  adam.nextAttackAt = now + 2500; // první útok až po chvíli, ať se hráči rozkoukají
  console.log(`  ⚠ Objevil se boss ${ADAM.name} (${Math.round(hp)} HP)`);
}

function onAdamDefeated(now) {
  adam.state = "defeated";
  adam.defeated = true;
  adam.defeatedAt = now;
  adam.attack = null;
  adam.fx = []; // všechny efekty a zóny zmizí
  // běžní nepřátelé se po souboji vrátí
  for (let n = enemies.filter((e) => !e.boss && !e.adam).length; n < enemyCountForLevel(level); n++) {
    enemies.push(spawnEnemy(enemyDefIndexForLevel(level, n)));
  }
  console.log(`  ✔ Boss ${ADAM.name} poražen!`);
}

// Životy bosse rostou s počtem hráčů (poměr zbývajících životů se zachová)
function scaleAdamHp() {
  const e = adam.e;
  const target = ADAM.baseHp * (1 + ADAM.hpPerExtraPlayer * (Math.max(1, players.size) - 1));
  if (e.hp > 0 && Math.abs(e.maxHp - target) > 0.01) {
    e.hp = (e.hp / e.maxHp) * target;
    e.maxHp = target;
  }
}

// Další cíl: střídáme živé hráče (ne pořád toho samého)
function pickAdamTarget() {
  const alive = alivePlayers().sort((a, b) => a.id - b.id);
  if (alive.length === 0) return null;
  const next = alive.find((p) => p.id > (adam.lastTargetId ?? -1)) || alive[0];
  adam.lastTargetId = next.id;
  return next;
}

function pickAdamAttack() {
  let pool = adam.phase === 1 ? ["neural"] : adam.phase === 2 ? ["neural", "barbell"] : ["neural", "barbell", "overclock"];
  const h = adam.history;
  const last = h[h.length - 1];
  // stejný útok nejvýš dvakrát po sobě
  if (h.length >= 2 && last === h[h.length - 2] && pool.length > 1) pool = pool.filter((t) => t !== last);
  // jinak spíš střídáme
  if (pool.length > 1 && Math.random() < 0.7) pool = pool.filter((t) => t !== last);
  return pool[Math.floor(Math.random() * pool.length)];
}

function addAdamFx(fx) {
  fx.id = ++adam.fxSeq;
  adam.fx.push(fx);
  return fx;
}

function startAdamAttack(now) {
  const target = pickAdamTarget();
  if (!target) return;
  const type = pickAdamAttack();
  const sp = adam.phase === 3 ? ADAM.phase3Speed : 1; // ve 3. fázi o něco rychlejší
  const cfg = ADAM.attacks[type];
  const pos = adamPivot();
  const attack = { id: ++adam.attackSeq, type, start: now, speed: sp, targetId: target.id, fired: false };

  if (type === "neural") {
    attack.fireAt = now + sumFrames(cfg.frames, cfg.fireFrame) * sp;
    attack.endAt = now + sumFrames(cfg.frames) * sp;
  } else if (type === "barbell") {
    const impactAt = now + (cfg.telegraphMs + sumFrames(cfg.frames, cfg.impactFrame)) * sp;
    const expandStart = impactAt + cfg.flashMs * sp;
    const expandEnd = expandStart + cfg.expandMs * sp;
    attack.endAt = expandEnd + cfg.decayMs * sp;
    addAdamFx({ kind: "shock", x: pos.x, y: pos.y, start: now, impactAt, expandStart, expandEnd, until: attack.endAt, hit: new Set(), attackId: attack.id });
  } else {
    // overclock: 2–4 výboje na pozice hráčů / různé směry, každý je před výstřelem vidět na zemi
    const n = Math.floor(rand(cfg.shots[0], cfg.shots[1] + 1));
    const alive = alivePlayers().sort((a, b) => a.id - b.id);
    const fireBase = now + sumFrames(cfg.frames, cfg.fireFrame) * sp;
    attack.shots = [];
    for (let i = 0; i < n; i++) {
      const t = i === 0 ? target : alive[i % alive.length];
      const spread = i < alive.length ? 0 : rand(-0.6, 0.6); // navíc výboje jdou trochu vedle, ať se zóny nepřekrývají
      const angle = Math.atan2(t.y - pos.y, t.x - pos.x) + spread;
      const fireAt = fireBase + i * cfg.staggerMs * sp;
      attack.shots.push({ angle, fireAt, fired: false, aim: null });
      attack.shots[i].aim = addAdamFx({ kind: "oc_aim", x: pos.x, y: pos.y, angle, start: now, until: fireAt, attackId: attack.id });
    }
    attack.endAt = Math.max(now + sumFrames(cfg.frames) * sp, fireBase + (n - 1) * cfg.staggerMs * sp + 200);
  }

  adam.attack = attack;
  adam.history.push(type);
  if (adam.history.length > 4) adam.history.shift();
  adam.nextAttackAt = attack.endAt + rand(...ADAM.attackIntervalMs[adam.phase - 1]) * sp;
}

// Výbuch (dopad projektilu) + zbylá zóna na zemi
function adamExplode(kind, x, y, now, hitSet) {
  const cfg = ADAM.attacks[kind];
  addAdamFx({ kind: kind === "neural" ? "neural_impact" : "oc_impact", x, y, start: now, until: now + cfg.impactMs });
  for (const p of alivePlayers()) {
    if (hitSet.has(p.id)) continue; // jedna instance zasáhne hráče jen jednou
    if (Math.hypot(p.x - x, p.y - y) <= cfg.impactRadius + 5) {
      hitSet.add(p.id);
      hurtPlayer(p, kind === "neural" ? cfg.damage : cfg.impactDamage, now);
    }
  }
  addAdamFx({ kind: kind === "neural" ? "neural_zone" : "oc_zone", x, y, start: now, until: now + cfg.zone.lifeMs, next: new Map() });
}

function updateAdam(now, dt) {
  if (!adam.spawned && !adam.defeated && players.size > 0 && difficultyTime >= ADAM.spawnAfterSec) spawnAdam(now);
  if (!adam.spawned) return;

  // poražený boss chvíli stojí v klidovém stavu a pak zmizí
  if (adam.state === "defeated") {
    if (now - adam.defeatedAt > ADAM.defeatedLingerMs) {
      adam.e.gone = true;
      adam.spawned = false;
      adam.e = null;
    }
    return;
  }

  scaleAdamHp();
  const e = adam.e;
  const pos = adamPivot();

  // fáze podle zbývajících životů
  const ratio = e.hp / e.maxHp;
  const newPhase = ratio <= ADAM.phaseFromRatio[1] ? 3 : ratio <= ADAM.phaseFromRatio[0] ? 2 : 1;
  if (newPhase > adam.phase) {
    adam.phase = newPhase;
    adam.phaseBlinkUntil = Math.max(now, adam.attack ? adam.attack.endAt : now) + ADAM.phaseChangeMs;
    adam.nextAttackAt = Math.max(adam.nextAttackAt, adam.phaseBlinkUntil + 400);
    console.log(`  Boss: ${ADAM.phaseNames[newPhase - 1]}`);
  }
  adam.state = now < adam.phaseBlinkUntil && !adam.attack ? "phase" : "idle";

  // plánované výstřely běžícího útoku
  const atk = adam.attack;
  if (atk) {
    const cfg = ADAM.attacks[atk.type];
    if (atk.type === "neural" && !atk.fired && now >= atk.fireAt) {
      atk.fired = true;
      const t = players.get(atk.targetId) && players.get(atk.targetId).hp > 0 ? players.get(atk.targetId) : pickAdamTarget();
      if (t) {
        const ox = pos.x + cfg.origin.x, oy = pos.y + cfg.origin.y;
        let dx = t.x - ox, dy = t.y - oy;
        const d = Math.hypot(dx, dy) || 1;
        const reach = Math.min(d, cfg.maxRange);
        const tx = ox + (dx / d) * reach, ty = oy + (dy / d) * reach; // cíl = pozice hráče v okamžiku výstřelu
        const dur = Math.max(cfg.flightMinMs, Math.min(cfg.flightMaxMs, (reach / cfg.speed) * 1000));
        addAdamFx({ kind: "neural_mark", x: tx, y: ty, start: now, until: now + dur }); // značka dopadu
        addAdamFx({
          kind: "neural_proj", x: ox, y: oy, ox, oy, tx, ty, angle: Math.atan2(ty - oy, tx - ox),
          start: now, dur, until: now + dur + 50, hit: new Set(), attackId: atk.id,
        });
      }
    }
    if (atk.type === "overclock") {
      for (const shot of atk.shots) {
        if (shot.fired || now < shot.fireAt) continue;
        shot.fired = true;
        if (shot.aim) shot.aim.until = now; // varování zmizí, výboj vyletí
        addAdamFx({
          kind: "oc_proj", x: pos.x, y: pos.y, angle: shot.angle, start: now, until: now + 5000,
          traveled: 0, hit: new Set(), attackId: atk.id,
        });
      }
    }
    if (now >= atk.endAt) adam.attack = null;
  }

  updateAdamFx(now, dt);

  // další útok
  if (!adam.attack && now >= adam.nextAttackAt && now >= adam.phaseBlinkUntil) {
    if (alivePlayers().length > 0) startAdamAttack(now);
    else adam.nextAttackAt = now + 500; // nikdo nežije -> boss čeká
  }
}

// Pohyb projektilů, zásahy a zóny (všechno se počítá z časových razítek, ne z FPS)
function updateAdamFx(now, dt) {
  const A = ADAM.attacks;
  const pos = adamPivot();

  for (const f of adam.fx) {
    if (f.dead) continue;

    if (f.kind === "neural_proj") {
      const k = Math.min(1, (now - f.start) / f.dur);
      f.x = f.ox + (f.tx - f.ox) * k;
      f.y = f.oy + (f.ty - f.oy) * k;
      let exploded = false;
      for (const p of alivePlayers()) {
        if (!f.hit.has(p.id) && Math.hypot(p.x - f.x, p.y - f.y) <= A.neural.hitRadius + 5) {
          f.hit.add(p.id); // jeden projektil zasáhne hráče jen jednou
          hurtPlayer(p, A.neural.damage, now);
          exploded = true;
        }
      }
      if (exploded || k >= 1) {
        f.dead = true;
        adamExplode("neural", f.x, f.y, now, f.hit);
        for (const m of adam.fx) if (m.kind === "neural_mark" && Math.abs(m.x - f.tx) < 0.01 && Math.abs(m.y - f.ty) < 0.01) m.until = now;
      }
    } else if (f.kind === "oc_proj") {
      f.traveled += A.overclock.speed * dt;
      f.x = pos.x + Math.cos(f.angle) * f.traveled;
      f.y = pos.y + Math.sin(f.angle) * f.traveled;
      let hit = false;
      for (const p of alivePlayers()) {
        if (!f.hit.has(p.id) && Math.hypot(p.x - f.x, p.y - f.y) <= A.overclock.hitRadius + 3) {
          f.hit.add(p.id);
          hurtPlayer(p, A.overclock.damage, now);
          hit = true;
        }
      }
      const out = f.x < 8 || f.x > MAP_W * TILE - 8 || f.y < 8 || f.y > MAP_H * TILE - 8;
      if (hit || out || f.traveled >= A.overclock.maxRange) {
        f.dead = true;
        f.x = Math.max(8, Math.min(MAP_W * TILE - 8, f.x));
        f.y = Math.max(8, Math.min(MAP_H * TILE - 8, f.y));
        adamExplode("overclock", f.x, f.y, now, f.hit);
      }
    } else if (f.kind === "shock") {
      // prstenec (elipsa) expanduje od středu; zasáhne hráče, přes kterého právě projde
      if (now >= f.expandStart && now <= f.expandEnd) {
        const cfg = A.barbell;
        const s = (now - f.expandStart) / (f.expandEnd - f.expandStart); // 0..1
        const a = cfg.radius, b = cfg.radius * cfg.aspect;
        for (const p of alivePlayers()) {
          if (f.hit.has(p.id)) continue;
          const rho = Math.hypot((p.x - f.x) / a, (p.y - f.y) / b); // 1 = na okraji prstence
          if (Math.abs(rho - (0.1 + 0.8 * s)) <= cfg.thickness) {
            f.hit.add(p.id); // jedna vlna zasáhne hráče nejvýš jednou
            hurtPlayer(p, cfg.damage, now, { x: f.x, y: f.y }, { knockback: cfg.knockback });
          }
        }
      }
    } else if (f.kind === "neural_zone" || f.kind === "oc_zone") {
      const z = f.kind === "neural_zone" ? A.neural.zone : A.overclock.zone;
      const rx = z.radius ?? z.rx, ry = z.radius ?? z.ry;
      for (const p of alivePlayers()) {
        if (Math.hypot((p.x - f.x) / rx, (p.y - f.y) / ry) > 1) continue;
        p.slowUntil = now + 250; // zpomalení, dokud stojí v zóně
        p.slowFactor = z.slow;
        if (z.tickDamage) {
          // periodické poškození podle časového razítka (nezávisí na FPS)
          const due = f.next.get(p.id) ?? now + z.graceMs;
          f.next.set(p.id, due);
          if (now >= due) {
            hurtPlayer(p, z.tickDamage, now, null, { invulMs: 400 });
            f.next.set(p.id, now + z.tickMs);
          }
        }
      }
    }
  }
  adam.fx = adam.fx.filter((f) => !f.dead && f.until > now);
}

// Společné zranění nepřítele (hrdina i fotograf). Řeší označení, smrt, skóre a loot.
function hurtEnemy(e, dmg, player, now, knockback) {
  if (e.hp <= 0) return;
  dmg *= BUFFS.damageMult(player.buffs); // buff Větší síla
  if (now < e.markedUntil) dmg *= CLASSES.MARK_BONUS;
  e.hp -= dmg;
  e.hitUntil = now + 200;

  if (knockback && !e.adam) {
    // Odhození nepřítele (knockback), boss se neodhazuje
    const angle = Math.atan2(e.y - player.y, e.x - player.x);
    e.x += Math.cos(angle) * 22;
    e.y += Math.sin(angle) * 22;
    e.x = Math.max(10, Math.min(MAP_W * TILE - 10, e.x));
    e.y = Math.max(10, Math.min(MAP_H * TILE - 10, e.y));
  }

  if (e.hp <= 1e-6) {
    e.hp = 0;
    if (e.adam) onAdamDefeated(now);
    player.score = (player.score || 0) + 1;
    e.respawnTimer = 4; // oživí se za 4 vteřiny

    // XP krystal vypadne z každého poraženého nepřítele
    spawnItem("xp", e.x, e.y, e.xp);
    if (e.boss) {
      spawnItem("heart", e.x + 10, e.y); // boss navíc upustí srdce
      console.log(`  ${player.name} porazil bosse (${e.name})`);
    }

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
      if (!e.adam) { // boss je proti omráčení a zpomalení odolný
        e.stunUntil = Math.max(e.stunUntil, now + ab.stunMs);
        e.slowUntil = Math.max(e.slowUntil, now + ab.stunMs + ab.slowMs);
      }
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

  resetAdam();
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
        god: false, // cheat: nesmrtelnost (přepíná se kódem 6767)
        slowUntil: 0, // zpomalení od bosse
        slowFactor: 1,
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

    // Cheaty (testování): klient pošle kód, server přepne režim jen tomuhle hráči
    if (msg.type === "cheat" && player && CHEATS_ENABLED && msg.id === "god") {
      player.god = !player.god;
      console.log(`  ★ ${player.name}: god mode ${player.god ? "ZAPNUT" : "vypnut"}`);
    }
    // Cheat 1234: přivolá bosse Adama hned (nebo znovu po porážce); když už bojuje, nic se nestane
    if (msg.type === "cheat" && player && CHEATS_ENABLED && msg.id === "boss") {
      if (!(adam.spawned && adam.state !== "defeated")) {
        if (adam.e) adam.e.gone = true; // zbytek poraženého bosse
        resetAdam();
        spawnAdam(Date.now());
        console.log(`  ★ ${player.name}: přivolal bosse`);
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
        slowed: now < rest.slowUntil,
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
    // Boss Adam: životy, fáze, běžící útok (animace se na klientu počítá z "elapsed") a efekty
    adam: adam.spawned && adam.e
      ? {
          name: ADAM.name,
          x: adam.e.x, y: adam.e.y,
          hp: Math.max(0, Math.round(adam.e.hp * 10) / 10),
          maxHp: Math.round(adam.e.maxHp * 10) / 10,
          phase: adam.phase,
          phaseName: ADAM.phaseNames[adam.phase - 1],
          defeated: adam.state === "defeated",
          defeatedAgo: adam.state === "defeated" ? now - adam.defeatedAt : 0,
          blink: adam.state === "phase", // přechod do další fáze: neškodné zablikání
          hit: now < adam.e.hitUntil,
          marked: now < adam.e.markedUntil,
          attack: adam.attack
            ? { id: adam.attack.id, type: adam.attack.type, elapsed: now - adam.attack.start, speed: adam.attack.speed }
            : null,
        }
      : null,
    // za kolik sekund se boss objeví (null = už je tady nebo byl poražen)
    adamIn: !adam.spawned && !adam.defeated ? Math.max(0, Math.ceil(ADAM.spawnAfterSec - difficultyTime)) : null,
    bossFx: adam.fx.map((f) => ({
      id: f.id,
      kind: f.kind,
      x: Math.round(f.x * 10) / 10,
      y: Math.round(f.y * 10) / 10,
      angle: f.angle,
      age: now - f.start,
      life: f.until - f.start,
      // jen pro prstenec (shock): časy od začátku útoku, kdy dopadne a expanduje
      t: f.kind === "shock" ? [f.impactAt - f.start, f.expandStart - f.start, f.expandEnd - f.start] : undefined,
    })),
    enemies: enemies.filter((e) => e.hp > 0 && !e.adam).map((e) => ({
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
      boss: e.boss,
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
    const newLevel = 1 + Math.floor(difficultyTime / DIFFICULTY.levelSeconds); // bez stropu, hra se zhoršuje pořád
    if (newLevel > level) {
      level = newLevel;
      console.log(`  Úroveň obtížnosti: ${level}`);
      // nových nepřátel přibude, aby jich bylo tolik, kolik odpovídá úrovni (boss se nepočítá);
      // při souboji s Adamem se žádní nepřátelé ani slizí boss neobjevují
      const bossFight = adam.spawned && adam.state !== "defeated";
      if (!bossFight) {
        for (let n = enemies.filter((e) => !e.boss && !e.adam).length; n < enemyCountForLevel(level); n++) {
          enemies.push(spawnEnemy(enemyDefIndexForLevel(level, n)));
        }
        if (level >= DIFFICULTY.bossFirstLevel && (level - DIFFICULTY.bossFirstLevel) % DIFFICULTY.bossEvery === 0) {
          enemies.push(createEnemy(BOSS_DEF));
          console.log(`  ⚠ Objevil se boss (${BOSS_DEF.name})`);
        }
      }
    }
  } else if (level > 1 || difficultyTime > 0) {
    level = 1;
    difficultyTime = 0;
    resetAdam();
    enemies.length = 0;
    for (let i = 0; i < DIFFICULTY.startEnemies; i++) enemies.push(spawnEnemy(enemyDefIndexForLevel(1, i)));
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

    let speed = SPEED * BUFFS.speedMult(p.buffs); // buff Rychlé nohy
    if (now < p.slowUntil) speed *= p.slowFactor; // zpomalení v zóně bosse
    p.x += dx * speed * dt;
    p.y += dy * speed * dt;

    // nepustit hráče z mapy
    p.x = Math.max(8, Math.min(MAP_W * TILE - 8, p.x));
    p.y = Math.max(8, Math.min(MAP_H * TILE - 2, p.y));

    // do těla bosse se vlézt nedá
    if (adam.spawned && adam.state !== "defeated") {
      const bp = adamPivot();
      const minD = ADAM.bodyRadius + 5;
      let bx = p.x - bp.x, by = p.y - bp.y;
      let bd = Math.hypot(bx, by);
      if (bd < minD) {
        if (bd < 0.01) { bx = 0; by = 1; bd = 1; }
        p.x = bp.x + (bx / bd) * minD;
        p.y = bp.y + (by / bd) * minD;
      }
    }

    p.moving = dx !== 0 || dy !== 0;
    if (dx < 0) p.dir = "left";
    else if (dx > 0) p.dir = "right";
    else if (dy < 0) p.dir = "up";
    else if (dy > 0) p.dir = "down";
  }

  // 3a2) Boss Adam: spawn, fáze, útoky, projektily a zóny
  updateAdam(now, dt);

  // 3b) AI nepřátel a kolize
  for (const e of enemies) {
    if (e.hp <= 0) {
      if (e.adam) continue; // Adam se neoživuje, jeho konec řeší updateAdam
      if (e.boss) {
        e.gone = true; // boss se po smrti neoživuje, odstraní se níž
        continue;
      }
      e.respawnTimer -= dt;
      if (e.respawnTimer <= 0) {
        // Znovu se objeví u okraje obrazovky, silnější podle aktuální úrovně (typ se losuje znovu)
        Object.assign(
          e,
          enemyStatsFor(ENEMY_DEFS[enemyDefIndexForLevel(level, e.id)], level),
          safeSpawnPosition(),
          { markedUntil: 0, stunUntil: 0, slowUntil: 0, hitUntil: 0 }
        );
      }
      continue;
    }

    if (e.adam) continue; // Adam stojí na místě a útočí podle vlastní logiky (updateAdam)

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
    const stunned = now < e.stunUntil;
    const speed =
      e.speed *
      speedMultForLevel(level) * // rychlejší s úrovní obtížnosti
      (now < e.slowUntil ? CLASSES.photographer.abilities.strong_flash.slowFactor : 1); // zpomalení od Fotografa

    if (stunned) {
      // omráčený (oslepený) nepřítel stojí
    } else if (nearest) {
      // Pronásledování nejbližšího živého hráče, ať je kdekoliv na mapě
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

    // Slizi nelezou do těla bosse
    if (adam.spawned && adam.state !== "defeated") {
      const bp = adamPivot();
      const minD = ADAM.bodyRadius + (e.size || 10) / 2;
      let bx = e.x - bp.x, by = e.y - bp.y;
      let bd = Math.hypot(bx, by);
      if (bd < minD) {
        if (bd < 0.01) { bx = 1; by = 0; bd = 1; }
        e.x = bp.x + (bx / bd) * minD;
        e.y = bp.y + (by / bd) * minD;
      }
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

      if (!stunned && dist < hitRadius) hurtPlayer(p, 1, now, e, { knockback: 25 });
    }
  }

  // Nepřátelé se nesmí slít do jednoho bodu (jinak by hejno vypadalo jako jeden sliz): lehce se odtlačují
  const aliveEnemies = enemies.filter((e) => e.hp > 0 && !e.adam);
  for (let i = 0; i < aliveEnemies.length; i++) {
    for (let j = i + 1; j < aliveEnemies.length; j++) {
      const a = aliveEnemies[i], b = aliveEnemies[j];
      const minD = ((a.size || 10) + (b.size || 10)) * 0.45;
      let ox = b.x - a.x, oy = b.y - a.y;
      let d = Math.hypot(ox, oy);
      if (d >= minD) continue;
      if (d < 0.01) { ox = Math.random() - 0.5; oy = Math.random() - 0.5; d = Math.hypot(ox, oy) || 1; }
      const push = (minD - d) / 2;
      a.x -= (ox / d) * push; a.y -= (oy / d) * push;
      b.x += (ox / d) * push; b.y += (oy / d) * push;
    }
  }
  for (const e of aliveEnemies) {
    e.x = Math.max(10, Math.min(MAP_W * TILE - 10, e.x));
    e.y = Math.max(10, Math.min(MAP_H * TILE - 10, e.y));
  }
  for (let i = enemies.length - 1; i >= 0; i--) if (enemies[i].gone) enemies.splice(i, 1); // poražený boss

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
