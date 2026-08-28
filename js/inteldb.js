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

  // Theater + mode tags (must mirror the CHECK constraints in Postgres).
  const MAPS = ['ZERO DAM', 'LAYALI GROVE', 'SPACE CITY', 'BRAKKESH', 'TIDE PRISON',
                'ASCENSION', 'THRESHOLD', 'SHAFTED', 'CRACKED'];
  const MODES = ['OPERATIONS', 'WARFARE'];

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

    /* The unwrapped ECDH private key lives in memory for this page
       only — never localStorage, never the wire. A page reload seals
       the vault again until the operator re-enters their passphrase. */
    let identity = null;   // { privateKey, publicKey }

    /**
     * Make sure this operator has an identity keypair and that we
     * hold the unwrapped private key. Called with the passphrase in
     * hand (login/enlist) or later when unsealing.
     */
    async function openVault(token, passphrase) {
      const vault = await rpc('get_vault', { p_token: token });
      if (!vault.ok) return vault;

      if (!vault.hasKeys) {
        // first contact for this operator: mint and register
        const minted = await DDCrypto.mintIdentity(passphrase);
        const reg = await rpc('register_keys', {
          p_token: token,
          p_public_key: minted.publicKey,
          p_vault_blob: minted.vaultBlob,
          p_vault_iv: minted.vaultIv,
          p_vault_salt: minted.vaultSalt,
        });
        if (!reg.ok) return reg;
        identity = { privateKey: minted.privateKey, publicKey: minted.publicKey };
        return { ok: true, minted: true };
      }

      try {
        const vaultKey = await DDCrypto.deriveVaultKey(passphrase, vault.vaultSalt);
        identity = {
          privateKey: await DDCrypto.unwrapPrivate(vault.vaultBlob, vault.vaultIv, vaultKey),
          publicKey: vault.publicKey,
        };
        return { ok: true };
      } catch {
        // wrong passphrase for this vault, or a vault minted under an
        // older passphrase (recovery mints a fresh one)
        return { ok: false, code: 'VAULT_SEALED' };
      }
    }

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
        // the server is given a derived secret, never the passphrase
        const secret = await DDCrypto.deriveAuthSecret(callsign, passphrase);
        const res = acceptAuth(await rpc('enlist_operator', {
          p_callsign: callsign, p_passphrase: secret,
        }));
        if (res.ok) await openVault(pendingToken, passphrase);
        return res;
      },

      async authenticate(callsign, passphrase) {
        const secret = await DDCrypto.deriveAuthSecret(callsign, passphrase);
        let res = acceptAuth(await rpc('authenticate_operator', {
          p_callsign: callsign, p_passphrase: secret,
        }));

        // Accounts predating derived auth still hold a hash of the raw
        // passphrase. Accept it once, then migrate the credential so
        // the server stops holding anything passphrase-shaped.
        if (!res.ok && res.code === 'CREDENTIALS_REJECTED') {
          const legacy = acceptAuth(await rpc('authenticate_operator', {
            p_callsign: callsign, p_passphrase: passphrase,
          }));
          if (legacy.ok) {
            await rpc('rekey_passphrase', { p_token: pendingToken, p_new_secret: secret });
            res = legacy;
          }
        }

        if (res.ok) await openVault(pendingToken, passphrase);
        return res;
      },

      async recoverWithCipher(callsign, cipher, newPassphrase) {
        const secret = await DDCrypto.deriveAuthSecret(callsign, newPassphrase);
        const res = acceptAuth(await rpc('recover_operator', {
          p_callsign: callsign, p_cipher: cipher, p_new_passphrase: secret,
        }));
        if (res.ok) {
          // the old vault was sealed with the lost passphrase and can
          // never be opened again: mint a fresh identity and say so
          const minted = await DDCrypto.mintIdentity(newPassphrase);
          const reg = await rpc('register_keys', {
            p_token: pendingToken,
            p_public_key: minted.publicKey,
            p_vault_blob: minted.vaultBlob,
            p_vault_iv: minted.vaultIv,
            p_vault_salt: minted.vaultSalt,
          });
          if (reg.ok) {
            identity = { privateKey: minted.privateKey, publicKey: minted.publicKey };
            res.keysReplaced = true;
          }
        }
        return res;
      },

      /* ---- message drop ---- */

      vaultOpen() { return Boolean(identity); },

      /** Re-open the vault after a reload, with the passphrase re-entered. */
      async unsealVault(passphrase) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return openVault(session.token, passphrase);
      },

      async myFingerprint() {
        if (!identity) return null;
        return DDCrypto.fingerprint(identity.publicKey);
      },

      async sendMessage(recipient, text) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        if (!identity) return { ok: false, code: 'VAULT_SEALED' };

        const keyRes = await rpc('get_public_key', {
          p_token: session.token, p_callsign: recipient,
        });
        if (!keyRes.ok) return keyRes;

        const key = await DDCrypto.conversationKey(identity.privateKey, keyRes.publicKey);
        const sealed = await DDCrypto.encryptFor(key, text);
        return rpc('send_message', {
          p_token: session.token,
          p_recipient: recipient,
          p_ciphertext: sealed.ciphertext,
          p_iv: sealed.iv,
        });
      },

      /** Fetches ciphertext and decrypts it here, in the browser. */
      async getMessages() {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        const res = await rpc('get_messages', { p_token: session.token });
        if (!res.ok) return res;
        if (!identity) return { ok: true, sealed: true, unread: res.unread, messages: [] };

        const out = [];
        for (const m of res.messages || []) {
          let body;
          try {
            const key = await DDCrypto.conversationKey(identity.privateKey, m.counterpartKey);
            body = await DDCrypto.decryptFrom(key, m.ciphertext, m.iv);
          } catch {
            // their key changed (recovery) — this one is gone for good
            body = null;
          }
          out.push({
            id: m.id, mine: m.mine, counterpart: m.counterpart,
            createdAt: m.createdAt, readAt: m.readAt, body,
          });
        }
        return { ok: true, sealed: false, unread: res.unread, messages: out };
      },

      async markMessageRead(id) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('mark_message_read', { p_token: session.token, p_id: id });
      },

      async hideMessage(id) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('hide_message', { p_token: session.token, p_id: id });
      },

      async operatorFingerprint(callsign) {
        const session = getSession();
        if (!session?.token) return null;
        const r = await rpc('get_public_key', { p_token: session.token, p_callsign: callsign });
        return r.ok ? DDCrypto.fingerprint(r.publicKey) : null;
      },

      async getDossier() {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        const r = await rpc('get_dossier', { p_token: session.token });
        return r.ok ? { ok: true, dossier: shapeDossier(r.dossier) } : r;
      },

      async fileIntel(cls, title, body, clearance = null, map = null, mode = null, zone = null, build = null) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        const r = await rpc('file_intel', {
          p_token: session.token, p_class: cls, p_title: title, p_body: body,
          p_clearance: clearance, p_map: map, p_mode: mode, p_zone: zone,
          p_build: build,
        });
        return r.ok
          ? { ok: true, dossier: shapeDossier(r.dossier), fileId: r.fileId }
          : r;
      },

      async annexIntel(fileId, body) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('annex_intel', { p_token: session.token, p_file_id: fileId, p_body: body });
      },

      async getAnnexes(fileId) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('get_annexes', { p_token: session.token, p_file_id: fileId });
      },

      async getRoster() {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('get_roster', { p_token: session.token });
      },

      async getActivity(limit = 24) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('get_activity', { p_token: session.token, p_limit: limit });
      },

      async getTasking() {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('get_tasking', { p_token: session.token });
      },

      async appealBurn(fileId, statement) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('appeal_burn', {
          p_token: session.token, p_file_id: fileId, p_statement: statement,
        });
      },

      async reinstateIntel(fileId) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('reinstate_intel', { p_token: session.token, p_file_id: fileId });
      },

      async getOperatorFile(callsign) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('get_operator_file', { p_token: session.token, p_callsign: callsign });
      },

      async burnIntel(fileId) {
        const session = getSession();
        if (!session?.token) return { ok: false, code: 'SESSION_INVALID' };
        return rpc('burn_intel', { p_token: session.token, p_file_id: fileId });
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
        identity = null; // the vault seals with the session
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
    /* same in-memory-only rule as the live backend */
    let mockIdentity = null;

    async function mockOpenVault(db, record, passphrase) {
      if (!record.publicKey) {
        const minted = await DDCrypto.mintIdentity(passphrase);
        record.publicKey = minted.publicKey;
        record.vaultBlob = minted.vaultBlob;
        record.vaultIv = minted.vaultIv;
        record.vaultSalt = minted.vaultSalt;
        saveDB(db);
        mockIdentity = { privateKey: minted.privateKey, publicKey: minted.publicKey };
        return { ok: true, minted: true };
      }
      try {
        const vaultKey = await DDCrypto.deriveVaultKey(passphrase, record.vaultSalt);
        mockIdentity = {
          privateKey: await DDCrypto.unwrapPrivate(record.vaultBlob, record.vaultIv, vaultKey),
          publicKey: record.publicKey,
        };
        return { ok: true };
      } catch {
        return { ok: false, code: 'VAULT_SEALED' };
      }
    }

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

    /* mirror of the SQL _file_row builder */
    function mockFileRow(db, f, viewer) {
      const annexes = (db.annexes || []).filter((a) => a.fileId === f.id).length;
      if (f.clearanceIndex > (viewer.clearanceIndex || 0)) {
        return {
          id: f.id, locked: true, class: f.class,
          clearanceIndex: f.clearanceIndex, createdAt: f.createdAt,
          map: f.map || null, mode: f.mode || null, zone: f.zone || null,
          buildWeapon: f.build ? f.build.weapon : null, annexes,
        };
      }
      const author = Object.values(db.operators).find((r) => r.id === f.operatorId);
      const burnerIds = f.burnerIds || [];
      return {
        id: f.id, locked: false, class: f.class,
        clearanceIndex: f.clearanceIndex,
        title: f.title, body: f.body,
        author: author ? author.callsign : 'UNKNOWN',
        mine: f.operatorId === viewer.id,
        createdAt: f.createdAt,
        verifications: f.verifications.length,
        isVerified: f.isVerified,
        verifiedByMe: f.verifications.includes(viewer.id),
        map: f.map || null, mode: f.mode || null, zone: f.zone || null,
        build: f.build || null, annexes,
        isBurned: f.isBurned || false,
        burns: burnerIds.length,
        burnedByMe: burnerIds.includes(viewer.id),
        appeal: f.appeal || null,
        appealAt: f.appealAt || null,
        reinstates: (f.reinstateIds || []).length,
        reinstatedByMe: (f.reinstateIds || []).includes(viewer.id),
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
        await mockOpenVault(db, record, passphrase);
        return { ok: true, dossier: shapeDossier(toRaw(record)), cipher };
      },

      async authenticate(callsign, passphrase) {
        const db = loadDB();
        const record = db.operators[norm(callsign)];
        if (!record) return { ok: false, code: 'CALLSIGN_NOT_ON_FILE' };
        if ((await passDigest(callsign, passphrase)) !== record.passHash) {
          return { ok: false, code: 'CREDENTIALS_REJECTED' };
        }
        await mockOpenVault(db, record, passphrase);
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

      async fileIntel(cls, title, body, clearance = null, map = null, mode = null, zone = null, build = null) {
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
        if (map !== null && !MAPS.includes(map)) return { ok: false, code: 'BAD_TAG' };
        if (mode !== null && !MODES.includes(mode)) return { ok: false, code: 'BAD_TAG' };
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
          map,
          mode,
          zone: map ? (zone || null) : null,
          build: build && build.weapon
            ? { weapon: String(build.weapon).trim().slice(0, 40), slots: build.slots || {} }
            : null,
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
          .map((f) => mockFileRow(db, f, me));
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
        if (file.isBurned) return { ok: false, code: 'BURNED' };
        if ((file.burnerIds || []).includes(me.id)) {
          return { ok: false, code: 'CONFLICTED' };
        }
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

      async annexIntel(fileId, body) {
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
        const text = body.trim();
        if (text.length < 2 || text.length > 500) return { ok: false, code: 'BAD_ANNEX' };
        db.annexes = db.annexes || [];
        const annex = {
          id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          fileId, operatorId: me.id, body: text, createdAt: Date.now(),
        };
        db.annexes.push(annex);
        if (file.operatorId !== me.id) {
          db.dispatches = db.dispatches || [];
          db.dispatches.push({
            operatorId: file.operatorId, kind: 'ANNEX_ADDED',
            payload: { title: file.title, author: me.callsign },
            createdAt: Date.now(), seen: false,
          });
        }
        saveDB(db);
        return {
          ok: true,
          annex: { author: me.callsign, body: text, mine: true, createdAt: annex.createdAt },
          count: db.annexes.filter((a) => a.fileId === fileId).length,
        };
      },

      async getAnnexes(fileId) {
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
        return {
          ok: true,
          annexes: (db.annexes || [])
            .filter((a) => a.fileId === fileId)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((a) => {
              const author = Object.values(db.operators).find((r) => r.id === a.operatorId);
              return {
                author: author ? author.callsign : 'UNKNOWN',
                body: a.body, mine: a.operatorId === me.id, createdAt: a.createdAt,
              };
            }),
        };
      },

      async burnIntel(fileId) {
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
        if (file.verifications.includes(me.id)) return { ok: false, code: 'CONFLICTED' };
        file.burnerIds = file.burnerIds || [];
        if (file.burnerIds.includes(me.id)) return { ok: false, code: 'ALREADY_BURNED' };
        file.burnerIds.push(me.id);
        if (file.burnerIds.length >= VERIFY_THRESHOLD && !file.isBurned) {
          file.isBurned = true;
          const author = Object.values(db.operators).find((r) => r.id === file.operatorId);
          if (file.isVerified) {
            file.isVerified = false;
            if (author) author.verifiedCount = Math.max(0, (author.verifiedCount || 0) - 1);
          }
          if (author) {
            db.dispatches = db.dispatches || [];
            db.dispatches.push({
              operatorId: author.id, kind: 'BURN_NOTICE',
              payload: { title: file.title, class: file.class },
              createdAt: Date.now(), seen: false,
            });
          }
        }
        saveDB(db);
        return { ok: true, burns: file.burnerIds.length, isBurned: file.isBurned || false };
      },

      async getOperatorFile(callsign) {
        const db = loadDB();
        const me = Object.values(db.operators).find(
          (r) => r.id === getSession()?.operatorId
        );
        if (!me) return { ok: false, code: 'SESSION_INVALID' };
        const subject = db.operators[String(callsign).trim().toLowerCase()];
        if (!subject) return { ok: false, code: 'NOT_ON_FILE' };
        const files = (db.files || [])
          .filter((f) => f.operatorId === subject.id)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 50)
          .map((f) => mockFileRow(db, f, me));
        return {
          ok: true,
          profile: {
            callsign: subject.callsign,
            clearanceIndex: subject.clearanceIndex || 0,
            verifiedCount: subject.verifiedCount || 0,
            contributions: subject.contributions || {},
            enlistedAt: subject.enlistedAt,
            lastContact: subject.enlistedAt,
            drops: (db.files || []).filter((f) => f.operatorId === subject.id).length,
            annexes: (db.annexes || []).filter((a) => a.operatorId === subject.id).length,
            burnsReceived: (db.files || []).filter((f) => f.operatorId === subject.id && f.isBurned).length,
            me: subject.id === me.id,
          },
          files,
        };
      },

      async appealBurn(fileId, statement) {
        const db = loadDB();
        const me = Object.values(db.operators).find(
          (r) => r.id === getSession()?.operatorId
        );
        if (!me) return { ok: false, code: 'SESSION_INVALID' };
        const file = (db.files || []).find((f) => f.id === fileId);
        if (!file) return { ok: false, code: 'NOT_ON_FILE' };
        if (file.operatorId !== me.id) return { ok: false, code: 'NOT_YOUR_DROP' };
        if (!file.isBurned) return { ok: false, code: 'NOT_BURNED' };
        if (file.appealAt) return { ok: false, code: 'ALREADY_APPEALED' };
        const text = statement.trim();
        if (text.length < 10 || text.length > 500) return { ok: false, code: 'BAD_APPEAL' };
        file.appeal = text;
        file.appealAt = Date.now();
        db.dispatches = db.dispatches || [];
        for (const burnerId of file.burnerIds || []) {
          db.dispatches.push({
            operatorId: burnerId, kind: 'APPEAL_FILED',
            payload: { title: file.title, author: me.callsign },
            createdAt: Date.now(), seen: false,
          });
        }
        saveDB(db);
        return { ok: true };
      },

      async reinstateIntel(fileId) {
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
        if (!file.isBurned || !file.appealAt) return { ok: false, code: 'NO_APPEAL' };
        file.reinstateIds = file.reinstateIds || [];
        if (file.reinstateIds.includes(me.id)) {
          return { ok: false, code: 'ALREADY_REINSTATED' };
        }
        file.reinstateIds.push(me.id);
        const count = file.reinstateIds.length;
        if (count >= VERIFY_THRESHOLD) {
          file.isBurned = false;
          file.burnerIds = [];
          file.reinstateIds = [];
          file.appealAt = null;
          file.isVerified = file.verifications.length >= VERIFY_THRESHOLD;
          const author = Object.values(db.operators).find((r) => r.id === file.operatorId);
          if (author && file.isVerified) {
            author.verifiedCount = (author.verifiedCount || 0) + 1;
            while (
              (author.clearanceIndex || 0) < 3 &&
              author.verifiedCount >= TIER_REQUIREMENTS[(author.clearanceIndex || 0) + 1]
            ) {
              author.clearanceIndex = (author.clearanceIndex || 0) + 1;
              author.promotedAt = Date.now();
            }
          }
          db.dispatches = db.dispatches || [];
          db.dispatches.push({
            operatorId: file.operatorId, kind: 'BURN_LIFTED',
            payload: { title: file.title }, createdAt: Date.now(), seen: false,
          });
        }
        saveDB(db);
        return { ok: true, reinstates: count, lifted: !file.isBurned };
      },

      async getActivity(limit = 24) {
        const db = loadDB();
        const me = Object.values(db.operators).find(
          (r) => r.id === getSession()?.operatorId
        );
        if (!me) return { ok: false, code: 'SESSION_INVALID' };
        const byId = (id) => Object.values(db.operators).find((r) => r.id === id);
        const events = [];
        for (const f of db.files || []) {
          const author = byId(f.operatorId);
          events.push({
            kind: 'FILED', at: f.createdAt, actor: author ? author.callsign : 'UNKNOWN',
            title: f.title, clearanceIndex: f.clearanceIndex, class: f.class,
          });
        }
        for (const o of Object.values(db.operators)) {
          events.push({
            kind: 'ENLISTED', at: o.enlistedAt, actor: o.callsign,
            title: null, clearanceIndex: 0, class: null,
          });
          if (o.promotedAt) {
            events.push({
              kind: 'CLEARED', at: o.promotedAt, actor: o.callsign,
              title: null, clearanceIndex: o.clearanceIndex || 0, class: null,
            });
          }
        }
        for (const a of db.annexes || []) {
          const f = (db.files || []).find((x) => x.id === a.fileId);
          const who = byId(a.operatorId);
          if (!f) continue;
          events.push({
            kind: 'ANNEXED', at: a.createdAt, actor: who ? who.callsign : 'UNKNOWN',
            title: f.title, clearanceIndex: f.clearanceIndex, class: f.class,
          });
        }
        const mine = me.clearanceIndex || 0;
        return {
          ok: true,
          events: events
            .sort((a, b) => b.at - a.at)
            .slice(0, limit)
            .map((e) => ({
              ...e,
              withheld: e.title !== null && e.clearanceIndex > mine,
              title: e.title !== null && e.clearanceIndex > mine ? null : e.title,
              me: e.actor === me.callsign,
            })),
        };
      },

      async getTasking() {
        const db = loadDB();
        const me = Object.values(db.operators).find(
          (r) => r.id === getSession()?.operatorId
        );
        if (!me) return { ok: false, code: 'SESSION_INVALID' };
        const mine = me.clearanceIndex || 0;
        const files = db.files || [];
        const byId = (id) => Object.values(db.operators).find((r) => r.id === id);
        const awaiting = files
          .filter((f) => f.clearanceIndex <= mine && f.operatorId !== me.id &&
            !f.isVerified && !f.isBurned &&
            !f.verifications.includes(me.id) && !(f.burnerIds || []).includes(me.id))
          .sort((a, b) => b.createdAt - a.createdAt).slice(0, 4)
          .map((f) => ({
            id: f.id, title: f.title, class: f.class,
            author: (byId(f.operatorId) || {}).callsign || 'UNKNOWN',
            verifications: f.verifications.length,
          }));
        const minePending = files
          .filter((f) => f.operatorId === me.id && !f.isVerified && !f.isBurned)
          .sort((a, b) => b.createdAt - a.createdAt).slice(0, 3)
          .map((f) => ({ id: f.id, title: f.title, verifications: f.verifications.length }));
        const appeals = files
          .filter((f) => f.isBurned && f.appealAt && f.clearanceIndex <= mine &&
            f.operatorId !== me.id && !(f.reinstateIds || []).includes(me.id))
          .slice(0, 3)
          .map((f) => ({
            id: f.id, title: f.title,
            author: (byId(f.operatorId) || {}).callsign || 'UNKNOWN',
            reinstates: (f.reinstateIds || []).length,
          }));
        const burnedMine = files
          .filter((f) => f.operatorId === me.id && f.isBurned && !f.appealAt)
          .slice(0, 3)
          .map((f) => ({ id: f.id, title: f.title }));
        const contributions = me.contributions || {};
        const topClass = CLASSES
          .slice().sort((a, b) => (contributions[b] || 0) - (contributions[a] || 0))[0];
        const hasTop = (contributions[topClass] || 0) > 0;
        return {
          ok: true,
          clearanceIndex: mine,
          verifiedCount: me.verifiedCount || 0,
          nextRequirement: mine < 3 ? TIER_REQUIREMENTS[mine + 1] : null,
          awaiting, mine: minePending, appeals, burnedMine,
          topClass: hasTop ? topClass : null,
          specReads: hasTop
            ? files.filter((f) => f.clearanceIndex <= mine && f.operatorId !== me.id &&
                !f.isBurned && f.class === topClass).length
            : 0,
          withheldCount: files.filter((f) => f.clearanceIndex > mine).length,
        };
      },

      async getRoster() {
        const db = loadDB();
        const meId = getSession()?.operatorId;
        if (!meId) return { ok: false, code: 'SESSION_INVALID' };
        const roster = Object.values(db.operators)
          .map((o) => ({
            callsign: o.callsign,
            clearanceIndex: o.clearanceIndex || 0,
            verifiedCount: o.verifiedCount || 0,
            contributions: o.contributions || {},
            enlistedAt: o.enlistedAt,
            drops: (db.files || []).filter((f) => f.operatorId === o.id).length,
            annexes: (db.annexes || []).filter((a) => a.operatorId === o.id).length,
            lastContact: o.enlistedAt, // mock has no session history
            me: o.id === meId,
          }))
          .sort((a, b) =>
            b.clearanceIndex - a.clearanceIndex ||
            b.verifiedCount - a.verifiedCount ||
            a.enlistedAt - b.enlistedAt
          )
          .slice(0, 100);
        return { ok: true, roster };
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

      /* ---- message drop (same crypto, local store) ---- */

      vaultOpen() { return Boolean(mockIdentity); },

      async unsealVault(passphrase) {
        const db = loadDB();
        const me = Object.values(db.operators).find(
          (r) => r.id === getSession()?.operatorId
        );
        if (!me) return { ok: false, code: 'SESSION_INVALID' };
        return mockOpenVault(db, me, passphrase);
      },

      async myFingerprint() {
        return mockIdentity ? DDCrypto.fingerprint(mockIdentity.publicKey) : null;
      },

      async sendMessage(recipient, text) {
        const db = loadDB();
        const me = Object.values(db.operators).find(
          (r) => r.id === getSession()?.operatorId
        );
        if (!me) return { ok: false, code: 'SESSION_INVALID' };
        if (!mockIdentity) return { ok: false, code: 'VAULT_SEALED' };
        const to = db.operators[String(recipient).trim().toLowerCase()];
        if (!to) return { ok: false, code: 'CALLSIGN_NOT_ON_FILE' };
        if (to.id === me.id) return { ok: false, code: 'SELF_ADDRESSED' };
        if (!to.publicKey) return { ok: false, code: 'NO_KEYS' };
        const key = await DDCrypto.conversationKey(mockIdentity.privateKey, to.publicKey);
        const sealed = await DDCrypto.encryptFor(key, text);
        db.messages = db.messages || [];
        db.messages.push({
          id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          senderId: me.id, recipientId: to.id,
          ciphertext: sealed.ciphertext, iv: sealed.iv,
          createdAt: Date.now(), readAt: null,
        });
        saveDB(db);
        return { ok: true };
      },

      async getMessages() {
        const db = loadDB();
        const me = Object.values(db.operators).find(
          (r) => r.id === getSession()?.operatorId
        );
        if (!me) return { ok: false, code: 'SESSION_INVALID' };
        const rows = (db.messages || [])
          .filter((m) => m.senderId === me.id || m.recipientId === me.id)
          .sort((a, b) => b.createdAt - a.createdAt);
        const unread = rows.filter((m) => m.recipientId === me.id && !m.readAt).length;
        if (!mockIdentity) return { ok: true, sealed: true, unread, messages: [] };

        const byId = (id) => Object.values(db.operators).find((r) => r.id === id);
        const out = [];
        for (const m of rows) {
          const other = byId(m.senderId === me.id ? m.recipientId : m.senderId);
          let body = null;
          try {
            const key = await DDCrypto.conversationKey(mockIdentity.privateKey, other.publicKey);
            body = await DDCrypto.decryptFrom(key, m.ciphertext, m.iv);
          } catch { body = null; }
          out.push({
            id: m.id, mine: m.senderId === me.id,
            counterpart: other ? other.callsign : 'UNKNOWN',
            createdAt: m.createdAt, readAt: m.readAt, body,
          });
        }
        return { ok: true, sealed: false, unread, messages: out };
      },

      async markMessageRead(id) {
        const db = loadDB();
        const meId = getSession()?.operatorId;
        const m = (db.messages || []).find((x) => x.id === id);
        if (m && m.recipientId === meId && !m.readAt) {
          m.readAt = Date.now();
          saveDB(db);
        }
        return { ok: true };
      },

      async hideMessage(id) {
        const db = loadDB();
        const meId = getSession()?.operatorId;
        db.messages = (db.messages || []).filter(
          (m) => !(m.id === id && (m.senderId === meId || m.recipientId === meId))
        );
        saveDB(db);
        return { ok: true };
      },

      async operatorFingerprint(callsign) {
        const db = loadDB();
        const op = db.operators[String(callsign).trim().toLowerCase()];
        return op?.publicKey ? DDCrypto.fingerprint(op.publicKey) : null;
      },

      setSession(operatorId, callsign) {
        writeSession({ operatorId, callsign });
      },

      clearSession() {
        mockIdentity = null;
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
    MAPS,
    MODES,
    live, // true when talking to the real relay

    enlistOperator: (cs, pw) => backend.enlistOperator(cs, pw),
    authenticate: (cs, pw) => backend.authenticate(cs, pw),
    recoverWithCipher: (cs, ci, pw) => backend.recoverWithCipher(cs, ci, pw),
    getDossier: (operatorId) => backend.getDossier(operatorId),
    fileIntel: (cls, title, body, clearance, map, mode, zone, build) =>
      backend.fileIntel(cls, title, body, clearance, map, mode, zone, build),
    getIntelFeed: () => backend.getIntelFeed(),
    verifyIntel: (fileId) => backend.verifyIntel(fileId),
    annexIntel: (fileId, body) => backend.annexIntel(fileId, body),
    getAnnexes: (fileId) => backend.getAnnexes(fileId),
    getRoster: () => backend.getRoster(),
    getOperatorFile: (callsign) => backend.getOperatorFile(callsign),
    burnIntel: (fileId) => backend.burnIntel(fileId),
    appealBurn: (fileId, statement) => backend.appealBurn(fileId, statement),
    reinstateIntel: (fileId) => backend.reinstateIntel(fileId),
    getActivity: (limit) => backend.getActivity(limit),
    getTasking: () => backend.getTasking(),

    /* message drop — see js/crypto.js for the threat model */
    vaultOpen: () => backend.vaultOpen(),
    unsealVault: (passphrase) => backend.unsealVault(passphrase),
    myFingerprint: () => backend.myFingerprint(),
    sendMessage: (to, text) => backend.sendMessage(to, text),
    getMessages: () => backend.getMessages(),
    markMessageRead: (id) => backend.markMessageRead(id),
    hideMessage: (id) => backend.hideMessage(id),
    operatorFingerprint: (callsign) => backend.operatorFingerprint(callsign),
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
