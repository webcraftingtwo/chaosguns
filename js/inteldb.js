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

  // Confirmations from distinct operators needed to flip a drop to
  // VERIFIED (and credit its author toward the next clearance tier).
  const VERIFY_THRESHOLD = 2;

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

      async fileIntel(cls, title, body, clearance = null) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        const r = await rpc('file_intel', {
          p_token: session.token, p_class: cls, p_title: title, p_body: body,
          p_clearance: clearance,
        });
        return r.ok
          ? { ok: true, dossier: shapeDossier(r.dossier), fileId: r.fileId }
          : r;
      },

      async getIntelFeed() {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('get_intel_feed', { p_token: session.token });
      },

      async verifyIntel(fileId) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('verify_intel', { p_token: session.token, p_file_id: fileId });
      },

      /** Unseen events queued while away; delivered exactly once. */
      async getDispatches() {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('get_dispatches', { p_token: session.token });
      },

      async issueCompartmentKey() {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('issue_compartment_key', { p_token: session.token });
      },

      async redeemCompartmentKey(code) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        const r = await rpc('redeem_compartment_key', {
          p_token: session.token, p_code: code,
        });
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

      async fileIntel(cls, title, body, clearance = null) {
        const db = loadDB();
        const me = Object.values(db.operators).find(
          (r) => r.id === getSession()?.operatorId
        );
        if (!me) return { ok: false, code: 'SESSION_INVALID' };
        if (!CLASSES.includes(cls)) return { ok: false, code: 'BAD_CLASS' };
        if (title.trim().length < 4 || title.trim().length > 80) {
          return { ok: false, code: 'BAD_TITLE' };
        }
        if (body.trim().length < 20 || body.trim().length > 2000) {
          return { ok: false, code: 'BAD_BODY' };
        }
        const tier = clearance ?? (me.clearanceIndex || 0);
        if (tier < 0 || tier > (me.clearanceIndex || 0)) {
          return { ok: false, code: 'BAD_CLEARANCE' };
        }
        db.files = db.files || [];
        const file = {
          id: globalThis.crypto?.randomUUID
            ? crypto.randomUUID()
            : `f-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          operatorId: me.id,
          class: cls,
          clearanceIndex: tier,
          title: title.trim(),
          body: body.trim(),
          createdAt: Date.now(),
          verifications: [], // operator ids
          isVerified: false,
        };
        db.files.push(file);
        me.contributions[cls] = (me.contributions[cls] || 0) + 1;
        saveDB(db);
        return { ok: true, dossier: shapeDossier(toRaw(me)), fileId: file.id };
      },

      async getIntelFeed() {
        const db = loadDB();
        const me = Object.values(db.operators).find(
          (r) => r.id === getSession()?.operatorId
        );
        if (!me) return { ok: false, code: 'SESSION_INVALID' };
        const myClearance = me.clearanceIndex || 0;
        const files = (db.files || [])
          .slice()
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 100)
          .map((f) => {
            if (f.clearanceIndex > myClearance) {
              return {
                id: f.id, locked: true, class: f.class,
                clearanceIndex: f.clearanceIndex, createdAt: f.createdAt,
              };
            }
            const author = Object.values(db.operators).find((r) => r.id === f.operatorId);
            return {
              id: f.id, locked: false, class: f.class,
              clearanceIndex: f.clearanceIndex,
              title: f.title, body: f.body,
              author: author ? author.callsign : 'UNKNOWN',
              mine: f.operatorId === me.id,
              createdAt: f.createdAt,
              verifications: f.verifications.length,
              isVerified: f.isVerified,
              verifiedByMe: f.verifications.includes(me.id),
            };
          });
        return { ok: true, clearanceIndex: myClearance, files };
      },

      async verifyIntel(fileId) {
        const db = loadDB();
        const me = Object.values(db.operators).find(
          (r) => r.id === getSession()?.operatorId
        );
        if (!me) return { ok: false, code: 'SESSION_INVALID' };
        const file = (db.files || []).find((f) => f.id === fileId);
        if (!file) return { ok: false, code: 'NOT_ON_FILE' };
        if (file.clearanceIndex > (me.clearanceIndex || 0)) {
          return { ok: false, code: 'INSUFFICIENT_CLEARANCE' };
        }
        if (file.operatorId === me.id) return { ok: false, code: 'OWN_FILE' };
        if (file.verifications.includes(me.id)) {
          return { ok: false, code: 'ALREADY_VERIFIED' };
        }
        file.verifications.push(me.id);
        if (file.verifications.length >= VERIFY_THRESHOLD && !file.isVerified) {
          file.isVerified = true;
          const author = Object.values(db.operators).find((r) => r.id === file.operatorId);
          if (author) {
            author.verifiedCount = (author.verifiedCount || 0) + 1;
            db.dispatches = db.dispatches || [];
            db.dispatches.push({
              operatorId: author.id, kind: 'INTEL_VERIFIED',
              payload: { title: file.title, class: file.class },
              createdAt: Date.now(), seen: false,
            });
            // auto-promote, but never into COMPARTMENTED (tier 4 is
            // invitation-only via compartment keys)
            while (
              (author.clearanceIndex || 0) < 3 &&
              author.verifiedCount >= TIER_REQUIREMENTS[(author.clearanceIndex || 0) + 1]
            ) {
              author.clearanceIndex = (author.clearanceIndex || 0) + 1;
              db.dispatches.push({
                operatorId: author.id, kind: 'CLEARANCE_GRANTED',
                payload: { clearanceIndex: author.clearanceIndex },
                createdAt: Date.now(), seen: false,
              });
            }
          }
        }
        saveDB(db);
        return {
          ok: true,
          verifications: file.verifications.length,
          isVerified: file.isVerified,
        };
      },

      async getDispatches() {
        const db = loadDB();
        const me = getSession()?.operatorId;
        if (!me) return { ok: false, code: 'SESSION_INVALID' };
        const mine = (db.dispatches || []).filter(
          (d) => d.operatorId === me && !d.seen
        );
        mine.forEach((d) => (d.seen = true));
        saveDB(db);
        return {
          ok: true,
          dispatches: mine
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((d) => ({ kind: d.kind, payload: d.payload, createdAt: d.createdAt })),
        };
      },

      async issueCompartmentKey() {
        const db = loadDB();
        const me = Object.values(db.operators).find(
          (r) => r.id === getSession()?.operatorId
        );
        if (!me) return { ok: false, code: 'SESSION_INVALID' };
        if ((me.clearanceIndex || 0) < 4) return { ok: false, code: 'INSUFFICIENT_CLEARANCE' };
        db.keys = db.keys || [];
        if (db.keys.filter((k) => k.issuedBy === me.id && !k.redeemedAt).length >= 3) {
          return { ok: false, code: 'KEY_LIMIT' };
        }
        const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        const raw = new Uint8Array(8);
        (globalThis.crypto?.getRandomValues)
          ? crypto.getRandomValues(raw)
          : raw.forEach((_, i) => (raw[i] = Math.floor(Math.random() * 256)));
        const chars = Array.from(raw, (b) => alphabet[b % alphabet.length]).join('');
        const code = `CK-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
        db.keys.push({ code, issuedBy: me.id, redeemedAt: null });
        saveDB(db);
        return { ok: true, key: code };
      },

      async redeemCompartmentKey(codeIn) {
        const db = loadDB();
        const me = Object.values(db.operators).find(
          (r) => r.id === getSession()?.operatorId
        );
        if (!me) return { ok: false, code: 'SESSION_INVALID' };
        if ((me.clearanceIndex || 0) >= 4) return { ok: false, code: 'ALREADY_COMPARTMENTED' };
        if ((me.clearanceIndex || 0) < 3) return { ok: false, code: 'INSUFFICIENT_STANDING' };
        const code = codeIn.replace(/\s/g, '').toUpperCase();
        const key = (db.keys || []).find((k) => k.code === code && !k.redeemedAt);
        if (!key) return { ok: false, code: 'KEY_REJECTED' };
        key.redeemedAt = Date.now();
        me.clearanceIndex = 4;
        saveDB(db);
        return { ok: true, dossier: shapeDossier(toRaw(me)) };
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
    VERIFY_THRESHOLD,
    live, // true when talking to the real relay

    enlistOperator: (cs, pw) => backend.enlistOperator(cs, pw),
    authenticate: (cs, pw) => backend.authenticate(cs, pw),
    recoverWithCipher: (cs, ci, pw) => backend.recoverWithCipher(cs, ci, pw),
    getDossier: (operatorId) => backend.getDossier(operatorId),
    fileIntel: (cls, title, body, clearance) => backend.fileIntel(cls, title, body, clearance),
    getIntelFeed: () => backend.getIntelFeed(),
    verifyIntel: (fileId) => backend.verifyIntel(fileId),
    getDispatches: () => backend.getDispatches(),
    issueCompartmentKey: () => backend.issueCompartmentKey(),
    redeemCompartmentKey: (code) => backend.redeemCompartmentKey(code),

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
