# Hra Multiplayer (LAN)

Jednoduchá 2D pixel hra s pohledem shora. Všichni na stejné WiFi se můžou připojit a chodit po mapě.

## Jak to spustit

**Jen jeden člověk (host)** potřebuje [Node.js](https://nodejs.org). Ostatním stačí prohlížeč.

```bash
npm install      # jen poprvé
npm start
```

Server vypíše adresu, třeba:

```
Ostatní na stejné WiFi: http://192.168.1.23:3000
```

Tu adresu ostatní otevřou v prohlížeči (funguje i z mobilu, ale ovládá se klávesnicí).

### Když se ostatní nemůžou připojit
- Musíte být **na stejné WiFi**.
- **Firewall**: Mac při prvním spuštění se zeptá „Povolit příchozí spojení pro node?“ → **Povolit**. Na Windows povolit Node.js v dialogu firewallu (zaškrtnout i „Soukromé sítě“).
- **Školní WiFi** často zakazuje, aby se zařízení viděla navzájem („client isolation“). Pak to nepůjde a je potřeba hotspot z mobilu – všichni se připojí na hotspot a funguje to.

## Jak funguje multiplayer

```
  Prohlížeč hráče A ─┐                        ┌─> všichni dostanou
  Prohlížeč hráče B ─┼── "držím klávesu W" ──>│ SERVER │── "A je na [120, 80],
  Prohlížeč hráče C ─┘                        └─>       B je na [300, 40] ..."
```

1. **Server** (`server.js`) běží na počítači hosta. Jako u Minecraftu – jeden „hostuje“, ostatní se připojí na jeho IP adresu.
2. Prohlížeč se k serveru připojí přes **WebSocket** – trvalé spojení, kterým jdou zprávy oběma směry.
3. Klient serveru posílá **jen to, které klávesy drží** (`{type: "input", up: true, ...}`).
4. Server 30× za sekundu spočítá nové pozice všech hráčů a pošle je všem (`{type: "state", players: [...]}`).
5. Klient jen **kreslí**, co mu server poslal (a pohyb trochu vyhlazuje, aby nebyl trhaný).

Server je „šéf“ – rozhoduje o všem důležitém. Díky tomu všichni vidí to samé a nikdo nemůže podvádět.

## Třídy hrdinů

Při vstupu do hry si hráč vybere třídu. Zatím jsou dvě:

| Třída | Ovládání |
|---|---|
| **Hrdina** | Mezerník / klik: úder mečem, zasáhne všechny kolem dokola (360°) |
| **Fotograf** | Mezerník / klik: **Momentka** (zasáhne dokola 360°, označí cíl na 3 s, označený dostává o 15 % víc poškození) · **Q**: **Silný blesk** (omráčí a zpomalí, cooldown 7 s) · **E**: **Perfektní záběr** (dlouhý paprsek, zasáhne všechny v řadě a označí je, cooldown 14 s) |

Časování animací, cooldowny, dosahy a poškození všech tříd jsou v `public/shared/classes.js`.
Klient jen pošle záměr (`attack` / `ability`), o zásahu, poškození a cooldownu rozhoduje server.

**Nová třída:** přidej ji do `public/shared/classes.js`, do výběru v `public/index.html` a obsluhu schopností do `server.js` (`startAbility` / `resolveAction`).

**Sprity Fotografa:** zdroje jsou v `assets-src/photographer/`, hotové atlasy v `public/assets/photographer/`.
Znovu se vyrobí příkazem `python3 tools/build_photographer_atlas.py` (potřebuje `pip3 install pillow numpy scipy`).
Velikost postavy ve hře se mění konstantou `PHOTO_SCALE` v `public/game.js`.

## Boss Adam

**Adam — AI & Gym Overlord** stojí uprostřed arény (nad středem mapy) a nehýbe se. Zatím se objeví **hned na začátku hry**
(`spawnAfterSec: 0` v `public/shared/adam.js`; až se bude testovat časování, stačí to číslo zvýšit). Má lištu životů vpravo nahoře
a fáze podle zbývajících životů:
1. **Fáze 1 (100–61 %)** – jen **Neural Network**: datový projektil letí na pozici hráče v okamžiku výstřelu (značka dopadu je vidět),
   při dopadu výbuch a neuronová past na 3 s (zpomaluje a občas zraní).
2. **Fáze 2 (60–26 %)** – střídá Neural Network a **Barbell Shockwave**: varovný kruh na zemi, pak se kolem bosse rozběhne prstenec
   (elipsa). Uhnout se dá z dosahu prstence, nebo když už prošel kolem tebe.
3. **Fáze 3 (25–0 %)** – střídá všechny tři, útoky jsou o 15 % rychlejší; **Overclock Cables** vystřelí 2–4 výboje, každý je před výstřelem
   označený pruhem na zemi, přímý zásah dává 2 zranění a zbyde zpomalující zóna.
Stejný útok nejde víc než dvakrát po sobě a cíl se střídá mezi živými hráči. Životy rostou s počtem hráčů (×1,65 pro dva).
Po porážce boss přestane útočit, efekty zmizí a ukáže se „VÍTĚZSTVÍ!“. Všechna čísla (HP, poškození, cooldowny, telegraphy, rychlosti,
životnost zón, kotvy snímků) jsou v `public/shared/adam.js`, logika v `server.js` (`updateAdam`, `startAdamAttack`, `updateAdamFx`),
vykreslení v `public/game.js`. Sprity jsou v `public/assets/adam/` (zdrojový concept v `assets-src/adam/`).

## Obtížnost (vlny jako ve Survivor.io)

Nepřátelé **jdou pořád za nejbližším živým hráčem, ať je kdekoliv na mapě**. Nový se objevuje v kruhu těsně mimo obrazovku
kolem hráče (a když zabiješ jednoho, za chvíli se objeví další, už silnější). Hra začíná klidně (2 zelení slizi, 3 s nezranitelnosti pro
nového hráče) a **každých 30 s stoupne úroveň, bez stropu**:
- přibývá nepřátel (+1,2 za úroveň, max. 50),
- mají víc životů (+12 % za úroveň) a dávají víc XP,
- jsou rychlejší (+3 % za úroveň, nejvýš 150 %),
- od 3. úrovně přibývají Ohniví slizi, od 5. Obří slizi,
- od 8. úrovně a pak každých 8 úrovní přijde **boss Král slizů** (velký, hodně životů a XP, neoživuje se).
Nepřátelé se navzájem lehce odtlačují, takže hejno nevypadá jako jeden sliz. Když hru všichni opustí (nebo skončí smrtí), začne se znovu od 1. úrovně.
Všechna čísla jsou v objektu `DIFFICULTY` nahoře v `server.js`.

## Soubory

| Soubor | Co dělá |
|---|---|
| `server.js` | herní server – pozice hráčů, herní smyčka, posílání stavu |
| `public/game.js` | klient – ovládání, kreslení mapy a postaviček |
| `public/index.html` | stránka s plátnem a přihlašovacím oknem |

## Jak přidávat věci

- **Nová akce hráče** (např. střelba): v `game.js` pošli `send({ type: "shoot" })`, v `server.js` ji zpracuj v `ws.on("message")`.
- **Nový herní objekt** (mince, nepřátelé): ulož ho na serveru, posílej ve zprávě `state` a v `game.js` ho nakresli ve funkci `frame`.
- **Velikost mapy**: `MAP_W` / `MAP_H` – musí být stejné v `server.js` i `game.js`.

## Smrt, oživení a konec hry

Když ztratíš všechny životy, na **30 s** vypadneš ze hry (kamera sleduje živého spoluhráče) a pak se oživíš ve středu mapy
s krátkou nezranitelností. Buffy, XP i level ti zůstávají.
- **Hraješ sám:** máš **jedno oživení**. Druhá smrt = konec hry.
- **Hraješ s ostatními:** oživuješ se pořád, hra končí **až zemřou všichni hráči naráz**.
- Po konci hry se na 10 s ukáže výsledek (čas přežití, level a body hráčů) a pak začne **nová hra** (level, XP, buffy a skóre se vynulují,
  obtížnost začíná znovu od 1. úrovně).
Časy jsou v objektu `DEATH` nahoře v `server.js`.

## XP, levely a buffy

Z každého poraženého nepřítele vypadne **XP krystal** (zelený sliz 2 XP, ohnivý 3, obří 6), mince dávají 1 XP.
Za XP hráč postupuje o level (na další level je potřeba 5, 9, 13, ... XP, max. level 20) a při každém postupu
si **vybere 1 ze 3 náhodných buffů** (kliknutím nebo klávesou 1 / 2 / 3, hra se nezastavuje):

| Buff | Efekt | Max |
|---|---|---|
| ❤️ Srdce navíc | +1 max. život a hned se doplní | 5 |
| ⚔️ Větší síla | +30 % poškození | 5 |
| 👟 Rychlé nohy | +12 % rychlost pohybu | 4 |
| 🛡️ Štít | zablokuje 1 zásah, dobije se za 10 s | 3 |
| ⚡ Rychlejší útoky | -20 % cooldowny | 3 |
| 🧲 Magnet | +50 % dosah sbírání | 3 |
| 💚 Regenerace | +1 život každých ~20 s | 3 |

Definice a čísla jsou v `public/shared/buffs.js` (načítá server i klient), logika v `server.js`
(`addXp`, `nextOffer`, `applyBuff`). **Nový buff:** přidej ho do `LIST` v `buffs.js` a jeho efekt na místo, kde se používá
(např. `BUFFS.damageMult` v `hurtEnemy`). Server posílá v `state` u hráče `level`, `xp`, `xpNext`, `buffs`, `shield`, `offer`, `pendingPicks`;
klient posílá `{type: "pickBuff", id}`.

## Cheaty (pro testování)

Ve hře napiš za sebou číslice (nahoře nebo na numerické klávesnici, ne do políčka se jménem):

| Kód | Co dělá |
|---|---|
| **6767** | **god mode** – nic ti neublíží (ani boss Adam), vedle jména je ★ a v HUD hláška; stejným kódem se vypne; platí jen pro tebe |
| **1234** | **přivolá bosse Adama** hned (a znovu i po jeho porážce); když už bojuje, nic se nestane |

O cheatu rozhoduje server (`CHEATS_ENABLED` v `server.js`). Když ho nechceš, spusť server s `CHEATS=0 npm start`.
Další cheat přidáš do `CHEAT_CODES` v `public/game.js` a do obsluhy zprávy `cheat` v `server.js`.
