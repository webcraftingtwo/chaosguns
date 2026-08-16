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

  /* current operator state, kept fresh across views */
  let currentDossier = null;
  let currentSeed = null;
  let pickedClass = null;
  let pickedTier = null;        // composer classification (null → own clearance)
  let channel = 'network';      // 'network' | 'compartment'
  let filterChip = 'ALL';       // ALL | class | MINE | WITHHELD
  let feedCache = null;         // last get_intel_feed result

  const MESSAGES = {
    CALLSIGN_IN_SERVICE: 'CALLSIGN ALREADY IN SERVICE — CHOOSE ANOTHER',
    CALLSIGN_NOT_ON_FILE: 'CALLSIGN NOT ON FILE — CHECK SPELLING OR ENLIST',
    CREDENTIALS_REJECTED: 'AUTHENTICATION FAILED — CREDENTIALS REJECTED',
    CIPHER_REJECTED: 'EXTRACTION CIPHER REJECTED — RECOVERY DENIED',
    BAD_CALLSIGN: 'CALLSIGN MUST BE 3–16 CHARACTERS: A–Z, 0–9, - OR _',
    BAD_PASS: 'PASSPHRASE MUST BE AT LEAST 6 CHARACTERS',
    PASS_MISMATCH: 'PASSPHRASE CONFIRMATION DOES NOT MATCH',
    BAD_CIPHER: 'ENTER THE FULL EXTRACTION CIPHER (DD-XXXX-XXXX-XXXX)',
    RELAY_DOWN: 'RELAY UNREACHABLE — CHECK CONNECTION AND RETRY',
    SESSION_INVALID: 'SESSION EXPIRED — RE-AUTHENTICATE',
    BAD_CLASS: 'SELECT A CLASS FOR THIS DROP',
    BAD_TITLE: 'SUBJECT MUST BE 4–80 CHARACTERS',
    BAD_BODY: 'REPORT MUST BE 20–2000 CHARACTERS',
    OWN_FILE: 'YOU CANNOT CONFIRM YOUR OWN DROP',
    ALREADY_VERIFIED: 'ALREADY CONFIRMED BY YOU',
    BAD_ANNEX: 'FIELD NOTES RUN 2–500 CHARACTERS',
    BAD_TAG: 'UNRECOGNIZED THEATER OR MODE TAG',
    BURNED: 'DROP IS UNDER BURN NOTICE',
    CONFLICTED: 'YOU CANNOT BOTH CONFIRM AND BURN A DROP',
    ALREADY_BURNED: 'ALREADY BURNED BY YOU',
    INSUFFICIENT_CLEARANCE: 'INSUFFICIENT CLEARANCE',
    NOT_ON_FILE: 'FILE NOT ON RECORD',
    KEY_REJECTED: 'KEY REJECTED — INVALID OR ALREADY BURNED',
    KEY_LIMIT: 'KEY LIMIT REACHED — 3 UNREDEEMED KEYS MAXIMUM',
    INSUFFICIENT_STANDING: 'TOP SECRET STANDING REQUIRED TO REDEEM',
    ALREADY_COMPARTMENTED: 'YOU ARE ALREADY INSIDE THE COMPARTMENT',
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

    // Anything that happened while the operator was away lands first.
    const disp = await intelDB.getDispatches();
    if (disp.ok && disp.dispatches?.length) {
      await showDispatches(disp.dispatches);
    }

    await renderDossier(dossier, seed);
  }

  function dispatchLine(d) {
    if (d.kind === 'INTEL_VERIFIED') {
      return `▮ DROP CONFIRMED — "${d.payload.title}" VERIFIED BY THE NETWORK`;
    }
    if (d.kind === 'CLEARANCE_GRANTED') {
      return `▮ CLEARANCE REVIEW PASSED — ${intelDB.TIERS[d.payload.clearanceIndex]} GRANTED`;
    }
    if (d.kind === 'ANNEX_ADDED') {
      return `▮ FIELD NOTE APPENDED — ${d.payload.author} ANNEXED "${d.payload.title}"`;
    }
    if (d.kind === 'BURN_NOTICE') {
      return `▮ BURN NOTICE — "${d.payload.title}" DISPUTED AND STRUCK BY THE NETWORK`;
    }
    return '▮ DISPATCH RECEIVED';
  }

  function showDispatches(dispatches) {
    const modal = $('#dispatch-modal');
    const lines = $('#dispatch-lines');
    const ack = $('#dispatch-ack');
    lines.innerHTML = '';
    ack.classList.add('hidden');
    modal.classList.remove('hidden');
    return new Promise(async (resolve) => {
      // typeSequence uses textContent — operator-authored titles are safe
      await FX.typeSequence(lines, dispatches.map(dispatchLine), { now: false }, {
        charDelay: 8, lineDelay: 260,
      });
      ack.classList.remove('hidden');
      ack.onclick = () => {
        modal.classList.add('hidden');
        resolve();
      };
    });
  }

  async function renderDossier(dossier, seed) {
    currentDossier = dossier;
    currentSeed = seed;
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
    const fill = $('#d-progress-fill');
    if (dossier.clearanceIndex === 4) {
      $('#d-progress-label').textContent = 'CEILING REACHED';
      $('#d-progress-count').textContent = '—';
      fill.style.width = '100%';
      $('#d-progress-note').textContent =
        'YOU ARE INSIDE THE COMPARTMENT. YOU MAY ISSUE KEYS TO OPERATORS AT TOP SECRET.';
    } else if (dossier.nextTier === 'COMPARTMENTED') {
      // the last door does not open by count
      $('#d-progress-label').textContent = 'COMPARTMENTED — BY INVITATION ONLY';
      $('#d-progress-count').textContent = '■';
      fill.style.width = '0%';
      $('#d-progress-note').textContent =
        'THE LAST DOOR DOES NOT OPEN FROM YOUR SIDE. A COMPARTMENT KEY MUST FIND YOU.';
    } else {
      $('#d-progress-label').textContent = `NEXT REVIEW: ${dossier.nextTier}`;
      $('#d-progress-count').textContent = `${dossier.verifiedCount} / ${need}`;
      fill.style.width = `${Math.min(100, (dossier.verifiedCount / need) * 100)}%`;
      $('#d-progress-note').textContent =
        dossier.verifiedCount === 0
          ? `CLEARANCE RISES WHEN YOUR FILED INTEL IS VERIFIED BY OTHER OPERATORS. ${need} VERIFIED FILES OPEN ${dossier.nextTier} REVIEW.`
          : `${need - dossier.verifiedCount} MORE VERIFIED FILES OPEN ${dossier.nextTier} REVIEW.`;
    }
    renderCompartmentZone(dossier);

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
        <span class="cls-count">${count === 0 ? 'NO FILES' : `${count} FILE${count === 1 ? '' : 'S'}`}</span>`;
      classesEl.appendChild(li);
    }

    /* --- relay status footer --- */
    if (intelDB.live) {
      $('.dossier-foot span').innerHTML =
        'RELAY LINK: <b>ESTABLISHED</b> — INTEL ARCHIVE ONLINE';
    } else {
      $('.dossier-foot span').innerHTML =
        'OFFLINE MODE — <b>LOCAL ARCHIVE ONLY</b>, NOTHING LEAVES THIS DEVICE';
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
   * COMPARTMENT ZONE — the clearance panel's invitation mechanics.
   * TOP SECRET operators get the key-redemption slot; COMPARTMENTED
   * operators get the key-issuing console.
   */
  function renderCompartmentZone(dossier) {
    const zone = $('#compartment-zone');
    zone.innerHTML = '';
    if (dossier.clearanceIndex === 3) {
      zone.innerHTML = `
        <div class="ck-row">
          <input id="ck-input" type="text" autocomplete="off" spellcheck="false"
                 maxlength="14" placeholder="CK-XXXX-XXXX" aria-label="compartment key">
          <button id="ck-redeem" class="ck-btn" type="button">REDEEM KEY</button>
        </div>
        <p id="ck-msg" class="ck-msg" aria-live="polite"></p>`;
      $('#ck-redeem').addEventListener('click', onRedeemKey);
      $('#ck-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') onRedeemKey();
      });
    } else if (dossier.clearanceIndex === 4) {
      zone.innerHTML = `
        <button id="ck-issue" class="ck-btn" type="button">ISSUE COMPARTMENT KEY</button>
        <div id="ck-out" class="ck-code hidden"></div>
        <p id="ck-msg" class="ck-msg" aria-live="polite"></p>
        <p class="ck-note">SINGLE USE. HAND IT TO ONE OPERATOR AT TOP SECRET — OFF-NETWORK.</p>`;
      $('#ck-issue').addEventListener('click', onIssueKey);
    }
  }

  async function onRedeemKey() {
    const input = $('#ck-input');
    const msg = $('#ck-msg');
    const code = input.value.trim();
    msg.classList.remove('ok');
    if (!/^CK-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(code)) {
      msg.textContent = '✕ ENTER THE FULL KEY (CK-XXXX-XXXX)';
      return;
    }
    const btn = $('#ck-redeem');
    btn.disabled = true;
    try {
      const res = await intelDB.redeemCompartmentKey(code);
      if (!res.ok) {
        msg.textContent = `✕ ${MESSAGES[res.code] || 'RELAY ERROR — TRY AGAIN'}`;
        return;
      }
      // the last promotion gets the full ceremony
      el.dossier.classList.add('hidden');
      el.flashText.textContent = 'COMPARTMENTED';
      el.flash.classList.remove('hidden');
      await FX.wait(FX.reducedMotion ? 400 : 1150);
      el.flash.classList.add('hidden');
      el.dossier.classList.remove('hidden');
      await renderDossier(res.dossier, currentSeed);
    } finally {
      btn.disabled = false;
    }
  }

  async function onIssueKey() {
    const btn = $('#ck-issue');
    const out = $('#ck-out');
    const msg = $('#ck-msg');
    msg.classList.remove('ok');
    msg.textContent = '';
    btn.disabled = true;
    try {
      const res = await intelDB.issueCompartmentKey();
      if (!res.ok) {
        msg.textContent = `✕ ${MESSAGES[res.code] || 'RELAY ERROR — TRY AGAIN'}`;
        return;
      }
      out.textContent = res.key;
      out.classList.remove('hidden');
      msg.classList.add('ok');
      msg.textContent = 'KEY ISSUED — SHOWN HERE ONCE';
    } finally {
      btn.disabled = false;
    }
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
     INTEL ARCHIVE — filing, feed, verification
     ============================================================ */

  const archiveEl = $('#archive');

  function fmtDropDate(ms) {
    return new Date(ms)
      .toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
      .toUpperCase();
  }

  async function openArchive() {
    el.dossier.classList.add('hidden');
    archiveEl.classList.remove('hidden');
    window.scrollTo(0, 0);
    $('#a-clearance').textContent = `CLEARANCE: ${currentDossier.clearance}`;
    setChannel('network');
    buildClassPicker();
    buildTierPicker();
    buildFilterChips();
    buildTagControls();

    const blocks = archiveEl.querySelectorAll('.decrypt');
    blocks.forEach((b) => b.classList.remove('decrypted'));
    FX.staggerIn(blocks, 110);
    await refreshFeed();
  }

  /* ---- channels: the open network vs. the compartment ---- */

  function setChannel(next) {
    channel = next;
    const inCompartment = channel === 'compartment';
    $('#ch-network').classList.toggle('active', !inCompartment);
    $('#ch-network').setAttribute('aria-selected', String(!inCompartment));
    $('#ch-compartment').classList.toggle('active', inCompartment);
    $('#ch-compartment').setAttribute('aria-selected', String(inCompartment));
    $('#feed-panel').classList.toggle('compartment', inCompartment);

    const insider = currentDossier.clearanceIndex === 4;
    $('#feed-title').childNodes[0].textContent = inCompartment
      ? 'COMPARTMENT CHANNEL '
      : 'NETWORK DROPS ';
    // filing into the compartment is insider-only; the composer stays
    // for the open network either way
    $('#compose-panel').hidden = inCompartment && !insider;
    $('#feed-filters').hidden = inCompartment && !insider;
    $('#compose-title').textContent = inCompartment ? 'FILE TO THE COMPARTMENT' : 'FILE NEW INTEL';
    $('#compose-note').textContent = inCompartment
      ? 'COMPARTMENT DROPS ARE EYES-ONLY — VISIBLE TO COMPARTMENTED OPERATORS ALONE.'
      : 'DROPS TRANSMIT AT THE SELECTED CLASSIFICATION. CONFIRMATION BY 2 OPERATORS MARKS INTEL VERIFIED AND ADVANCES YOUR STANDING.';
    $('#c-tier-row').hidden = inCompartment || currentDossier.clearanceIndex === 0;
  }

  /* ---- composer pickers ---- */

  function buildTierPicker() {
    const wrap = $('#c-tiers');
    wrap.innerHTML = '';
    const max = currentDossier.clearanceIndex;
    $('#c-tier-row').hidden = max === 0 || channel === 'compartment';
    if (pickedTier === null || pickedTier > max) pickedTier = max;
    for (let i = 0; i <= max; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tier-pick' + (pickedTier === i ? ' picked' : '');
      b.textContent = intelDB.TIERS[i];
      b.dataset.tier = String(i);
      b.addEventListener('click', () => {
        pickedTier = i;
        wrap.querySelectorAll('.tier-pick').forEach((n) =>
          n.classList.toggle('picked', Number(n.dataset.tier) === i)
        );
      });
      wrap.appendChild(b);
    }
  }

  async function closeArchive() {
    archiveEl.classList.add('hidden');
    // Contributions / clearance may have moved while filing; re-render
    // from the state the data layer last returned.
    el.dossier.classList.remove('hidden');
    await renderDossier(currentDossier, currentSeed);
  }

  function buildClassPicker() {
    const wrap = $('#c-classes');
    wrap.innerHTML = '';
    for (const cls of intelDB.CLASSES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'class-pick' + (pickedClass === cls ? ' picked' : '');
      b.textContent = cls;
      b.addEventListener('click', () => {
        pickedClass = cls;
        wrap.querySelectorAll('.class-pick').forEach((n) =>
          n.classList.toggle('picked', n.textContent === cls)
        );
      });
      wrap.appendChild(b);
    }
  }

  function composeMsg(text, ok = false) {
    const m = $('#c-msg');
    m.classList.toggle('ok', ok);
    m.textContent = text ? (ok ? text : `✕ ${text}`) : '';
  }

  async function onTransmit() {
    const title = $('#c-title').value.trim();
    const body = $('#c-body').value.trim();
    if (!pickedClass) return composeMsg(MESSAGES.BAD_CLASS);
    if (title.length < 4 || title.length > 80) return composeMsg(MESSAGES.BAD_TITLE);
    if (body.length < 20 || body.length > 2000) return composeMsg(MESSAGES.BAD_BODY);

    const tier = channel === 'compartment' ? 4 : (pickedTier ?? currentDossier.clearanceIndex);

    const btn = $('#c-submit');
    btn.disabled = true;
    composeMsg('… TRANSMITTING TO RELAY', true);
    try {
      const res = await intelDB.fileIntel(
        pickedClass, title, body, tier,
        $('#c-map').value || null, pickedMode
      );
      if (!res.ok) return composeMsg(MESSAGES[res.code] || 'RELAY ERROR — TRY AGAIN');
      currentDossier = res.dossier;
      $('#c-title').value = '';
      $('#c-body').value = '';
      composeMsg(
        channel === 'compartment'
          ? 'FILED TO THE COMPARTMENT — EYES ONLY'
          : `INTEL FILED — CLASSIFIED ${intelDB.TIERS[tier]} // AWAITING VERIFICATION`,
        true
      );
      await refreshFeed();
    } finally {
      btn.disabled = false;
    }
  }

  /* ---- theater + mode tag controls ---- */

  let pickedMode = null;

  function buildTagControls() {
    const mapSel = $('#c-map');
    if (mapSel.options.length === 1) {
      for (const m of intelDB.MAPS) {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = m;
        mapSel.appendChild(o);
      }
    }
    const modeWrap = $('#c-modes');
    modeWrap.innerHTML = '';
    for (const m of intelDB.MODES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mode-pick' + (pickedMode === m ? ' picked' : '');
      b.textContent = m;
      b.addEventListener('click', () => {
        pickedMode = pickedMode === m ? null : m; // tap again to clear
        modeWrap.querySelectorAll('.mode-pick').forEach((n) =>
          n.classList.toggle('picked', n.textContent === pickedMode)
        );
      });
      modeWrap.appendChild(b);
    }
    const filterSel = $('#f-map');
    if (filterSel.options.length === 1) {
      for (const m of intelDB.MAPS) {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = m;
        filterSel.appendChild(o);
      }
    }
  }

  /* ---- feed: fetch once, render per channel + filters ---- */

  function buildFilterChips() {
    const wrap = $('#f-chips');
    wrap.innerHTML = '';
    const chips = ['ALL', ...intelDB.CLASSES, 'MINE', 'WITHHELD'];
    for (const c of chips) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (filterChip === c ? ' picked' : '');
      b.textContent = c;
      b.addEventListener('click', () => {
        filterChip = c;
        wrap.querySelectorAll('.chip').forEach((n) =>
          n.classList.toggle('picked', n.textContent === c)
        );
        renderFeed();
      });
      wrap.appendChild(b);
    }
  }

  async function refreshFeed() {
    feedCache = await intelDB.getIntelFeed();
    renderFeed();
  }

  function renderFeed() {
    const feedEl = $('#feed');
    feedEl.innerHTML = '';
    const res = feedCache;
    if (!res) return;

    if (!res.ok) {
      const li = document.createElement('li');
      li.className = 'feed-empty';
      li.textContent =
        res.code === 'RELAY_DOWN'
          ? 'RELAY UNREACHABLE — ARCHIVE TEMPORARILY DARK'
          : MESSAGES[res.code] || 'ARCHIVE ERROR';
      feedEl.appendChild(li);
      return;
    }

    const all = res.files || [];
    const inCompartment = channel === 'compartment';
    const insider = currentDossier.clearanceIndex === 4;

    /* the compartment channel: eyes-only view of tier-4 files */
    if (inCompartment && !insider) {
      const count = all.filter((f) => f.clearanceIndex === 4).length;
      $('#feed-count').textContent = 'ACCESS DENIED';
      const li = document.createElement('li');
      li.className = 'compartment-denied';
      li.innerHTML = `
        <div class="cd-stamp">EYES ONLY</div>
        <div class="cd-line">${count} FILE${count === 1 ? '' : 'S'} INSIDE THE COMPARTMENT.</div>
        <div class="cd-sub">COMPARTMENTED CLEARANCE REQUIRED. ACCESS BY INVITATION — A KEY MUST FIND YOU.</div>`;
      feedEl.appendChild(li);
      return;
    }

    let files = inCompartment
      ? all.filter((f) => f.clearanceIndex === 4)
      : all;

    /* chip filter */
    if (filterChip === 'MINE') files = files.filter((f) => !f.locked && f.mine);
    else if (filterChip === 'WITHHELD') files = files.filter((f) => f.locked);
    else if (filterChip !== 'ALL') files = files.filter((f) => f.class === filterChip);

    /* theater filter — locked rows keep their tags, so they filter too */
    const mapF = $('#f-map').value;
    if (mapF) files = files.filter((f) => f.map === mapF);

    /* text search — locked rows carry no text, so a query excludes them */
    const q = $('#f-search').value.trim().toLowerCase();
    if (q) {
      files = files.filter((f) =>
        !f.locked &&
        (f.title.toLowerCase().includes(q) ||
         f.body.toLowerCase().includes(q) ||
         f.author.toLowerCase().includes(q))
      );
    }

    const withheld = (inCompartment ? [] : all).filter((f) => f.locked).length;
    $('#feed-count').textContent = inCompartment
      ? `${files.length} EYES-ONLY FILE${files.length === 1 ? '' : 'S'}`
      : `${all.length} ON FILE // ${withheld} WITHHELD`;

    if (files.length === 0) {
      const li = document.createElement('li');
      li.className = 'feed-empty';
      li.textContent = q
        ? 'NO MATCHES AT YOUR CLEARANCE.'
        : inCompartment
          ? 'THE COMPARTMENT IS EMPTY. FILE THE FIRST EYES-ONLY DROP.'
          : filterChip === 'MINE'
            ? 'NO DROPS OF YOURS ON FILE YET. THE COMPOSER IS RIGHT THERE.'
            : filterChip === 'WITHHELD'
              ? 'NOTHING WITHHELD — EVERYTHING ON FILE IS AT YOUR CLEARANCE.'
              : 'NO DROPS ON FILE AT ANY CLEARANCE. FILE THE FIRST.';
      feedEl.appendChild(li);
    } else {
      for (const f of files) {
        feedEl.appendChild(f.locked ? lockedDropRow(f) : dropRow(f));
      }
    }

    if (q && withheld > 0 && filterChip !== 'WITHHELD') {
      const note = document.createElement('li');
      note.className = 'feed-note';
      note.textContent = `${withheld} WITHHELD FILE${withheld === 1 ? '' : 'S'} NOT SEARCHABLE AT YOUR CLEARANCE`;
      feedEl.appendChild(note);
    }
  }

  /* All user-authored strings go in via textContent — never innerHTML.
     `rerender` is called after a state-changing action (confirm/burn) so
     the same row renderer serves the feed and operator files. */
  function dropRow(f, rerender = refreshFeed) {
    const li = document.createElement('li');
    li.className = 'drop' + (f.mine ? ' mine' : '') + (f.isBurned ? ' burned' : '');

    const head = document.createElement('div');
    head.className = 'drop-head';
    head.append(
      span('drop-class', f.class),
      span('drop-tier', intelDB.TIERS[f.clearanceIndex]),
    );
    if (f.isBurned) head.append(span('burn-stamp', 'BURN NOTICE'));
    if (f.map) head.append(span('drop-tag', f.map));
    if (f.mode) head.append(span('drop-tag', f.mode));
    const author = span('drop-author', '');
    author.append('BY ');
    const b = document.createElement('b');
    b.textContent = f.mine ? 'YOU' : f.author.toUpperCase();
    if (!f.mine) {
      b.classList.add('link');
      b.title = 'OPEN OPERATOR FILE';
      b.addEventListener('click', () => openProfile(f.author, currentView()));
    }
    author.appendChild(b);
    head.append(author, span('drop-date', fmtDropDate(f.createdAt)));

    const title = document.createElement('div');
    title.className = 'drop-title';
    title.textContent = f.title;

    const body = document.createElement('div');
    body.className = 'drop-body';
    body.textContent = f.body;

    const foot = document.createElement('div');
    foot.className = 'drop-foot';
    const verif = f.isBurned
      ? span('drop-verif struck',
          `✕ BURN NOTICE — STRUCK BY THE NETWORK (${f.burns} BURN${f.burns === 1 ? '' : 'S'})`)
      : span(
          'drop-verif' + (f.isVerified ? ' confirmed' : ''),
          f.isVerified
            ? `▮ VERIFIED — ${f.verifications} CONFIRMATION${f.verifications === 1 ? '' : 'S'}`
            : `VERIFICATION ${f.verifications} / ${intelDB.VERIFY_THRESHOLD}`
        );
    foot.appendChild(verif);
    if (!f.isBurned && f.burns > 0) {
      foot.appendChild(span('drop-burns', `BURNS ${f.burns} / ${intelDB.VERIFY_THRESHOLD}`));
    }

    if (f.mine) {
      foot.appendChild(span('drop-flag', 'YOUR DROP'));
    } else if (f.isBurned) {
      if (f.burnedByMe) foot.appendChild(span('drop-flag', 'BURNED BY YOU'));
    } else if (f.verifiedByMe) {
      foot.appendChild(span('drop-flag', 'CONFIRMED BY YOU'));
    } else if (f.burnedByMe) {
      foot.appendChild(span('drop-flag', 'BURNED BY YOU'));
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'verify-btn';
      btn.textContent = 'CONFIRM INTEL';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const r = await intelDB.verifyIntel(f.id);
        if (!r.ok && r.code !== 'ALREADY_VERIFIED') {
          btn.disabled = false;
          btn.textContent = MESSAGES[r.code] || 'RELAY ERROR';
          return;
        }
        await rerender();
      });
      foot.appendChild(btn);

      // burning takes a second tap — a burn is an accusation
      const burn = document.createElement('button');
      burn.type = 'button';
      burn.className = 'burn-btn';
      burn.textContent = 'BURN';
      let armed = false;
      burn.addEventListener('click', async () => {
        if (!armed) {
          armed = true;
          burn.textContent = 'CONFIRM BURN?';
          setTimeout(() => { armed = false; burn.textContent = 'BURN'; }, 3500);
          return;
        }
        burn.disabled = true;
        const r = await intelDB.burnIntel(f.id);
        if (!r.ok && r.code !== 'ALREADY_BURNED') {
          burn.disabled = false;
          burn.textContent = MESSAGES[r.code] || 'RELAY ERROR';
          return;
        }
        await rerender();
      });
      foot.appendChild(burn);
    }

    /* annex thread toggle */
    const annexBtn = document.createElement('button');
    annexBtn.type = 'button';
    annexBtn.className = 'annex-btn';
    annexBtn.textContent = `ANNEX (${f.annexes ?? 0})`;
    foot.appendChild(annexBtn);

    const thread = document.createElement('div');
    thread.className = 'annex-thread';
    thread.hidden = true;

    annexBtn.addEventListener('click', async () => {
      thread.hidden = !thread.hidden;
      annexBtn.classList.toggle('open', !thread.hidden);
      if (!thread.hidden && !thread.dataset.loaded) {
        await loadAnnexThread(f, thread, annexBtn);
      }
    });

    li.append(head, title, body, foot, thread);
    return li;
  }

  /* ---- annex threads: field notes under a drop ---- */

  function annexEntry(a) {
    const div = document.createElement('div');
    div.className = 'annex';
    const who = span('annex-author' + (a.mine ? ' mine' : ''), a.mine ? 'YOU' : a.author.toUpperCase());
    div.append(who, document.createTextNode(a.body));
    div.append(span('annex-date', fmtDropDate(a.createdAt)));
    return div;
  }

  async function loadAnnexThread(f, thread, annexBtn) {
    thread.dataset.loaded = '1';
    thread.innerHTML = '';
    const res = await intelDB.getAnnexes(f.id);
    if (!res.ok) {
      thread.appendChild(span('annex-empty', MESSAGES[res.code] || 'ANNEX RETRIEVAL FAILED'));
      return;
    }

    const list = document.createElement('div');
    if (res.annexes.length === 0) {
      list.appendChild(span('annex-empty', 'NO FIELD NOTES ON THIS DROP. CORROBORATE, CORRECT, OR UPDATE IT.'));
    } else {
      for (const a of res.annexes) list.appendChild(annexEntry(a));
    }
    thread.appendChild(list);

    const compose = document.createElement('div');
    compose.className = 'annex-compose';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = 'APPEND FIELD NOTE — CORROBORATE OR CORRECT';
    input.setAttribute('aria-label', 'append field note');
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'ck-btn';
    send.textContent = 'APPEND';
    const submit = async () => {
      const text = input.value.trim();
      if (text.length < 2) return;
      send.disabled = true;
      const r = await intelDB.annexIntel(f.id, text);
      send.disabled = false;
      if (!r.ok) {
        input.value = '';
        input.placeholder = MESSAGES[r.code] || 'RELAY ERROR — TRY AGAIN';
        return;
      }
      const empty = list.querySelector('.annex-empty');
      if (empty) empty.remove();
      list.appendChild(annexEntry(r.annex));
      annexBtn.textContent = `ANNEX (${r.count})`;
      input.value = '';
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    compose.append(input, send);
    thread.appendChild(compose);
  }

  function lockedDropRow(f) {
    const li = document.createElement('li');
    li.className = 'drop locked';

    const head = document.createElement('div');
    head.className = 'drop-head';
    head.append(
      span('drop-class', f.class),
      span('drop-tier', intelDB.TIERS[f.clearanceIndex]),
    );
    // tags survive redaction: you may know WHERE, never WHAT
    if (f.map) head.append(span('drop-tag', f.map));
    if (f.mode) head.append(span('drop-tag', f.mode));
    head.append(
      span('drop-author', 'AUTHOR WITHHELD'),
      span('drop-date', fmtDropDate(f.createdAt)),
    );

    const title = document.createElement('div');
    title.className = 'drop-title';
    const bar = document.createElement('span');
    bar.className = 'redact';
    bar.title = 'REDACTED — INSUFFICIENT CLEARANCE';
    bar.textContent = '█'.repeat(22);
    title.appendChild(bar);

    const body = document.createElement('div');
    body.className = 'drop-body';
    body.textContent =
      `PAYLOAD WITHHELD — ${intelDB.TIERS[f.clearanceIndex]} CLEARANCE REQUIRED.` +
      (f.annexes > 0 ? ` ${f.annexes} FIELD NOTE${f.annexes === 1 ? '' : 'S'} SEALED WITH IT.` : '');

    li.append(head, title, body);
    return li;
  }

  function span(cls, text) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  /* ============================================================
     OPERATOR FILE (profile)
     ============================================================ */

  const profileEl = $('#profile');
  let profileReturn = 'dossier';

  function currentView() {
    if (!archiveEl.classList.contains('hidden')) return 'archive';
    if (!rosterEl.classList.contains('hidden')) return 'roster';
    if (!profileEl.classList.contains('hidden')) return profileReturn; // burrow no deeper
    return 'dossier';
  }

  async function openProfile(callsign, returnTo = 'dossier', soft = false) {
    profileReturn = returnTo;
    el.dossier.classList.add('hidden');
    archiveEl.classList.add('hidden');
    rosterEl.classList.add('hidden');
    profileEl.classList.remove('hidden');
    if (!soft) window.scrollTo(0, 0);

    const res = await intelDB.getOperatorFile(callsign);
    if (!res.ok) {
      $('#p-callsign').textContent = 'NOT ON FILE';
      $('#p-files').innerHTML = '';
      return;
    }
    const p = res.profile;
    const seed = await deriveSeed(p.callsign);
    const hue = `hsl(${seed.hue} 72% 60%)`;

    $('#p-fileno').textContent = `FILE ${seed.operatorId.slice(3)}`;
    const insignia = $('#p-insignia');
    insignia.innerHTML = seed.insignia.svg; // trusted: our own SVG set
    insignia.style.color = hue;
    const nameEl = $('#p-callsign');
    nameEl.textContent = p.callsign.toUpperCase() + (p.me ? ' ◂ YOU' : '');
    nameEl.style.color = hue;
    const opid = $('#p-opid');
    opid.textContent = seed.operatorId;
    opid.style.color = hue;
    const tierEl = $('#p-tier');
    tierEl.textContent = `${intelDB.TIERS[p.clearanceIndex]} // ${rosterSpec(p.contributions)}`;
    tierEl.style.color = hue;

    const enlisted = new Date(p.enlistedAt)
      .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      .toUpperCase();
    const contact = fmtLastContact(p.lastContact);
    $('#p-meta').textContent =
      `ENLISTED ${enlisted} // MARK: ${seed.insignia.name} // ${contact.text}`;

    const stats = $('#p-stats');
    stats.innerHTML = '';
    stats.append(span('', `${p.drops} DROP${p.drops === 1 ? '' : 'S'} // ${p.verifiedCount} VERIFIED // ${p.annexes} FIELD NOTE${p.annexes === 1 ? '' : 'S'}`));
    if (p.burnsReceived > 0) {
      stats.append(span('p-burns', ` // ${p.burnsReceived} UNDER BURN NOTICE`));
    }

    $('#p-record-count').textContent =
      `${res.files.length} FILE${res.files.length === 1 ? '' : 'S'} // GATED AT YOUR CLEARANCE`;

    const list = $('#p-files');
    list.innerHTML = '';
    if (res.files.length === 0) {
      const li = document.createElement('li');
      li.className = 'feed-empty';
      li.textContent = 'NO DROPS ON RECORD FOR THIS OPERATOR.';
      list.appendChild(li);
    } else {
      const rerender = () => openProfile(callsign, returnTo, true);
      for (const f of res.files) {
        list.appendChild(f.locked ? lockedDropRow(f) : dropRow(f, rerender));
      }
    }

    if (!soft) {
      const blocks = profileEl.querySelectorAll('.decrypt');
      blocks.forEach((bl) => bl.classList.remove('decrypted'));
      FX.staggerIn(blocks, 110);
    } else {
      profileEl.querySelectorAll('.decrypt').forEach((bl) => bl.classList.add('decrypted'));
    }
  }

  async function closeProfile() {
    profileEl.classList.add('hidden');
    if (profileReturn === 'archive') {
      archiveEl.classList.remove('hidden');
      await refreshFeed(); // pick up any confirms/burns made from the profile
    } else if (profileReturn === 'roster') {
      await openRoster();
    } else {
      el.dossier.classList.remove('hidden');
    }
  }

  /* ============================================================
     OPERATOR ROSTER
     ============================================================ */

  const rosterEl = $('#roster');

  function fmtLastContact(ms) {
    const diff = Date.now() - ms;
    const min = Math.floor(diff / 60000);
    if (min < 5) return { text: 'ACTIVE NOW', live: true };
    if (min < 60) return { text: `LAST CONTACT ${min}M AGO`, live: false };
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return { text: `LAST CONTACT ${hrs}H AGO`, live: false };
    const days = Math.floor(hrs / 24);
    if (days <= 30) return { text: `LAST CONTACT ${days}D AGO`, live: false };
    return { text: 'DARK — 30+ DAYS SILENT', live: false };
  }

  function rosterSpec(contributions) {
    const total = intelDB.CLASSES.reduce((s, c) => s + (contributions[c] || 0), 0);
    if (total === 0) return 'SPECIALIZATION PENDING';
    const ranked = [...intelDB.CLASSES].sort(
      (a, b) => (contributions[b] || 0) - (contributions[a] || 0)
    );
    return `${ranked[0]} // ${ranked[1]}`;
  }

  async function openRoster() {
    el.dossier.classList.add('hidden');
    rosterEl.classList.remove('hidden');
    window.scrollTo(0, 0);

    const blocks = rosterEl.querySelectorAll('.decrypt');
    blocks.forEach((b) => b.classList.remove('decrypted'));
    FX.staggerIn(blocks, 110);

    const listEl = $('#roster-list');
    listEl.innerHTML = '';
    const res = await intelDB.getRoster();
    if (!res.ok) {
      listEl.appendChild(span('feed-empty', MESSAGES[res.code] || 'ROSTER UNAVAILABLE'));
      return;
    }

    $('#r-count').textContent = `${res.roster.length} OPERATOR${res.roster.length === 1 ? '' : 'S'} ON THE NETWORK`;

    // every row rendered in that operator's own seeded identity
    const seeds = await Promise.all(res.roster.map((o) => deriveSeed(o.callsign)));

    res.roster.forEach((op, i) => {
      const seed = seeds[i];
      const li = document.createElement('li');
      li.className = 'roster-row link' + (op.me ? ' me' : '');
      li.title = 'OPEN OPERATOR FILE';
      li.addEventListener('click', () => openProfile(op.callsign, 'roster'));
      const hue = `hsl(${seed.hue} 72% 60%)`;

      const insignia = document.createElement('span');
      insignia.className = 'roster-insignia';
      insignia.style.color = hue;
      insignia.innerHTML = seed.insignia.svg; // trusted: our own SVG set

      const name = document.createElement('span');
      name.className = 'roster-callsign';
      name.style.color = hue;
      name.textContent = op.callsign;
      if (op.me) {
        name.append(' ');
        name.appendChild(span('you-mark', '◂ YOU'));
      }
      name.appendChild(span('roster-opid', `${seed.operatorId} // MARK: ${seed.insignia.name}`));

      const tier = document.createElement('span');
      tier.className = 'roster-tier';
      tier.style.color = hue;
      tier.textContent = intelDB.TIERS[op.clearanceIndex];
      tier.appendChild(span('roster-spec', rosterSpec(op.contributions)));

      const stats = span('roster-stats',
        `${op.drops} DROP${op.drops === 1 ? '' : 'S'} // ${op.verifiedCount} VERIFIED // ${op.annexes} NOTE${op.annexes === 1 ? '' : 'S'}`);

      const contact = fmtLastContact(op.lastContact);
      const contactEl = span('roster-contact' + (contact.live ? ' live' : ''), contact.text);

      li.append(insignia, name, tier, stats, contactEl);
      listEl.appendChild(li);
    });
  }

  function closeRoster() {
    rosterEl.classList.add('hidden');
    el.dossier.classList.remove('hidden');
  }

  /* ============================================================
     SESSION / LOGOUT
     ============================================================ */

  function terminateSession() {
    intelDB.clearSession();
    currentDossier = null;
    currentSeed = null;
    // Back to a neutral terminal: reset accent, show the gate.
    document.documentElement.style.removeProperty('--accent-h');
    el.dossier.classList.add('hidden');
    archiveEl.classList.add('hidden');
    rosterEl.classList.add('hidden');
    profileEl.classList.add('hidden');
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
  $('#btn-archive').addEventListener('click', openArchive);
  $('#btn-to-dossier').addEventListener('click', closeArchive);
  $('#c-submit').addEventListener('click', onTransmit);
  $('#ch-network').addEventListener('click', () => { setChannel('network'); buildTierPicker(); renderFeed(); });
  $('#ch-compartment').addEventListener('click', () => { setChannel('compartment'); buildTierPicker(); renderFeed(); });
  $('#f-search').addEventListener('input', renderFeed);
  $('#f-map').addEventListener('change', renderFeed);
  $('#btn-roster').addEventListener('click', openRoster);
  $('#btn-roster-back').addEventListener('click', closeRoster);
  $('#btn-profile-back').addEventListener('click', closeProfile);

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
