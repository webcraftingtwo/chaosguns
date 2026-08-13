/* ============================================================
   seed.js — deterministic operator identity derivation
   ------------------------------------------------------------
   Pure functions only. The callsign is hashed (SHA-256 via
   crypto.subtle, with a documented deterministic fallback for
   non-secure contexts like file://) and every visual trait of
   the operator is derived from those bytes. Same callsign →
   identical dossier, every time, nothing stored.
   ============================================================ */

'use strict';

/* ---- insignia set — simple stroke-based military marks (no emoji) ---- */
const INSIGNIA_SET = [
  { name: 'DELTA',     svg: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><path d="M24 7 L42 39 H6 Z"/><path d="M17 30 H31"/><path d="M24 15 V24"/></svg>' },
  { name: 'RETICLE',   svg: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><circle cx="24" cy="24" r="12"/><path d="M24 4 V14 M24 34 V44 M4 24 H14 M34 24 H44"/><circle cx="24" cy="24" r="1.5" fill="currentColor"/></svg>' },
  { name: 'CHEVRON',   svg: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 16 L24 8 L38 16"/><path d="M10 26 L24 18 L38 26"/><path d="M10 36 L24 28 L38 36"/></svg>' },
  { name: 'LOZENGE',   svg: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><path d="M24 5 L43 24 L24 43 L5 24 Z"/><path d="M24 14 V34"/><path d="M15 24 H33"/></svg>' },
  { name: 'SPIRE',     svg: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><path d="M24 5 L30 20 L24 43 L18 20 Z"/><path d="M8 30 L18 24"/><path d="M40 30 L30 24"/></svg>' },
  { name: 'BASTION',   svg: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><path d="M24 5 L41 14 V28 C41 36 33 41 24 44 C15 41 7 36 7 28 V14 Z"/><path d="M24 16 L31 28 H17 Z"/></svg>' },
  { name: 'VECTOR',    svg: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><path d="M24 44 V12"/><path d="M13 23 L24 8 L35 23"/><path d="M13 34 L24 24 L35 34"/></svg>' },
  { name: 'MERIDIAN',  svg: '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2"><circle cx="24" cy="24" r="17"/><path d="M7 24 H41"/><path d="M24 7 C31 15 31 33 24 41"/><path d="M24 7 C17 15 17 33 24 41"/></svg>' },
];

/* ---- hashing -------------------------------------------------------- */

/**
 * SHA-256 over the normalized callsign. Returns 32 bytes.
 * Fallback: iterated 32-bit FNV-1a (deterministic, documented) — only
 * used where crypto.subtle is unavailable (e.g. plain file:// in some
 * browsers). Both paths are stable across visits and machines.
 */
async function seedBytesFor(callsign) {
  const normalized = String(callsign).trim().toLowerCase();
  if (globalThis.crypto && crypto.subtle) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(normalized)
    );
    return new Uint8Array(digest);
  }
  return fnv1aBytes(normalized);
}

/** Deterministic fallback: 32 bytes from FNV-1a with per-round tweaks. */
function fnv1aBytes(str) {
  const out = new Uint8Array(32);
  for (let round = 0; round < 8; round++) {
    let h = (0x811c9dc5 ^ (round * 0x9e3779b9)) >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out[round * 4 + 0] = (h >>> 24) & 0xff;
    out[round * 4 + 1] = (h >>> 16) & 0xff;
    out[round * 4 + 2] = (h >>> 8) & 0xff;
    out[round * 4 + 3] = h & 0xff;
  }
  return out;
}

/* ---- derivations ----------------------------------------------------- */

/** Map hash → hue 0–359. One seeded accent themes the whole dossier. */
function hueFromBytes(bytes) {
  return ((bytes[0] << 8) | bytes[1]) % 360;
}

/** Stable formatted operator code, e.g. OP-7F3A-22. */
function operatorIdFromBytes(bytes) {
  const hex = [bytes[2], bytes[3]]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  const suffix = String((bytes[4] % 90) + 10); // always two digits, 10–99
  return `OP-${hex}-${suffix}`;
}

/** Pick one insignia from the set. */
function insigniaFromBytes(bytes) {
  return INSIGNIA_SET[bytes[5] % INSIGNIA_SET.length];
}

/**
 * Stable per-operator numbers used by the clearance teasers, so the
 * "concrete number" in each redacted line is real and never shifts
 * between visits.
 */
function teaserNumbersFromBytes(bytes) {
  return {
    extractionRoutes: 9 + (bytes[6] % 15),   //  9–23
    sightlines:       4 + (bytes[7] % 9),    //  4–12
    lootPatterns:     14 + (bytes[8] % 27),  // 14–40
    vaultFiles:       5 + (bytes[9] % 7),    //  5–11
  };
}

/** Full identity seed for a callsign. */
async function deriveSeed(callsign) {
  const bytes = await seedBytesFor(callsign);
  return {
    hue: hueFromBytes(bytes),
    operatorId: operatorIdFromBytes(bytes),
    insignia: insigniaFromBytes(bytes),
    teasers: teaserNumbersFromBytes(bytes),
  };
}

/** SHA-256 hex of arbitrary text (used by the data layer for secrets). */
async function sha256Hex(text) {
  if (globalThis.crypto && crypto.subtle) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(text)
    );
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return Array.from(fnv1aBytes(text))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
