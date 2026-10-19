// =============================================================
//  BOSS ADAM – sdílené definice (načítá server přes require i prohlížeč přes <script>).
//  Všechna čísla souboje jsou tady, aby se dala snadno ladit:
//  životy, poškození, cooldowny, délky telegraphů, rychlosti projektilů, životnost zón.
//  Časy v ms, vzdálenosti v pixelech na mapě (mapa má 800 × 560).
// =============================================================
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ADAM = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  return {
    name: "Adam — AI & Gym Overlord",

    // Kdy se boss objeví: po tolika sekundách hry (počítá se jen, když je ve hře aspoň jeden hráč).
    // 0 = hned na začátku, 300 = po pěti minutách. Když se boss objeví, běžní nepřátelé zmizí
    // a nové se objevují, až když je boss poražen.
    spawnAfterSec: 300,

    // Boss stojí na jednom místě: střed mapy + tenhle posun
    offset: { x: 0, y: -70 },

    baseHp: 160, // pro jednoho hráče cca 60–90 s souboje
    hpPerExtraPlayer: 0.65, // maxHp = baseHp * (1 + 0.65 * (hráčů - 1))
    size: 22, // pro výpočet dosahu zásahů hráčů (stejně jako u slizů)
    bodyRadius: 16, // kolizní tělo (hráči a nepřátelé do něj nemůžou vlézt)
    xp: 80, // XP krystal po porážce

    // Fáze podle zbývajících životů
    phaseFromRatio: [0.6, 0.25], // pod 60 % začíná fáze 2, pod 25 % fáze 3
    phaseNames: ["Fáze 1: AI specialista", "Fáze 2: Gym mód", "Fáze 3: Overclock"],
    phaseChangeMs: 900, // neškodné zablikání při přechodu do další fáze
    attackIntervalMs: [
      [2500, 3500],
      [2000, 3000],
      [2000, 3000],
    ], // pauza mezi útoky v 1., 2., 3. fázi
    phase3Speed: 0.85, // ve 3. fázi trvají animace a telegraphy o 15 % kratší
    defeatedLingerMs: 6000, // jak dlouho po porážce boss ještě stojí (klidový stav)

    attacks: {
      // 1) Neural Network – datový projektil na pozici hráče + neuronová past
      neural: {
        frames: [160, 220, 180], // boss: příprava, aktivní síť, návrat
        fireFrame: 1, // ve kterém snímku bosse se projektil vystřelí
        origin: { x: -14, y: -30 }, // odkud projektil vylétá (od chodidel bosse)
        spawnMs: 90, // VFX snímek 0 (vznik) trvá tak dlouho
        speed: 170, // rychlost projektilu (px/s)
        flightMinMs: 500, // let trvá aspoň tolik (telegraph: značka dopadu je vidět celou dobu)
        flightMaxMs: 1500,
        maxRange: 300,
        hitRadius: 8, // zásah letícího projektilu
        damage: 1,
        impactRadius: 18, // výbuch při dopadu
        impactMs: 110, // VFX snímek 2
        zone: { radius: 24, lifeMs: 3000, slow: 0.5, tickMs: 1500, tickDamage: 1, graceMs: 600 },
      },

      // 2) Barbell Shockwave – varovný kruh, pak expandující prstenec kolem bosse
      barbell: {
        telegraphMs: 650, // varovný kruh před animací
        frames: [220, 260, 180], // boss: činka u těla, nad hlavou, dopad
        impactFrame: 2,
        flashMs: 80, // VFX snímek 1 (centrální náraz)
        expandMs: 200, // VFX snímek 2 (expandující prstenec = hlavní damage)
        decayMs: 180, // VFX snímek 3
        radius: 96, // vodorovný poloměr prstence (px)
        aspect: 0.4, // svislý poloměr = radius * aspect (sprite je kreslený jako elipsa)
        thickness: 0.15, // tloušťka prstence (podíl poloměru)
        damage: 1,
        knockback: 30,
      },

      // 3) Overclock Cables – 2–4 výboje do různých směrů (jen 3. fáze)
      overclock: {
        frames: [230, 300, 180], // boss: aktivace, nabíjení (telegraph), výboj
        fireFrame: 2,
        shots: [2, 4], // kolik výbojů (min, max)
        staggerMs: 130, // odstup mezi výstřely
        spawnMs: 80,
        speed: 300,
        maxRange: 300,
        hitRadius: 9,
        damage: 2, // přímý zásah (vyšší poškození)
        impactRadius: 16,
        impactDamage: 1,
        impactMs: 100,
        lineWidth: 24, // šířka varovného pruhu na zemi (= 2 × (hitRadius + 3), tedy přesně dráha výboje)
        zone: { rx: 24, ry: 14, lifeMs: 2500, slow: 0.6 },
      },
    },

    // Kreslení: měřítko (pixely mapy na jeden pixel obrázku) – jen vzhled
    bob: { amplitude: 1.3, periodMs: 1700 }, // lehké pohupování bosse (px mapy, ms)
    scale: { boss: 0.11, neural: 0.11, barbell: 0.33, overclock: 0.11 },

    // Rozměry buněk a kotvy snímků jsou v public/assets/adam/atlas.json
    // (vyrábí je tools/build_adam_atlas.py ze zdrojových sheetů v assets-src/adam/)
  };
});
