/* ============================================================
   weapons.js — armory vocabulary + blueprint silhouettes.
   ------------------------------------------------------------
   Silhouettes are ORIGINAL schematic outlines drawn per weapon
   CLASS (rifle / smg / marksman / support / shotgun), not traced
   game art — a dossier would hold a technical outline, not a
   render. Every weapon of a class shares its archetype outline;
   the name, class and slot layout are what identify the build.

   All of this is data: add a weapon, rename one, or re-point an
   attachment list here and nothing else has to change — the
   database stores only { weapon, slots } and validates shape.
   ============================================================ */

'use strict';

/* ---- attachment vocabularies, by slot ---- */
const ATTACHMENTS = {
  OPTIC:     ['IRON SIGHTS', 'RED DOT', 'HOLOGRAPHIC', '2X ACOG', '3X PRISM', '4X SCOPE', '6X SCOPE', 'THERMAL'],
  MUZZLE:    ['NONE', 'COMPENSATOR', 'FLASH HIDER', 'MUZZLE BRAKE', 'SUPPRESSOR', 'HEAVY SUPPRESSOR'],
  BARREL:    ['STANDARD', 'SHORT', 'HEAVY', 'LONG', 'MARKSMAN', 'REINFORCED'],
  HANDGUARD: ['STANDARD', 'VERTICAL GRIP', 'ANGLED GRIP', 'BIPOD', 'LASER', 'LIGHTWEIGHT RAIL'],
  MAGAZINE:  ['STANDARD', 'EXTENDED', 'DRUM', 'QUICKDRAW', 'ARMOR PIERCING', 'SUBSONIC'],
  AMMO:      ['BUCKSHOT', 'FLECHETTE', 'SLUG', 'MAGNUM BUCKSHOT'],
  STOCK:     ['STANDARD', 'LIGHTWEIGHT', 'HEAVY', 'COLLAPSED', 'NO STOCK', 'PRECISION'],
};

/* ---- archetype outlines + slot anchor points (viewBox units) ---- */
const WEAPON_ARCHETYPES = {
  RIFLE: {
    viewBox: '0 0 400 130',
    slots: [
      { key: 'OPTIC',     at: [146, 26] },
      { key: 'MUZZLE',    at: [363, 40] },
      { key: 'BARREL',    at: [324, 44] },
      { key: 'HANDGUARD', at: [251, 78] },
      { key: 'MAGAZINE',  at: [176, 116] },
      { key: 'STOCK',     at: [31, 38] },
    ],
    paths: `
      <path d="M14,50 L48,46 L48,74 L14,78 Z"/>
      <path d="M48,54 L84,54 L84,68 L48,68 Z"/>
      <path d="M84,42 L206,42 L206,74 L84,74 Z"/>
      <path d="M96,34 L196,34 L196,42 L96,42 Z"/>
      <path d="M206,46 L296,46 L296,68 L206,68 Z"/>
      <path d="M296,52 L352,52 L352,60 L296,60 Z"/>
      <path d="M352,48 L374,48 L374,64 L352,64 Z"/>
      <path d="M148,74 L184,74 L194,110 L158,110 Z"/>
      <path d="M104,74 L130,74 L120,108 L94,108 Z"/>
      <path d="M130,78 Q142,96 152,84" fill="none"/>
      <path d="M214,50 L288,50" opacity="0.4"/>
      <path d="M214,64 L288,64" opacity="0.4"/>
    `,
  },

  SMG: {
    viewBox: '0 0 320 130',
    slots: [
      { key: 'OPTIC',     at: [110, 28] },
      { key: 'MUZZLE',    at: [282, 42] },
      { key: 'HANDGUARD', at: [203, 76] },
      { key: 'MAGAZINE',  at: [142, 122] },
      { key: 'STOCK',     at: [30, 44] },
    ],
    paths: `
      <path d="M22,54 L52,52 L52,70 L22,72 Z"/>
      <path d="M52,44 L170,44 L170,74 L52,74 Z"/>
      <path d="M64,36 L158,36 L158,44 L64,44 Z"/>
      <path d="M170,50 L236,50 L236,68 L170,68 Z"/>
      <path d="M236,54 L272,54 L272,62 L236,62 Z"/>
      <path d="M272,50 L292,50 L292,66 L272,66 Z"/>
      <path d="M120,74 L152,74 L158,116 L126,116 Z"/>
      <path d="M78,74 L102,74 L94,106 L70,106 Z"/>
      <path d="M102,78 Q114,94 122,84" fill="none"/>
      <path d="M178,54 L228,54" opacity="0.4"/>
      <path d="M178,64 L228,64" opacity="0.4"/>
    `,
  },

  MARKSMAN: {
    viewBox: '0 0 400 130',
    slots: [
      { key: 'OPTIC',     at: [136, 26] },
      { key: 'MUZZLE',    at: [361, 38] },
      { key: 'BARREL',    at: [280, 42] },
      { key: 'HANDGUARD', at: [232, 74] },
      { key: 'MAGAZINE',  at: [163, 110] },
      { key: 'STOCK',     at: [30, 92] },
    ],
    paths: `
      <path d="M10,48 L60,44 L60,80 L10,84 Z"/>
      <path d="M40,36 L76,34 L76,46 L40,48 Z"/>
      <path d="M74,44 L196,44 L196,72 L74,72 Z"/>
      <path d="M86,34 L186,34 L186,44 L86,44 Z"/>
      <path d="M196,50 L344,50 L344,60 L196,60 Z"/>
      <path d="M344,46 L378,46 L378,64 L344,64 Z"/>
      <path d="M144,72 L172,72 L178,102 L150,102 Z"/>
      <path d="M96,72 L120,72 L112,104 L88,104 Z"/>
      <path d="M120,76 Q132,92 142,82" fill="none"/>
      <path d="M300,60 L292,92 M300,60 L312,92" fill="none"/>
      <path d="M204,55 L336,55" opacity="0.35"/>
    `,
  },

  SUPPORT: {
    viewBox: '0 0 400 140',
    slots: [
      { key: 'OPTIC',     at: [126, 24] },
      { key: 'MUZZLE',    at: [345, 36] },
      { key: 'BARREL',    at: [268, 40] },
      { key: 'HANDGUARD', at: [292, 112] },
      { key: 'MAGAZINE',  at: [153, 128] },
      { key: 'STOCK',     at: [30, 40] },
    ],
    paths: `
      <path d="M14,50 L52,46 L52,74 L14,78 Z"/>
      <path d="M52,40 L200,40 L200,78 L52,78 Z"/>
      <path d="M66,32 L188,32 L188,40 L66,40 Z"/>
      <path d="M200,48 L330,48 L330,62 L200,62 Z"/>
      <path d="M330,44 L360,44 L360,66 L330,66 Z"/>
      <path d="M120,78 L186,78 L186,120 L120,120 Z"/>
      <path d="M78,78 L104,78 L96,110 L72,110 Z"/>
      <path d="M104,82 Q116,98 124,88" fill="none"/>
      <path d="M290,62 L280,106 M290,62 L302,106" fill="none"/>
      <path d="M208,52 L322,52" opacity="0.35"/>
      <path d="M208,58 L322,58" opacity="0.35"/>
      <path d="M128,86 L178,86 M128,98 L178,98 M128,110 L178,110" opacity="0.4"/>
    `,
  },

  SHOTGUN: {
    viewBox: '0 0 380 130',
    slots: [
      { key: 'OPTIC',     at: [104, 30] },
      { key: 'MUZZLE',    at: [336, 38] },
      { key: 'BARREL',    at: [268, 40] },
      { key: 'HANDGUARD', at: [237, 90] },
      { key: 'AMMO',      at: [180, 84] },
      { key: 'STOCK',     at: [28, 38] },
    ],
    paths: `
      <path d="M12,48 L58,44 L58,76 L12,80 Z"/>
      <path d="M58,46 L150,46 L150,74 L58,74 Z"/>
      <path d="M70,38 L138,38 L138,46 L70,46 Z"/>
      <path d="M150,48 L340,48 L340,58 L150,58 Z"/>
      <path d="M150,62 L326,62 L326,72 L150,72 Z"/>
      <path d="M212,60 L262,60 L262,80 L212,80 Z"/>
      <path d="M84,74 L108,74 L100,104 L76,104 Z"/>
      <path d="M108,78 Q120,94 130,84" fill="none"/>
      <path d="M330,42 L336,48" fill="none"/>
      <path d="M218,64 L256,64 M218,70 L256,70" opacity="0.4"/>
    `,
  },
};

