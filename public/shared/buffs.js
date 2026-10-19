// =============================================================
//  SDÍLENÉ DEFINICE BUFFŮ A XP – načítá server (require) i prohlížeč (<script>).
//  Za sebrané XP hráč postoupí o level a vybere si jeden ze 3 náhodných buffů.
//  Buffy se stackují až do "max". Čísla efektů jsou tady, aby je server i klient
//  měly stejná.
// =============================================================
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BUFFS = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const LIST = [
    { id: "heart", icon: "❤️", name: "Srdce navíc", desc: "+1 max. život a hned se doplní", max: 5 },
    { id: "damage", icon: "⚔️", name: "Větší síla", desc: "+30 % poškození", max: 5 },
    { id: "speed", icon: "👟", name: "Rychlé nohy", desc: "+12 % rychlost pohybu", max: 4 },
    { id: "shield", icon: "🛡️", name: "Štít", desc: "Zablokuje 1 zásah, dobije se za 10 s", max: 3 },
    { id: "haste", icon: "⚡", name: "Rychlejší útoky", desc: "-20 % cooldowny", max: 3 },
    { id: "magnet", icon: "🧲", name: "Magnet", desc: "+50 % dosah sbírání", max: 3 },
    { id: "regen", icon: "💚", name: "Regenerace", desc: "+1 život každých ~20 s (s dalšími buffy rychleji)", max: 3 },
  ];

  return {
    LIST,
    byId: Object.fromEntries(LIST.map((b) => [b.id, b])),

    MAX_LEVEL: 20,
    // kolik XP je potřeba na další level: 5, 9, 13, 17, ...
    xpForNext: (level) => 5 + 4 * (level - 1),

    // efekty podle počtu nasbíraných buffů (b = { damage: 2, speed: 1, ... })
    damageMult: (b) => 1 + 0.3 * (b.damage || 0),
    speedMult: (b) => 1 + 0.12 * (b.speed || 0),
    cooldownMult: (b) => Math.pow(0.8, b.haste || 0),
    pickupMult: (b) => 1 + 0.5 * (b.magnet || 0),
    SHIELD_RECHARGE_MS: 10000,
    regenIntervalMs: (stacks) => 24000 - 4000 * stacks, // 20 s, 16 s, 12 s
  };
});
