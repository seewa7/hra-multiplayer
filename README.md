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
| **Hrdina** | Mezerník / klik: úder mečem |
| **Fotograf** | Mezerník / klik: **Momentka** (kužel před sebou, označí cíl na 3 s, označený dostává o 15 % víc poškození) · **Q**: **Silný blesk** (omráčí a zpomalí, cooldown 7 s) · **E**: **Perfektní záběr** (dlouhý paprsek, zasáhne všechny v řadě a označí je, cooldown 14 s) |

Časování animací, cooldowny, dosahy a poškození všech tříd jsou v `public/shared/classes.js`.
Klient jen pošle záměr (`attack` / `ability`), o zásahu, poškození a cooldownu rozhoduje server.

**Nová třída:** přidej ji do `public/shared/classes.js`, do výběru v `public/index.html` a obsluhu schopností do `server.js` (`startAbility` / `resolveAction`).

**Sprity Fotografa:** zdroje jsou v `assets-src/photographer/`, hotové atlasy v `public/assets/photographer/`.
Znovu se vyrobí příkazem `python3 tools/build_photographer_atlas.py` (potřebuje `pip3 install pillow numpy scipy`).
Velikost postavy ve hře se mění konstantou `PHOTO_SCALE` v `public/game.js`.

## Obtížnost

Hra začíná klidně (2 zelení slizi, nepřátelé se neobjevují blízko hráčů, nový hráč je 3 s nezranitelný)
a každých 45 s stoupne úroveň (max. 10): přibývají nepřátelé (až 8), jsou rychlejší a vidí hráče z větší dálky,
od 3. úrovně přibývají Ohniví slizi a od 5. Obří slizi. Když hru všichni opustí, začne se znovu od 1. úrovně.
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
