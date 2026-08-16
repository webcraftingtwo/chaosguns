/* ============================================================
   inteldb.js — the DATA LAYER. All persistence lives here.
   ------------------------------------------------------------
   The UI never talks to storage or the network directly — it
   only calls the async methods on `intelDB`.

   Two backends behind one facade, chosen by DEADDROP_CONFIG:

   • REMOTE — Supabase. Callsign+passphrase auth runs entirely in
     Postgres RPCs (SECURITY DEFINER, bcrypt via pgcrypto, session
     tokens server-side). Tables carry RLS with no policies, so
     the RPC surface is the only door. No email, ever.

   • MOCK — localStorage. Offline fallback when no config is
     present; also what local dev uses with no network.

   Both return identical shapes; app.js cannot tell them apart.
   ============================================================ */

'use strict';

const intelDB = (() => {
  const DB_KEY = 'deaddrop.db.v1';
  const SESSION_KEY = 'deaddrop.session.v1';

  /* ---- clearance ladder definition (shared) ---- */
  const TIERS = ['RESTRICTED', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET', 'COMPARTMENTED'];
  // Verified files required to unlock each tier above RESTRICTED.
  const TIER_REQUIREMENTS = [0, 3, 8, 20, 50];

  const CLASSES = ['RECON', 'ENGINEER', 'ASSAULT', 'MEDIC'];

  /* ============================================================
     SHARED SHAPING — raw record → what the dossier panel renders.
     Raw shape (both backends): { id, callsign, enlistedAt(ms),
     clearanceIndex, verifiedCount, contributions }
     ============================================================ */
  function shapeDossier(raw) {
    const contributions = raw.contributions || {};
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

    const clearanceIndex = raw.clearanceIndex || 0;

    return {
      id: raw.id,
      callsign: raw.callsign,
      enlistedAt: raw.enlistedAt,
      clearanceIndex,
      clearance: TIERS[clearanceIndex],
      verifiedCount: raw.verifiedCount || 0,
      nextTier: TIERS[clearanceIndex + 1] || null,
      nextRequirement: TIER_REQUIREMENTS[clearanceIndex + 1] ?? null,
      contributions,
      specialization,
    };
  }

  /* ---- session memory (device-local under both backends) ---- */
  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY));
    } catch {
      return null;
    }
  }
  function writeSession(data) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  }
  function dropSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  /* ============================================================
     REMOTE BACKEND — Supabase RPC over PostgREST
     ============================================================ */
  function remoteBackend(cfg) {
    // Server-issued session token for the current operator; persisted
    // inside the session blob by setSession below.
    let pendingToken = null;

    async function rpc(fn, args) {
      try {
        const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: cfg.supabaseKey,
            Authorization: `Bearer ${cfg.supabaseKey}`,
          },
          body: JSON.stringify(args),
        });
        if (!res.ok) return { ok: false, code: 'RELAY_DOWN' };
        return await res.json();
      } catch {
        return { ok: false, code: 'RELAY_DOWN' };
      }
    }

    function acceptAuth(r) {
      if (!r.ok) return r;
      pendingToken = r.token || null;
      const out = { ok: true, dossier: shapeDossier(r.dossier) };
      if (r.cipher) out.cipher = r.cipher; // one-time hand-off, never stored
      return out;
    }

    return {
      async enlistOperator(callsign, passphrase) {
        return acceptAuth(await rpc('enlist_operator', {
          p_callsign: callsign, p_passphrase: passphrase,
        }));
      },

      async authenticate(callsign, passphrase) {
        return acceptAuth(await rpc('authenticate_operator', {
          p_callsign: callsign, p_passphrase: passphrase,
        }));
      },

      async recoverWithCipher(callsign, cipher, newPassphrase) {
        return acceptAuth(await rpc('recover_operator', {
          p_callsign: callsign, p_cipher: cipher, p_new_passphrase: newPassphrase,
        }));
      },

      async getDossier() {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        const r = await rpc('get_dossier', { p_token: session.token });
        return r.ok ? { ok: true, dossier: shapeDossier(r.dossier) } : r;
      },

      setSession(operatorId, callsign) {
        writeSession({ operatorId, callsign, token: pendingToken || getSession()?.token || null });
        pendingToken = null;
      },

      clearSession() {
        const session = getSession();
        dropSession();
        if (session?.token) {
          rpc('terminate_session', { p_token: session.token }); // fire and forget
        }
      },
    };
  }

  /* ============================================================
     MOCK BACKEND — localStorage (offline fallback)
     ============================================================ */
  function mockBackend() {
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

    function norm(callsign) {
      return String(callsign).trim().toLowerCase();
    }

    async function passDigest(callsign, passphrase) {
      return sha256Hex(`${norm(callsign)}::${passphrase}`);
    }
    async function cipherDigest(callsign, cipher) {
      return sha256Hex(`${norm(callsign)}##${cipher.replace(/\s+/g, '').toUpperCase()}`);
    }

    function generateCipher() {
      const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const raw = new Uint8Array(12);
      (globalThis.crypto?.getRandomValues)
        ? crypto.getRandomValues(raw)
        : raw.forEach((_, i) => (raw[i] = Math.floor(Math.random() * 256)));
      const chars = Array.from(raw, (b) => alphabet[b % alphabet.length]);
      return `DD-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
    }

    function toRaw(record) {
      return {
        id: record.id,
        callsign: record.callsign,
        enlistedAt: record.enlistedAt,
        clearanceIndex: record.clearanceIndex || 0,
        verifiedCount: record.verifiedCount || 0,
        contributions: record.contributions || {},
      };
    }

    return {
      async enlistOperator(callsign, passphrase) {
        const db = loadDB();
        const key = norm(callsign);
        if (db.operators[key]) return { ok: false, code: 'CALLSIGN_IN_SERVICE' };
        const cipher = generateCipher();
        const record = {
          id: globalThis.crypto?.randomUUID
            ? crypto.randomUUID()
            : `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
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
        return { ok: true, dossier: shapeDossier(toRaw(record)), cipher };
      },

      async authenticate(callsign, passphrase) {
        const db = loadDB();
        const record = db.operators[norm(callsign)];
        if (!record) return { ok: false, code: 'CALLSIGN_NOT_ON_FILE' };
        if ((await passDigest(callsign, passphrase)) !== record.passHash) {
          return { ok: false, code: 'CREDENTIALS_REJECTED' };
        }
        return { ok: true, dossier: shapeDossier(toRaw(record)) };
      },

      async recoverWithCipher(callsign, cipher, newPassphrase) {
        const db = loadDB();
        const record = db.operators[norm(callsign)];
        if (!record) return { ok: false, code: 'CALLSIGN_NOT_ON_FILE' };
        if ((await cipherDigest(callsign, cipher)) !== record.cipherHash) {
          return { ok: false, code: 'CIPHER_REJECTED' };
        }
        const freshCipher = generateCipher();
        record.passHash = await passDigest(callsign, newPassphrase);
        record.cipherHash = await cipherDigest(callsign, freshCipher);
        saveDB(db);
        return { ok: true, dossier: shapeDossier(toRaw(record)), cipher: freshCipher };
      },

      async getDossier(operatorId) {
        const id = operatorId || getSession()?.operatorId;
        const db = loadDB();
        const record = Object.values(db.operators).find((r) => r.id === id);
        return record
          ? { ok: true, dossier: shapeDossier(toRaw(record)) }
          : { ok: false, code: 'SESSION_INVALID' };
      },

      setSession(operatorId, callsign) {
        writeSession({ operatorId, callsign });
      },

      clearSession() {
        dropSession();
      },
    };
  }

  /* ============================================================
     FACADE
     ============================================================ */
  const cfg = globalThis.DEADDROP_CONFIG;
  const live = Boolean(cfg?.supabaseUrl && cfg?.supabaseKey);
  const backend = live ? remoteBackend(cfg) : mockBackend();

  return {
    TIERS,
    TIER_REQUIREMENTS,
    CLASSES,
    live, // true when talking to the real relay

    enlistOperator: (cs, pw) => backend.enlistOperator(cs, pw),
    authenticate: (cs, pw) => backend.authenticate(cs, pw),
    recoverWithCipher: (cs, ci, pw) => backend.recoverWithCipher(cs, ci, pw),
    getDossier: (operatorId) => backend.getDossier(operatorId),

    /**
     * CLEARANCE LADDER — the five tiers plus per-operator teaser
     * numbers for everything above the operator's level. Teaser
     * numbers are seeded from the callsign so they are concrete
     * and stable, never random-per-visit. (When the community
     * database lands, real counts come from clearance-gated
     * aggregate views — RLS returns counts, never contents.)
     */
    async getClearanceLadder(operatorId) {
      const res = await backend.getDossier(operatorId);
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

    getSession,
    setSession: (id, cs) => backend.setSession(id, cs),
    clearSession: () => backend.clearSession(),
  };
})();
