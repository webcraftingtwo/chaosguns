/* ============================================================
   inteldb.js — the DATA LAYER. All persistence lives here.
   ------------------------------------------------------------
   The UI never talks to storage (or, later, Supabase) directly —
   it only calls the async methods on `intelDB`.

   NOW:   mock implementation on localStorage.
   LATER: Supabase (auth + Postgres with row-level security
          enforcing clearance). Each method below carries a
          `SUPABASE SEAM` comment showing where the real call
          drops in. Swapping backends must not touch the UI.

   Identity model is callsign + passphrase — no email, ever.
   Passphrases and extraction ciphers are never stored in the
   clear, only as SHA-256 digests (mock-grade; real hashing is
   Supabase's job at the seam).
   ============================================================ */

'use strict';

const intelDB = (() => {
  const DB_KEY = 'deaddrop.db.v1';
  const SESSION_KEY = 'deaddrop.session.v1';

  /* ---- clearance ladder definition (shared by mock + real) ---- */
  const TIERS = ['RESTRICTED', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET', 'COMPARTMENTED'];
  // Verified files required to unlock each tier above RESTRICTED.
  const TIER_REQUIREMENTS = [0, 3, 8, 20, 50];

  const CLASSES = ['RECON', 'ENGINEER', 'ASSAULT', 'MEDIC'];

  /* ---- mock store helpers ---- */
  function loadDB() {
    try {
      return JSON.parse(localStorage.getItem(DB_KEY)) || { operators: {} };
    } catch {
      return { operators: {} };
    }
  }
  function saveDB(db) {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  }

  function normalizeCallsign(callsign) {
    return String(callsign).trim().toLowerCase();
  }

  async function passDigest(callsign, passphrase) {
    return sha256Hex(`${normalizeCallsign(callsign)}::${passphrase}`);
  }
  async function cipherDigest(callsign, cipher) {
    return sha256Hex(`${normalizeCallsign(callsign)}##${cipher.replace(/\s+/g, '').toUpperCase()}`);
  }

  /** One-time recovery code, e.g. DD-K4T7-9XWM-P2RC (no ambiguous chars). */
  function generateCipher() {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const raw = new Uint8Array(12);
    (globalThis.crypto?.getRandomValues)
      ? crypto.getRandomValues(raw)
      : raw.forEach((_, i) => (raw[i] = Math.floor(Math.random() * 256)));
    const chars = Array.from(raw, (b) => alphabet[b % alphabet.length]);
    return `DD-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
  }

  function newRecordId() {
    return globalThis.crypto?.randomUUID
      ? crypto.randomUUID()
      : `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /* ---- public dossier shape (what the UI is allowed to see) ---- */
  function toDossier(record) {
    const contributions = record.contributions || {};
    const total = CLASSES.reduce((sum, c) => sum + (contributions[c] || 0), 0);

    // Specialization is EMERGENT — computed from contribution mix,
    // never chosen. No contributions yet → PENDING (a climb hook,
    // not a gap to fill with a random assignment).
    let specialization = null;
    if (total > 0) {
      const ranked = [...CLASSES].sort(
        (a, b) => (contributions[b] || 0) - (contributions[a] || 0)
      );
      specialization = { primary: ranked[0], secondary: ranked[1] };
    }

    const clearanceIndex = record.clearanceIndex || 0;
    const nextRequirement = TIER_REQUIREMENTS[clearanceIndex + 1] ?? null;

    return {
      id: record.id,
      callsign: record.callsign,
      enlistedAt: record.enlistedAt,
      clearanceIndex,
      clearance: TIERS[clearanceIndex],
      verifiedCount: record.verifiedCount || 0,
      nextTier: TIERS[clearanceIndex + 1] || null,
      nextRequirement,
      contributions,
      specialization,
    };
  }

  /* ============================================================
     PUBLIC API — every method async, ready for the network hop.
     ============================================================ */
  return {
    TIERS,
    TIER_REQUIREMENTS,
    CLASSES,

    /**
     * ENLIST — create a new operator. Returns the one-time
     * extraction cipher exactly once; only its digest is kept.
     *
     * SUPABASE SEAM: becomes supabase.auth.signUp with a synthetic
     * `${callsign}@ops.local` identity (callsign stays the only
     * user-visible handle) + an `operators` row insert. Cipher hash
     * stored in the row; RLS: operators can read only themselves.
     */
    async enlistOperator(callsign, passphrase) {
      const db = loadDB();
      const key = normalizeCallsign(callsign);
      if (db.operators[key]) {
        return { ok: false, code: 'CALLSIGN_IN_SERVICE' };
      }
      const cipher = generateCipher();
      const record = {
        id: newRecordId(),
        callsign: String(callsign).trim(),
        passHash: await passDigest(callsign, passphrase),
        cipherHash: await cipherDigest(callsign, cipher),
        enlistedAt: Date.now(),
        clearanceIndex: 0,
        verifiedCount: 0,
        contributions: { RECON: 0, ENGINEER: 0, ASSAULT: 0, MEDIC: 0 },
      };
      db.operators[key] = record;
      saveDB(db);
      return { ok: true, dossier: toDossier(record), cipher };
    },

    /**
     * AUTHENTICATE — returning operator.
     *
     * SUPABASE SEAM: becomes supabase.auth.signInWithPassword on the
     * synthetic identity, then a select on `operators`.
     */
    async authenticate(callsign, passphrase) {
      const db = loadDB();
      const record = db.operators[normalizeCallsign(callsign)];
      if (!record) return { ok: false, code: 'CALLSIGN_NOT_ON_FILE' };
      const digest = await passDigest(callsign, passphrase);
      if (digest !== record.passHash) {
        return { ok: false, code: 'CREDENTIALS_REJECTED' };
      }
      return { ok: true, dossier: toDossier(record) };
    },

    /**
     * RECOVER — extraction cipher is the ONLY recovery path.
     * Burns the old cipher and issues a fresh one.
     *
     * SUPABASE SEAM: an edge function that verifies the cipher hash
     * and resets the auth password server-side.
     */
    async recoverWithCipher(callsign, cipher, newPassphrase) {
      const db = loadDB();
      const record = db.operators[normalizeCallsign(callsign)];
      if (!record) return { ok: false, code: 'CALLSIGN_NOT_ON_FILE' };
      const digest = await cipherDigest(callsign, cipher);
      if (digest !== record.cipherHash) {
        return { ok: false, code: 'CIPHER_REJECTED' };
      }
      const freshCipher = generateCipher();
      record.passHash = await passDigest(callsign, newPassphrase);
      record.cipherHash = await cipherDigest(callsign, freshCipher);
      saveDB(db);
      return { ok: true, dossier: toDossier(record), cipher: freshCipher };
    },

    /**
     * DOSSIER — full personal record for the dossier panel.
     *
     * SUPABASE SEAM: select from `operators` + aggregate over
     * `intel_files` (contribution counts, verified counts). RLS
     * enforces clearance on everything else.
     */
    async getDossier(operatorId) {
      const db = loadDB();
      const record = Object.values(db.operators).find((r) => r.id === operatorId);
      return record ? { ok: true, dossier: toDossier(record) } : { ok: false, code: 'NOT_ON_FILE' };
    },

    /**
     * CLEARANCE LADDER — the five tiers plus per-operator teaser
     * numbers for everything above the operator's level. Teaser
     * numbers are seeded from the callsign so they are concrete
     * and stable, never random-per-visit.
     *
     * SUPABASE SEAM: real counts come from clearance-gated
     * aggregate views (RLS returns counts, never contents).
     */
    async getClearanceLadder(operatorId) {
      const res = await this.getDossier(operatorId);
      if (!res.ok) return res;
      const seed = await deriveSeed(res.dossier.callsign);
      const n = seed.teasers;
      const idx = res.dossier.clearanceIndex;

      const ladder = TIERS.map((tier, i) => ({
        tier,
        index: i,
        state: i < idx ? 'held' : i === idx ? 'current' : 'locked',
        requirement: TIER_REQUIREMENTS[i],
        // Teasers: a real number left visible + the valuable part
        // redacted. `[[...]]` segments render as physical black bars.
        teaser:
          i <= idx
            ? null
            : [
                `[[####]] operators have logged ${n.extractionRoutes} extraction routes above your clearance.`,
                `the [[######]] rotation that never gets posted publicly — ${n.sightlines} verified sightlines attached.`,
                `${n.lootPatterns} high-value loot patterns, verified by [[##]] operators.`,
                `operator-only. ${n.vaultFiles} files. access by [[invitation]].`,
              ][i - 1],
      }));
      return { ok: true, ladder };
    },

    /* ---- session (device memory, stays local even post-Supabase) ---- */
    getSession() {
      try {
        return JSON.parse(localStorage.getItem(SESSION_KEY));
      } catch {
        return null;
      }
    },
    setSession(operatorId, callsign) {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ operatorId, callsign }));
    },
    clearSession() {
      localStorage.removeItem(SESSION_KEY);
    },
  };
})();
