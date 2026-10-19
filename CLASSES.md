# CLASSES.md – pravidla pro přidání nové třídy hrdiny

Každá třída musí fungovat s herním systémem **XP → level → výběr buffu**, s nepřáteli, štítem
a cooldowny. Když to nesplňuje, hráči se třídou dostanou nespravedlivou výhodu nebo se jim
rozbije postup (nedostanou XP, buffy nepůsobí, štít neblokuje…).
**Tohle je povinné čtení pro každého, kdo třídu přidává nebo mění – lidi i AI agenty.**
Obecná pravidla (větve, PR, revize) jsou v `AGENTS.md`, tady jsou jen pravidla pro třídy.

## Jak systém funguje (stručně)

- Z každého poraženého nepřítele vypadne **XP krystal**, mince dávají 1 XP. Za XP hráč postupuje o level
  a vybírá si buff (`public/shared/buffs.js`, logika `addXp` / `nextOffer` / `applyBuff` v `server.js`).
- **Level, XP a buffy patří hráči, ne třídě.** Jsou ve stejných polích u všech tříd
  (`level`, `xp`, `buffs`, `shield`, `offer`, …). Třída je nesmí nulovat, přepisovat ani obcházet.
- Buffy působí na všechny třídy stejně přes pomocné funkce v `buffs.js`:
  `damageMult`, `cooldownMult`, `speedMult`, `pickupMult`, štít a regenerace.

## Povinná pravidla (porušení = PR se nemerguje)

1. **Veškeré zranění nepřátel jde přes `hurtEnemy(e, dmg, player, now, knockback)`.**
   Nikdy neodečítej `e.hp` přímo a nedávej za zabití skóre/XP ručně. `hurtEnemy` už řeší buff
   Větší síla, označení (Fotograf), smrt, skóre, **XP krystal** a loot. Když ho obejdeš, tvoje třída
   nedá XP a nepůsobí na ni poškozovací buff.
2. **Každý cooldown a každá prodleva mezi útoky se násobí `BUFFS.cooldownMult(p.buffs)`**
   (viz `startAbility` a základní útok hrdiny). Jinak buff Rychlejší útoky třídě nepomůže.
3. **Pohyb jde přes společnou smyčku v `server.js`** (ta násobí `BUFFS.speedMult`). Nepiš si vlastní
   pohyb. Když třída něco jako dash nebo zrychlení potřebuje, **vynásob** rychlost, nepřepisuj ji.
4. **Smrt hráče řeší jen `killPlayer`** (oživení po 30 s, konec hry, když zemřou všichni). Nikdy nenastavuj `hp = 0` ani neoživuj ručně.
   **Zranění hráče vždy přes `hurtPlayer(p, dmg, now, from, opts)`** (respektuje štít a nezranitelnost, řeší odhození a smrt).
   Nikdy neodečítej `p.hp` ručně (používají ji slizi i útoky bosse Adama).
5. **Životy a maximum nastavuje jen systém buffů.** `maxHp` ani `hp` nepřepisuj po vstupu do hry
   (buff Srdce navíc by se ztratil). Základní hodnoty třídy se nastaví jednou při `join`.
6. **Server je šéf.** Klient pošle jen záměr (`attack`, `ability`), server rozhodne o zásahu, poškození
   i cooldownu. Zásah se vyhodnotí na serveru ve správném snímku animace (`hitFrame`) a jen jednou
   na jednu aktivaci. Směr se po dobu animace zamkne a další útok nejde spustit, dokud animace neběží.
7. **Všechna čísla třídy jsou v `public/shared/classes.js`** (časování, cooldowny, dosahy, poškození). Nikde
   je nekopíruj natvrdo do `server.js` ani `game.js`, jinak se server s klientem rozejdou.
8. **Nesahej do cizích tříd a do systému XP/buffů** v rámci PR s novou třídou. Potřebuješ-li změnu
   společného kódu (třeba aby buff působil na tvoji mechaniku), udělej ji ve vlastní větvi a PR
   a v popisu vysvětli proč.
9. **Třídně specifické buffy zatím nejsou podporované** (nabídka vybírá ze všech buffů stejně).
   Pokud chceš buff jen pro svou třídu, nejdřív to domluv v týmu a přidej filtr do `nextOffer` ve vlastním PR.
10. **Základní útok (Mezerník / klik) každé třídy zasahuje dokola (360°)** – je jedno, kam se postava dívá.
    Dosah se počítá od středu postavy. Směr smí hrát roli jen u dalších schopností (Q / E).
    **Základní útok postavu nezastavuje** – během něj jde dál chodit (v definici `roots: false`).
    Zastavit postavu smí jen schopnosti Q / E.
