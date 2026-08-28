/* ============================================================
   crypto.js — the message drop's cryptography. WebCrypto only,
   no libraries.
   ------------------------------------------------------------
   THREAT MODEL — what this does and does not protect.

   Protected:
   • Message bodies are AES-256-GCM ciphertext. The key comes from
     ECDH P-256 between the two operators' identity keys, so only
     those two can derive it. The server stores ciphertext only —
     a full database dump does not reveal message contents.
   • The private key never leaves the browser in the clear. It is
     wrapped with AES-GCM under a key derived from the passphrase
     by PBKDF2-SHA256 (210k iterations, per-operator salt).
   • The passphrase itself never reaches the server. The server is
     sent an *auth secret* — PBKDF2 of the passphrase under a
     different, auth-only salt — so the value the server bcrypts
     cannot be used to unwrap the vault.

   NOT protected — be honest about these:
   • Metadata. Who messaged whom, when, and message size are all
     plainly visible server-side.
   • Public key substitution. Keys are handed out by the server, so
     a malicious server could serve a fake key and read new
     messages (MITM). Operators can compare FINGERPRINTS shown on
     each dossier out-of-band to detect this.
   • Forward secrecy. Static ECDH means one compromised passphrase
     (plus the stored vault blob) exposes past messages.
   • The browser. XSS or a hostile extension defeats all of this.
   • Account recovery. Recovering via extraction cipher mints a NEW
     keypair — every earlier message becomes permanently unreadable.
     That is the cost of the server not being able to help you.
   ============================================================ */

'use strict';

const DDCrypto = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const PBKDF2_ROUNDS = 210000;

  const subtle = globalThis.crypto?.subtle;
  const available = Boolean(subtle);

  /* ---- small helpers ---- */
  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function randomBytes(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }

  async function pbkdf2(passphrase, saltBytes, usage) {
    const base = await subtle.importKey(
      'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits', 'deriveKey']
    );
    return subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      usage
    );
  }

  /**
   * The value handed to the server in place of the passphrase.
   * Derived under an auth-only salt so it is useless for unwrapping
   * the vault: the server never learns the real passphrase.
   */
  async function deriveAuthSecret(callsign, passphrase) {
    const salt = enc.encode(`dead-drop/auth/v1/${String(callsign).trim().toLowerCase()}`);
    const base = await subtle.importKey(
      'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' }, base, 256
    );
    return Array.from(new Uint8Array(bits))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** The key that wraps the operator's private key. Never transmitted. */
  function deriveVaultKey(passphrase, saltB64) {
    return pbkdf2(passphrase, unb64(saltB64), ['encrypt', 'decrypt']);
  }

  /* ---- identity keys ---- */

  async function generateIdentity() {
    return subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  }

  async function exportPublic(publicKey) {
    return b64(await subtle.exportKey('raw', publicKey));
  }

  function importPublic(publicB64) {
    return subtle.importKey(
      'raw', unb64(publicB64), { name: 'ECDH', namedCurve: 'P-256' }, true, []
    );
  }

  /** Wrap a private key for storage: AES-GCM under the vault key. */
  async function wrapPrivate(privateKey, vaultKey) {
    const pkcs8 = await subtle.exportKey('pkcs8', privateKey);
    const iv = randomBytes(12);
    const blob = await subtle.encrypt({ name: 'AES-GCM', iv }, vaultKey, pkcs8);
    return { blob: b64(blob), iv: b64(iv) };
  }

  /** Unwrap it again. Throws if the passphrase is wrong. */
  async function unwrapPrivate(blobB64, ivB64, vaultKey) {
    const pkcs8 = await subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(ivB64) }, vaultKey, unb64(blobB64)
    );
    return subtle.importKey(
      'pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']
    );
  }

  /** A fresh identity, wrapped and ready to register. */
  async function mintIdentity(passphrase) {
    const pair = await generateIdentity();
    const salt = randomBytes(16);
    const saltB64 = b64(salt);
    const vaultKey = await deriveVaultKey(passphrase, saltB64);
    const wrapped = await wrapPrivate(pair.privateKey, vaultKey);
    return {
      privateKey: pair.privateKey,
      publicKey: await exportPublic(pair.publicKey),
      vaultBlob: wrapped.blob,
      vaultIv: wrapped.iv,
      vaultSalt: saltB64,
    };
  }

  /* ---- message keys ---- */

  /**
   * The shared AES key for a conversation: ECDH against the other
   * operator's public key. Both sides derive the same key, so a
   * sender can still read what they sent.
   */
  async function conversationKey(myPrivateKey, theirPublicB64) {
    const theirs = await importPublic(theirPublicB64);
    return subtle.deriveKey(
      { name: 'ECDH', public: theirs },
      myPrivateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptFor(key, plaintext) {
    const iv = randomBytes(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
    return { ciphertext: b64(ct), iv: b64(iv) };
  }

  async function decryptFrom(key, ciphertextB64, ivB64) {
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(ciphertextB64)
    );
    return dec.decode(plain);
  }

  /**
   * A short human-comparable fingerprint of a public key, so two
   * operators can confirm out-of-band that the server handed them
   * the real key. Format: 3F4A 92C1 08D7 6BE2
   */
  async function fingerprint(publicB64) {
    const digest = await subtle.digest('SHA-256', unb64(publicB64));
    const hex = Array.from(new Uint8Array(digest).slice(0, 8))
      .map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return hex.match(/.{4}/g).join(' ');
  }

  return {
    available,
    deriveAuthSecret,
    deriveVaultKey,
    mintIdentity,
    unwrapPrivate,
    conversationKey,
    encryptFor,
    decryptFrom,
    fingerprint,
  };
})();