/* ---- the armory. Names are Delta Force weapons; the outline is
   the class archetype. Edit freely — nothing downstream cares. ---- */
const WEAPONS = [
  { name: 'M4A1',     archetype: 'RIFLE',    family: 'ASSAULT RIFLE' },
  { name: 'K416',     archetype: 'RIFLE',    family: 'ASSAULT RIFLE' },
  { name: 'AK-12',    archetype: 'RIFLE',    family: 'ASSAULT RIFLE' },
  { name: 'QBZ-95-1', archetype: 'RIFLE',    family: 'ASSAULT RIFLE' },
  { name: 'SCAR-H',   archetype: 'RIFLE',    family: 'BATTLE RIFLE' },
  { name: 'AUG',      archetype: 'RIFLE',    family: 'ASSAULT RIFLE' },
  { name: 'CI-19',    archetype: 'RIFLE',    family: 'ASSAULT RIFLE' },
  { name: 'SMG-45',   archetype: 'SMG',      family: 'SUBMACHINE GUN' },
  { name: 'MP5',      archetype: 'SMG',      family: 'SUBMACHINE GUN' },
  { name: 'MP7',      archetype: 'SMG',      family: 'SUBMACHINE GUN' },
  { name: 'VECTOR',   archetype: 'SMG',      family: 'SUBMACHINE GUN' },
  { name: 'AS VAL',   archetype: 'SMG',      family: 'SUPPRESSED CARBINE' },
  { name: 'SR-3M',    archetype: 'SMG',      family: 'SUPPRESSED CARBINE' },
  { name: 'SR-25',    archetype: 'MARKSMAN', family: 'MARKSMAN RIFLE' },
  { name: 'M14',      archetype: 'MARKSMAN', family: 'MARKSMAN RIFLE' },
  { name: 'M700',     archetype: 'MARKSMAN', family: 'SNIPER RIFLE' },
  { name: 'AWM',      archetype: 'MARKSMAN', family: 'SNIPER RIFLE' },
  { name: 'M250',     archetype: 'SUPPORT',  family: 'LIGHT MACHINE GUN' },
  { name: 'PKM',      archetype: 'SUPPORT',  family: 'LIGHT MACHINE GUN' },
  { name: 'M870',     archetype: 'SHOTGUN',  family: 'SHOTGUN' },
  { name: 'S12K',     archetype: 'SHOTGUN',  family: 'SHOTGUN' },
];

function weaponByName(name) {
  return WEAPONS.find((w) => w.name === name) || null;
}

/** Archetype for a weapon name, falling back to RIFLE for unknowns. */
function archetypeFor(name) {
  const w = weaponByName(name);
  return WEAPON_ARCHETYPES[w ? w.archetype : 'RIFLE'];
}