11. **Nerozbij hrdinu ani ostatní třídy.** Po změně vyzkoušej, že původní třídy fungují stejně jako dřív.

## Vyváženost (hrubé mantinely)

- Trvalé poškození základního útoku nemá být víc než zhruba **2× výkon hrdiny** (hrdina: 1 poškození
  na 0,3 s zblízka). Silnější schopnosti musí mít cooldown (doporučeno aspoň 5 s) nebo omezený dosah.
- Žádná schopnost nesmí zabít všechny nepřátele na mapě ani dát nezranitelnost bez cooldownu.
- Buffy se stackují: počítej s tím, že po ~10 levelech bude poškození i rychlost útoků výrazně vyšší.
  Nedělej schopnosti, které se se stackem Větší síla + Rychlejší útoky rozbijí (např. nekonečné řetězení).
- Stavy nepřátel (označení, omráčení, zpomalení) používej ze stávajících polí a funkcí
  (`markEnemy`, `stunUntil`, `slowUntil`), ať se chovají stejně u všech tříd.

## Kde všude je potřeba sáhnout (aktuální stav kódu)

Třída Fotograf je zatím v kódu na několika místech zadrátovaná natvrdo. Až bude třetí třída, **první, kdo ji přidává,
má nejdřív v samostatném PR (`refactor/tridy-obecne`) tyto místa zobecnit**, aby další třídy už byly jen o definici.
Do té doby je potřeba upravit:

**Sdílené**
- `public/shared/classes.js` – nová třída: `id`, `name`, `description`, `abilities` (slot `attack` / `q` / `e`,
  `frames`, `hitFrame`, `cooldown`, `damage`, dosahy…).

**Server (`server.js`)**
- `join` – ověření platné třídy (dnes `msg.cls === "photographer" ? … : "hero"`); přidej svoje `id`.
- Handler `attack` – větev podle třídy (základní útok); handler `ability` je dnes jen pro Fotografa.
- `startAbility` je obecné (čte `CLASSES[p.cls].abilities`), ale **`resolveAction` má větve podle jména schopnosti** –
  pro novou schopnost přidej větev a zranění vždy přes `hurtEnemy` (pravidlo 1).
- `state` – pole `cd` (cooldowny pro HUD) se dnes posílá jen Fotografovi.

**Klient (`public/game.js`, `public/index.html`)**
- Výběr třídy: karta v `#classes` v `index.html` + náhled `thumb-<id>`.
- Vykreslení postavy: dnes větev `p.cls === "photographer"` (sprity + animace podle `anim`, `animDir`, `animElapsed`).
- HUD: nápověda a cooldowny třídy; posun jména nad hlavou a výška kruhu štítu podle velikosti postavy.

**Sprity**
- Postava se kreslí **nearest-neighbor** (žádné vyhlazování), kotva je u **chodidel** a je ve všech snímcích na
  stejném místě (postava při změně animace neposkočí). Zdroje do `assets-src/<id>/`, hotové atlasy do
  `public/assets/<id>/`; nástroj `tools/build_photographer_atlas.py` je zatím jen pro Fotografa – zobecni ho nebo si
  udělej obdobný. Velikost ve hře nastavuje konstanta měřítka (viz `PHOTO_SCALE`), postava má mít zhruba
  výšku Fotografa (~20 px na mapě).

## Co před PR musí být ověřené (napiš do popisu PR)

Spusť hru a **se dvěma hráči (dvě záložky)** projdi:

- [ ] Třída se dá vybrat, hráč se objeví a hýbe se všemi 4 směry, animace sedí.
- [ ] Zabití nepřítele tvou třídou: **vypadne XP krystal**, skóre +1, po sebrání roste XP a level.
- [ ] Po postupu na level se objeví **výběr buffu** a po výběru **každý buff opravdu působí**
      na tvou třídu: ⚔️ poškození, ⚡ cooldowny (i tvých schopností), 👟 rychlost, 🛡️ štít blokuje zásah,
      ❤️ srdce navíc, 🧲 magnet.
- [ ] Základní útok zasáhne nepřítele ze všech stran (i za zády), mimo dosah nezasáhne.
- [ ] Cooldowny a zákaz spamování fungují, jeden zásah se nevyhodnotí dvakrát, směr je při útoku zamčený.
- [ ] Druhý hráč vidí animace a efekty tvé třídy.
- [ ] Hrdina a ostatní třídy fungují jako dřív.
- [ ] Všechna čísla třídy jsou v `classes.js` (nic natvrdo na dvou místech).
- [ ] `README.md` (tabulka tříd) a případně `AGENTS.md` jsou aktualizované.

PR s novou třídou musí mít tenhle checklist v popisu a schválit ho musí jiný člověk než autor
(a jeho AI agent), viz `AGENTS.md`.
