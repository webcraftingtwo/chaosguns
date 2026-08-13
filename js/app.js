/* ============================================================
   app.js — orchestration: boot → gate → ACCESS GRANTED → dossier.
   UI only. All persistence goes through intelDB (see inteldb.js),
   all identity derivation through seed.js.
   ============================================================ */

'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  const el = {
    boot: $('#boot'),
    bootLines: $('#boot-lines'),
    bootSkip: $('#boot-skip'),
    gate: $('#gate'),
    gateMsg: $('#gate-msg'),
    gateSubmit: $('#gate-submit'),
    gateRecover: $('#gate-recover'),
    tabAuth: $('#tab-auth'),
    tabEnlist: $('#tab-enlist'),
    inCallsign: $('#in-callsign'),
    inPass: $('#in-pass'),
    inConfirm: $('#in-confirm'),
    inCipher: $('#in-cipher'),
    rowConfirm: $('#row-confirm'),
    rowCipher: $('#row-cipher'),
    labelPass: $('#label-pass'),
    flash: $('#flash'),
    flashText: $('#flash-text'),
    cipherModal: $('#cipher-modal'),
    cipherCode: $('#cipher-code'),
    cipherCopy: $('#cipher-copy'),
    cipherAck: $('#cipher-ack'),
    dossier: $('#dossier'),
    logout: $('#btn-logout'),
  };

  /* gate mode: 'auth' | 'enlist' | 'recover' */
  let mode = 'auth';

  const MESSAGES = {
    CALLSIGN_IN_SERVICE: 'CALLSIGN ALREADY IN SERVICE — CHOOSE ANOTHER',
    CALLSIGN_NOT_ON_FILE: 'CALLSIGN NOT ON FILE — CHECK SPELLING OR ENLIST',
    CREDENTIALS_REJECTED: 'AUTHENTICATION FAILED — CREDENTIALS REJECTED',
    CIPHER_REJECTED: 'EXTRACTION CIPHER REJECTED — RECOVERY DENIED',
    BAD_CALLSIGN: 'CALLSIGN MUST BE 3–16 CHARACTERS: A–Z, 0–9, - OR _',
    BAD_PASS: 'PASSPHRASE MUST BE AT LEAST 6 CHARACTERS',
    PASS_MISMATCH: 'PASSPHRASE CONFIRMATION DOES NOT MATCH',
    BAD_CIPHER: 'ENTER THE FULL EXTRACTION CIPHER (DD-XXXX-XXXX-XXXX)',
  };

  const CLASS_DESCRIPTIONS = {
    RECON: 'CAMPING SPOTS // ROUTES // SIGHTLINES // MAP INTEL',
    ENGINEER: 'LOADOUTS // WEAPON BUILDS // GADGETS // VEHICLE TECH',
    ASSAULT: 'ENGAGEMENT TACTICS // TTK // META COMBAT',
    MEDIC: 'BEGINNER TIPS // SURVIVAL // TEAM PLAY',
  };

  /* ============================================================
     BOOT SEQUENCE
     ============================================================ */

  const BOOT_LINES = [
    '> DEAD DROP FIELD TERMINAL v2.4.1',
    '> ESTABLISHING SECURE CONNECTION ........ OK',
    '> ROUTING THROUGH ████ RELAYS ........... OK',
    '> HANDSHAKE ACCEPTED — NEED-TO-KNOW ENFORCED',
    '> TERMINAL READY.',
  ];

  async function runBoot() {
    const seenBefore = localStorage.getItem('deaddrop.boot.seen') === '1';
    const skip = { now: seenBefore && FX.reducedMotion };

    const skipNow = () => { skip.now = true; };
    el.bootSkip.addEventListener('click', skipNow);
    window.addEventListener('keydown', skipNow, { once: true });

    // Returning operators get a faster cadence; anyone can skip.
    await FX.typeSequence(el.bootLines, BOOT_LINES, skip, {
      charDelay: seenBefore ? 5 : 11,
      lineDelay: seenBefore ? 60 : 170,
    });
    await FX.wait(skip.now ? 80 : 340);

    localStorage.setItem('deaddrop.boot.seen', '1');
    window.removeEventListener('keydown', skipNow);
    el.boot.classList.add('hidden');
  }

  /* ============================================================
     SEEDED THEME
     ============================================================ */

  function applyAccent(hue) {
    document.documentElement.style.setProperty('--accent-h', String(hue));
  }

  /* ============================================================
     GATE (access terminal)
     ============================================================ */

  function setMode(next) {
    mode = next;
    el.gateMsg.textContent = '';
    el.gateMsg.classList.remove('ok');

    el.tabAuth.classList.toggle('active', mode === 'auth');
    el.tabAuth.setAttribute('aria-selected', String(mode === 'auth'));
    el.tabEnlist.classList.toggle('active', mode === 'enlist');
    el.tabEnlist.setAttribute('aria-selected', String(mode === 'enlist'));

    el.rowConfirm.hidden = mode === 'auth';
    el.rowCipher.hidden = mode !== 'recover';
    el.labelPass.textContent =
      mode === 'auth' ? 'PASSPHRASE'
      : mode === 'enlist' ? 'CHOOSE PASSPHRASE'
      : 'NEW PASSPHRASE';
    el.gateSubmit.textContent =
      mode === 'auth' ? 'AUTHENTICATE'
      : mode === 'enlist' ? 'ENLIST'
      : 'RESET CREDENTIALS';
    el.gateRecover.textContent =
      mode === 'recover'
        ? 'BACK TO AUTHENTICATION'
        : 'PASSPHRASE COMPROMISED? RECOVER VIA EXTRACTION CIPHER';
  }

  function fail(text) {
    el.gateMsg.classList.remove('ok');
    el.gateMsg.textContent = `✕ ${text}`;
  }

  function validCallsign(cs) {
    return /^[a-z0-9_-]{3,16}$/i.test(cs.trim());
  }

  async function onSubmit() {
    const callsign = el.inCallsign.value.trim();
    const pass = el.inPass.value;

    if (!validCallsign(callsign)) return fail(MESSAGES.BAD_CALLSIGN);
    if (pass.length < 6) return fail(MESSAGES.BAD_PASS);
    if (mode !== 'auth' && pass !== el.inConfirm.value) {
      return fail(MESSAGES.PASS_MISMATCH);
    }
    if (mode === 'recover' && !/^DD-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(el.inCipher.value.trim())) {
      return fail(MESSAGES.BAD_CIPHER);
    }

    el.gateSubmit.disabled = true;
    el.gateMsg.classList.add('ok');
    el.gateMsg.textContent = '… VERIFYING WITH RELAY';

    try {
      let res;
      if (mode === 'enlist') {
        res = await intelDB.enlistOperator(callsign, pass);
      } else if (mode === 'recover') {
        res = await intelDB.recoverWithCipher(callsign, el.inCipher.value.trim(), pass);
      } else {
        res = await intelDB.authenticate(callsign, pass);
      }

      if (!res.ok) return fail(MESSAGES[res.code] || 'RELAY ERROR — TRY AGAIN');

      intelDB.setSession(res.dossier.id, res.dossier.callsign);

      if (res.cipher) {
        // ENLIST (or recovery reissue): one-time cipher hand-off first,
        // then the reveal is the payoff.
        await showCipherHandoff(res.cipher, mode === 'recover');
      }
      await enterDossier(res.dossier, mode === 'enlist' ? 'CLEARANCE GRANTED' : 'ACCESS GRANTED');
    } finally {
      el.gateSubmit.disabled = false;
    }
  }

  /* ============================================================
     EXTRACTION CIPHER HAND-OFF (one-time)
     ============================================================ */

  function showCipherHandoff(cipher, isReissue) {
    el.cipherCode.textContent = cipher;
    if (isReissue) {
      $('#cipher-title').textContent = 'NEW EXTRACTION CIPHER ISSUED';
    }
    el.cipherModal.classList.remove('hidden');
    return new Promise((resolve) => {
      el.cipherCopy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(cipher);
          el.cipherCopy.textContent = 'COPIED — NOW STORE IT OFF-NETWORK';
        } catch {
          el.cipherCopy.textContent = 'CLIPBOARD BLOCKED — WRITE IT DOWN';
        }
      };
      el.cipherAck.onclick = () => {
        el.cipherModal.classList.add('hidden');
        el.cipherCode.textContent = 'DD-████-████-████'; // never keep it in the DOM
        resolve();
      };
    });
  }

  /* ============================================================
     ACCESS GRANTED → DOSSIER REVEAL
     ============================================================ */

  async function enterDossier(dossier, stampText) {
    const seed = await deriveSeed(dossier.callsign);
    applyAccent(seed.hue);

    el.gate.classList.add('hidden');

    // The decisive beat.
    el.flashText.textContent = stampText;
    el.flash.classList.remove('hidden');
    await FX.wait(FX.reducedMotion ? 400 : 1150);
    el.flash.classList.add('hidden');

    await renderDossier(dossier, seed);
  }

  async function renderDossier(dossier, seed) {
    /* --- identity --- */
    $('#d-insignia').innerHTML = seed.insignia.svg;
    $('#d-insignia-name').textContent = `MARK: ${seed.insignia.name}`;
    $('#d-fileno').textContent = `FILE ${seed.operatorId.slice(3)}`;
    const enlisted = new Date(dossier.enlistedAt);
    $('#d-enlisted').textContent =
      `ENLISTED ${enlisted.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}`;

    /* --- clearance --- */
    $('#d-clearance').textContent = dossier.clearance;
    const need = dossier.nextRequirement;
    if (need !== null) {
      $('#d-progress-label').textContent = `NEXT REVIEW: ${dossier.nextTier}`;
      $('#d-progress-count').textContent = `${dossier.verifiedCount} / ${need}`;
      $('#d-progress-note').textContent =
        dossier.verifiedCount === 0
          ? `CLEARANCE RISES WHEN YOUR FILED INTEL IS VERIFIED BY OTHER OPERATORS. ${need} VERIFIED FILES OPEN ${dossier.nextTier} REVIEW.`
          : `${need - dossier.verifiedCount} MORE VERIFIED FILES OPEN ${dossier.nextTier} REVIEW.`;
    } else {
      $('#d-progress-label').textContent = 'CEILING REACHED';
      $('#d-progress-count').textContent = '—';
    }

    /* --- specialization --- */
    const specEl = $('#d-spec');
    const specNote = $('#d-spec-note');
    if (dossier.specialization) {
      specEl.classList.remove('pending');
      specEl.innerHTML = '';
      specEl.append(
        document.createTextNode(`${dossier.specialization.primary} `),
      );
      const sec = document.createElement('span');
      sec.className = 'spec-secondary';
      sec.textContent = `// ${dossier.specialization.secondary}`;
      specEl.appendChild(sec);
      specNote.textContent = 'ASSIGNED FROM YOUR VERIFIED FIELD CONTRIBUTIONS. IT SHIFTS AS YOUR WORK DOES.';
    } else {
      specEl.classList.add('pending');
      specEl.textContent = 'PENDING — DETERMINED BY FIELD ACTIVITY';
      specNote.textContent = 'SPECIALIZATION IS EARNED, NOT CHOSEN. FILE INTEL — THE NETWORK DECIDES WHAT YOU ARE.';
    }

    // Class roster, primary first when one exists.
    const classesEl = $('#d-classes');
    classesEl.innerHTML = '';
    const ordered = [...intelDB.CLASSES].sort((a, b) => {
      const ca = dossier.contributions[a] || 0;
      const cb = dossier.contributions[b] || 0;
      return cb - ca;
    });
    for (const cls of ordered) {
      const li = document.createElement('li');
      li.className = 'spec-class';
      if (dossier.specialization && dossier.specialization.primary === cls) {
        li.classList.add('primary');
      }
      const count = dossier.contributions[cls] || 0;
      li.innerHTML = `
        <span class="cls-name">${cls}</span>
        <span class="cls-desc">${CLASS_DESCRIPTIONS[cls]}</span>
        <span class="cls-count">${count === 0 ? 'NO FILES' : `${count} FILES`}</span>`;
      classesEl.appendChild(li);
    }

    /* --- clearance ladder + teasers --- */
    const ladderRes = await intelDB.getClearanceLadder(dossier.id);
    const ladderEl = $('#d-ladder');
    ladderEl.innerHTML = '';
    if (ladderRes.ok) {
      for (const tier of ladderRes.ladder) {
        const li = document.createElement('li');
        li.className = `ladder-tier ${tier.state}`;
        const body =
          tier.state === 'locked'
            ? `<span class="tier-lock">LOCKED</span>${teaserHTML(tier.teaser)}`
            : tier.state === 'current'
              ? `<span class="tier-clear">ACTIVE CLEARANCE — FULL ACCESS AT THIS TIER.</span>`
              : `<span class="tier-clear">CLEARED.</span>`;
        li.innerHTML = `
          <span class="tier-pip"></span>
          <span class="tier-name">${tier.tier}</span>
          <span class="tier-body">${body}</span>`;
        ladderEl.appendChild(li);
      }
    }

    /* --- materialize --- */
    el.dossier.classList.remove('hidden');
    window.scrollTo(0, 0);

    const blocks = el.dossier.querySelectorAll('.decrypt');
    blocks.forEach((b) => b.classList.remove('decrypted'));

    const callsignEl = $('#d-callsign');
    const opidEl = $('#d-opid');
    callsignEl.textContent = dossier.callsign.toUpperCase();
    opidEl.textContent = seed.operatorId;

    await FX.staggerIn(blocks, 110);
    // Decrypt-scramble the two identity strings last — the signature beat.
    await Promise.all([
      FX.scramble(callsignEl, dossier.callsign.toUpperCase(), 700),
      FX.scramble(opidEl, seed.operatorId, 550),
    ]);
  }

  /**
   * Teaser copy → HTML. `[[...]]` segments become physical black-bar
   * redactions; the text under the bar is only block characters, so
   * nothing real is ever present to reveal.
   */
  function teaserHTML(teaser) {
    if (!teaser) return '';
    return escapeHTML(teaser).replace(/\[\[(.+?)\]\]/g, (_, inner) => {
      const width = Math.max(2, inner.length);
      return `<span class="redact" title="REDACTED — INSUFFICIENT CLEARANCE">${'█'.repeat(width)}</span>`;
    });
  }

  function escapeHTML(s) {
    return s.replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* ============================================================
     SESSION / LOGOUT
     ============================================================ */

  function terminateSession() {
    intelDB.clearSession();
    // Back to a neutral terminal: reset accent, show the gate.
    document.documentElement.style.removeProperty('--accent-h');
    el.dossier.classList.add('hidden');
    el.gate.classList.remove('hidden');
    el.inPass.value = '';
    el.inConfirm.value = '';
    el.inCipher.value = '';
    setMode('auth');
    el.gateMsg.classList.add('ok');
    el.gateMsg.textContent = 'SESSION TERMINATED — TERMINAL SECURE';
  }

  /* ============================================================
     WIRE-UP + ENTRY
     ============================================================ */

  el.tabAuth.addEventListener('click', () => setMode('auth'));
  el.tabEnlist.addEventListener('click', () => setMode('enlist'));
  el.gateRecover.addEventListener('click', () =>
    setMode(mode === 'recover' ? 'auth' : 'recover')
  );
  el.gateSubmit.addEventListener('click', onSubmit);
  el.logout.addEventListener('click', terminateSession);

  // ENTER anywhere in the gate submits (no <form>, no page reload).
  [el.inCallsign, el.inPass, el.inConfirm, el.inCipher].forEach((input) =>
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onSubmit();
    })
  );

  async function init() {
    setMode('auth');
    await runBoot();

    // Remembered operator → straight to the dossier.
    const session = intelDB.getSession();
    if (session) {
      const res = await intelDB.getDossier(session.operatorId);
      if (res.ok) {
        await enterDossier(res.dossier, `WELCOME BACK, ${res.dossier.callsign.toUpperCase()}`);
        return;
      }
      intelDB.clearSession();
    }
    el.gate.classList.remove('hidden');
    el.inCallsign.focus();
  }

  init();
})();
