// =============================================================
//  SDÍLENÉ DEFINICE CLASS – načítá server (require) i prohlížeč (<script>).
//  Je to jediné místo, kde jsou časování animací, cooldowny, dosahy a poškození,
//  aby server a klient nikdy nebyly rozjeté.
//
//  Čas v ms. "frames" = jak dlouho trvá který snímek animace útoku,
//  "hitFrame" = při kterém snímku se zásah opravdu projeví (počítá server).
//  "roots" = false: postava se může při animaci pohybovat (základní útoky); jinak stojí.
//  "slot" = klávesa: "attack" (Mezerník / klik), "q", "e".
//  "shape" = tvar zásahu: "cone" (dosah "range" + úhel "minDot"; minDot -1 = dokola 360°)
//            nebo "beam" (paprsek "length" × "halfWidth" ve směru postavy).
//  Efekty: "marks" = označí zasažené, "stunMs"/"slowMs"/"slowFactor" = omráčí a zpomalí.
//  Novou třídu přidáš jako další položku s "id" – server i klient si ji najdou samy (viz CLASSES.md).
// =============================================================
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CLASSES = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // Označený nepřítel (Fotograf): na 3 s dostává o 15 % větší poškození od kohokoliv.
  // Opakované označení jen obnoví čas, bonus se nesčítá.
  const MARK_MS = 3000;
  const MARK_BONUS = 1.15;

  const defs = {
    MARK_MS,
    MARK_BONUS,

    hero: {
      id: "hero",
      name: "Hrdina",
      description: "Meč, který zabere na blízko",
      // Základní útok (Mezerník / klik): zasáhne všechny nepřátele kolem postavy dokola (360°),
      // je jedno, kam se hrdina dívá.
      attack: {
        label: "Úder",
        cooldown: 300, // ms
        damage: 1,
        range: 34, // dosah od středu postavy (px na mapě), + půlka velikosti nepřítele
        knockback: true,
      },
      // Hrdina nemá žádné další schopnosti.
      abilities: {},
    },

    photographer: {
      id: "photographer",
      name: "Fotograf",
      description: "Označuje cíle, oslepuje a střílí paprskem",
      // Schopnosti: "attack" = Mezerník / klik, "q" = klávesa Q, "e" = klávesa E
      abilities: {
        // Momentka – krátký kužel před postavou, označí zasažené
        snapshot: {
          slot: "attack",
          label: "Momentka",
          roots: false, // základní útok postavu nezastavuje, jde dál chodit
          frames: [70, 60, 110], // příprava, záblesk, návrat
          hitFrame: 1,
          cooldown: 450,
          damage: 0.6,
          shape: "cone",
          range: 38, // dosah (px na mapě)
          minDot: -1, // -1 = zasáhne dokola (360°), je jedno, kam se Fotograf dívá
          marks: true,
        },
        // Silný blesk – široký prostor před fotografem, omráčí a zpomalí
        strong_flash: {
          slot: "q",
          label: "Silný blesk",
          frames: [100, 70, 130], // nabíjení, blesk, doznívání
          hitFrame: 1,
          cooldown: 7000,
          damage: 0.3,
          shape: "cone",
          range: 52,
          minDot: 0.15, // ≈ ±80°, tedy téměř celá polovina před postavou
          stunMs: 1000,
          slowMs: 3000, // po omráčení ještě tolik ms zpomalení
          slowFactor: 0.5,
        },
        // Perfektní záběr – dlouhý úzký paprsek, zasáhne všechny v řadě a označí je
        perfect_shot: {
          slot: "e",
          label: "Perfektní záběr",
          frames: [180, 140, 170], // zaměření, uzamčení, paprsek
          hitFrame: 2,
          cooldown: 14000,
          damage: 2.5,
          shape: "beam",
          length: 90, // délka paprsku (px na mapě)
          halfWidth: 9,
          marks: true,
        },
      },
    },

    dragon: {
      id: "dragon",
      name: "Drak",
      description: "Drápy dokola, ohnivý dech před sebe",
      abilities: {
        // Drápy – základní útok dokola (360°), postava jde dál
        claw: {
          slot: "attack",
          label: "Drápy",
          roots: false,
          frames: [70, 80, 80, 90], // nápřah, sek, sek, návrat
          hitFrame: 2,
          cooldown: 400,
          damage: 1,
          shape: "cone",
          range: 32,
          minDot: -1, // dokola (360°)
        },
        // Ohnivý dech – kužel ohně před drakem, drak při něm stojí
        fire_breath: {
          slot: "q",
          label: "Ohnivý dech",
          frames: [150, 300, 200], // nádech, oheň, doznění
          hitFrame: 1,
          cooldown: 6000,
          damage: 2,
          shape: "cone",
          range: 42, // zhruba tak daleko, jak sahá nakreslený oheň
          minDot: 0.6, // ≈ ±53° před drakem
        },
      },
    },
  };
  // seznam tříd (všechno, co má "id"), v pořadí, v jakém jsou výše
  defs.ids = Object.values(defs).filter((v) => v && typeof v === "object" && v.id).map((v) => v.id);
  return defs;
});
