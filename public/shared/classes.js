// =============================================================
//  SDÍLENÉ DEFINICE CLASS – načítá server (require) i prohlížeč (<script>).
//  Je to jediné místo, kde jsou časování animací, cooldowny, dosahy a poškození,
//  aby server a klient nikdy nebyly rozjeté.
//
//  Čas v ms. "frames" = jak dlouho trvá který snímek animace útoku,
//  "hitFrame" = při kterém snímku se zásah opravdu projeví (počítá server).
// =============================================================
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CLASSES = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // Označený nepřítel (Fotograf): na 3 s dostává o 15 % větší poškození od kohokoliv.
  // Opakované označení jen obnoví čas, bonus se nesčítá.
  const MARK_MS = 3000;
  const MARK_BONUS = 1.15;

  return {
    MARK_MS,
    MARK_BONUS,

    hero: {
      id: "hero",
      name: "Hrdina",
      description: "Meč, který zabere na blízko",
      // Hrdina používá původní útok (Mezerník / klik), bez schopností.
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
          frames: [70, 60, 110], // příprava, záblesk, návrat
          hitFrame: 1,
          cooldown: 450,
          damage: 0.6,
          range: 38, // dosah kužele (px na mapě)
          minDot: 0.7, // šířka kužele (cos úhlu) ≈ ±45°
        },
        // Silný blesk – široký prostor před fotografem, omráčí a zpomalí
        strong_flash: {
          slot: "q",
          label: "Silný blesk",
          frames: [100, 70, 130], // nabíjení, blesk, doznívání
          hitFrame: 1,
          cooldown: 7000,
          damage: 0.3,
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
          length: 90, // délka paprsku (px na mapě)
          halfWidth: 9,
        },
      },
    },
  };
});
