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

## Jak přidat třídu (kód je obecný, žádné „if Fotograf“)

Server i klient si třídy najdou samy podle `public/shared/classes.js`. Nová třída = tyhle kroky:

1. **`public/shared/classes.js`** – nová položka s `id`, `name`, `description` a `abilities`. Každá schopnost má
   `slot` (`attack` = Mezerník / klik, `q`, `e`), `label`, `frames` (ms na snímek), `hitFrame`, `cooldown`, `damage`,
   `roots` (stojí postava při animaci?) a tvar zásahu `shape`: `"cone"` (`range` + `minDot`, `minDot: -1` = dokola 360°)
   nebo `"beam"` (`length` + `halfWidth`). Efekty: `marks` (označí), `stunMs` / `slowMs` / `slowFactor`.
   Třída bez schopnosti na slotu `attack` musí mít objekt `attack` jako Hrdina (úder bez animace).
2. **Sprity** – atlas do `public/assets/<id>/atlas.json` + PNG, zdroje do `assets-src/<id>/`. Formát:
   `sheets.walk` a jeden sheet pro každou schopnost (stejný název jako v `abilities`); řádky = směry dolů, vlevo,
   vpravo, nahoru; `cellW`, `cellH`, `anchorX`, `anchorY` (střed chodidel – stejný ve všech snímcích, takže postava
   neposkakuje); volitelně `counts` (počet snímků v řádku) a `scale` (měřítko jen pro ten sheet). Kreslí se
   **nearest-neighbor**. Postava má být ve hře zhruba 20 px vysoká. Vzor nástroje: `tools/build_photographer_atlas.py`.
3. **`public/game.js`** – řádek v `CLASS_VIEW` (`sprites: true`, `scale`, výška jména `labelY`, kruh štítu `ringY` / `ringR`).
4. **`public/index.html`** – karta v `#classes` (`value` = `id`) s náhledem `<canvas id="thumb-<id>">`.

Server (`abilityForSlot`, `startAbility`, `resolveAction`, cooldowny ve `state`), HUD (ovládání a cooldowny) i
vykreslení animací fungují pro novou třídu bez dalších úprav. Když schopnost potřebuje něco, co tvary a efekty výš
neumí (projektil, past…), přidej to obecně do `resolveAction` (zranění vždy přes `hurtEnemy`) a popiš v PR.

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
