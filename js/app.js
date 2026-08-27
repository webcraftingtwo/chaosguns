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
    NOT_YOUR_DROP: 'ONLY THE AUTHOR MAY APPEAL',
    NOT_BURNED: 'NOTHING TO APPEAL — DROP IS NOT BURNED',
    ALREADY_APPEALED: 'AN APPEAL IS ALREADY ON FILE',
    BAD_APPEAL: 'APPEAL MUST RUN 10–500 CHARACTERS',
    NO_APPEAL: 'NO APPEAL ON FILE FOR THIS DROP',
    ALREADY_REINSTATED: 'YOU HAVE ALREADY BACKED THIS APPEAL',
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

    const skipNow = () => { skip.now = true; el.boot.classList.add('rushed'); };
    el.bootSkip.addEventListener('click', skipNow);
    window.addEventListener('keydown', skipNow, { once: true });

    // Let the emblem draw before the log starts (skippable, and
    // returning operators get a shorter beat).
    if (seenBefore) el.boot.classList.add('rushed');
    if (!skip.now && !FX.reducedMotion) await FX.wait(seenBefore ? 260 : 1250);

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
      await enterDossier(
        res.dossier,
        mode === 'enlist' ? 'CLEARANCE GRANTED' : 'ACCESS GRANTED',
        mode === 'enlist'
          ? ['> OPERATOR RECORD CREATED',
             '> CLEARANCE ASSIGNED — RESTRICTED',
             '> BUILDING DOSSIER…']
          : ['> IDENTITY CONFIRMED',
             '> CLEARANCE VERIFIED',
             '> DECRYPTING DOSSIER…']
      );
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

  /**
   * The ACCESS GRANTED beat. Paced deliberately: the stamp lands,
   * the terminal reports what it is doing, then the frame collapses
   * — it must never blink in and out.
   */
  async function flashStamp(stampText, steps = []) {
    el.flashText.textContent = stampText;
    const stepsEl = $('#flash-steps');
    stepsEl.innerHTML = '';
    el.flash.classList.remove('hidden', 'closing');

    if (FX.reducedMotion) {
      steps.forEach((s) => {
        const d = document.createElement('div');
        d.className = 'boot-line done';
        d.textContent = s;
        stepsEl.appendChild(d);
      });
      await FX.wait(600);
    } else {
      await FX.wait(640);                       // stamp lands and settles
      await FX.typeSequence(stepsEl, steps, { now: false }, {
        charDelay: 7, lineDelay: 120,
      });
      stepsEl.querySelectorAll('.boot-line').forEach((n) => n.classList.add('done'));
      await FX.wait(420);                       // hold on the finished state
    }

    el.flash.classList.add('closing');
    await FX.wait(FX.reducedMotion ? 60 : 430); // frame collapses
    el.flash.classList.add('hidden');
    el.flash.classList.remove('closing');
  }

  async function enterDossier(dossier, stampText, steps) {
    const seed = await deriveSeed(dossier.callsign);
    applyAccent(seed.hue);

    el.gate.classList.add('hidden');

    // The decisive beat.
    await flashStamp(stampText, steps);

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
    if (d.kind === 'APPEAL_FILED') {
      return `▮ APPEAL FILED — ${d.payload.author} DISPUTES YOUR BURN ON "${d.payload.title}"`;
    }
    if (d.kind === 'BURN_LIFTED') {
      return `▮ BURN LIFTED — "${d.payload.title}" REINSTATED BY THE NETWORK`;
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

    /* --- tasking + ticker (independent; never block the reveal) --- */
    renderTasking();
    renderTicker();

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

  /* ============================================================
     NETWORK ACTIVITY TICKER + STANDING TASKING
     ============================================================ */

  function fmtAgo(ms) {
    const min = Math.floor((Date.now() - ms) / 60000);
    if (min < 1) return 'JUST NOW';
    if (min < 60) return `${min}M AGO`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs}H AGO`;
    return `${Math.floor(hrs / 24)}D AGO`;
  }

  const TICKER_VERBS = {
    FILED: 'FILED',
    CONFIRMED: 'CONFIRMED',
    BURNED: 'BURNED',
    ANNEXED: 'ANNEXED',
    ENLISTED: 'ENLISTED WITH THE NETWORK',
    CLEARED: 'CLEARED TO',
  };

  function tickerRow(e) {
    const li = document.createElement('li');
    li.className = 'tick' + (e.me ? ' me' : '') + (e.kind === 'BURNED' ? ' burned' : '');
    li.appendChild(span('tick-when', fmtAgo(e.at)));

    const line = document.createElement('span');
    line.append(span('tick-actor', e.me ? 'YOU' : e.actor.toUpperCase()), ' ');

    if (e.kind === 'ENLISTED') {
      line.append(span('tick-verb', TICKER_VERBS.ENLISTED));
    } else if (e.kind === 'CLEARED') {
      line.append(span('tick-verb', TICKER_VERBS.CLEARED), ' ',
                  span('tick-title', intelDB.TIERS[e.clearanceIndex]));
    } else {
      line.append(span('tick-verb', TICKER_VERBS[e.kind] || 'MOVED'), ' ');
      if (e.withheld) {
        // the event is public, the subject is not
        const bar = span('tick-withheld', '█'.repeat(14));
        bar.title = 'REDACTED — INSUFFICIENT CLEARANCE';
        line.append(bar, ' ', span('tick-verb', `(${intelDB.TIERS[e.clearanceIndex]})`));
      } else {
        line.append(span('tick-title', `"${e.title}"`));
      }
    }
    li.appendChild(line);
    return li;
  }

  async function renderTicker() {
    const list = $('#d-ticker');
    list.innerHTML = '';
    const res = await intelDB.getActivity(24);
    if (!res.ok || !res.events?.length) {
      const li = document.createElement('li');
      li.className = 'tasking-empty';
      li.textContent = res.ok
        ? 'THE WIRE IS QUIET. NOTHING HAS MOVED YET.'
        : 'RELAY UNREACHABLE — WIRE DARK.';
      list.appendChild(li);
      return;
    }
    for (const e of res.events) list.appendChild(tickerRow(e));
  }

  function task(text, cls = '') {
    const li = document.createElement('li');
    li.className = `task ${cls}`.trim();
    const body = document.createElement('span');
    body.append(...text);
    li.appendChild(body);
    return li;
  }

  function strong(t) {
    const b = document.createElement('b');
    b.textContent = t;
    return b;
  }

  async function renderTasking() {
    const list = $('#d-tasking');
    list.innerHTML = '';
    const t = await intelDB.getTasking();
    if (!t.ok) {
      const li = document.createElement('li');
      li.className = 'tasking-empty';
      li.textContent = 'RELAY UNREACHABLE — NO TASKING AVAILABLE.';
      list.appendChild(li);
      return;
    }

    const items = [];

    // your burned drops are the most urgent thing on your plate
    for (const b of t.burnedMine || []) {
      items.push(task([
        strong('APPEAL A BURN — '),
        document.createTextNode(`"${b.title}" was struck. State your case in the archive and the network can reinstate it.`),
      ], 'urgent'));
    }

    if ((t.appeals || []).length) {
      const a = t.appeals[0];
      items.push(task([
        strong(`${t.appeals.length} APPEAL${t.appeals.length === 1 ? '' : 'S'} AWAIT REVIEW — `),
        document.createTextNode(`${a.author} disputes the burn on "${a.title}" (${a.reinstates}/${intelDB.VERIFY_THRESHOLD} backing). Read it and decide.`),
      ], 'urgent'));
    }

    if ((t.awaiting || []).length) {
      const a = t.awaiting[0];
      items.push(task([
        strong(`${t.awaiting.length} DROP${t.awaiting.length === 1 ? '' : 'S'} AWAIT CONFIRMATION — `),
        document.createTextNode('start with '),
        (() => { const s = span('task-ref', `"${a.title}"`); return s; })(),
        document.createTextNode(` by ${a.author}. Confirmations are how other operators climb.`),
      ]));
    }

    for (const m of (t.mine || []).slice(0, 2)) {
      items.push(task([
        strong('YOUR DROP IS SHORT — '),
        document.createTextNode(`"${m.title}" sits at ${m.verifications}/${intelDB.VERIFY_THRESHOLD}. It needs other operators to walk it.`),
      ], 'quiet'));
    }

    if (t.nextRequirement !== null && t.nextRequirement !== undefined) {
      const left = Math.max(0, t.nextRequirement - t.verifiedCount);
      items.push(task([
        strong(`${left} VERIFIED FILE${left === 1 ? '' : 'S'} TO ${intelDB.TIERS[t.clearanceIndex + 1]} — `),
        document.createTextNode('file intel worth confirming and the ladder moves.'),
      ], 'quiet'));
    } else if (t.clearanceIndex === 3) {
      items.push(task([
        strong('COMPARTMENTED IS BY INVITATION — '),
        document.createTextNode('keep filing. A key has to find you.'),
      ], 'quiet'));
    }

    if (t.withheldCount > 0) {
      items.push(task([
        strong(`${t.withheldCount} FILE${t.withheldCount === 1 ? '' : 'S'} SIT ABOVE YOUR CLEARANCE — `),
        document.createTextNode('the archive shows you where they are, never what they say.'),
      ], 'quiet'));
    }

    if (t.topClass) {
      items.push(task([
        strong(`${t.topClass} IS YOUR LANE — `),
        document.createTextNode(`${t.specReads} ${t.topClass} file${t.specReads === 1 ? '' : 's'} on the network you did not write.`),
      ], 'quiet'));
    } else {
      items.push(task([
        strong('SPECIALIZATION PENDING — '),
        document.createTextNode('file your first drop and the network starts deciding what you are.'),
      ]));
    }

    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'tasking-empty';
      li.textContent = 'NOTHING OUTSTANDING. THE NETWORK IS SATISFIED — FOR NOW.';
      list.appendChild(li);
      return;
    }
    items.slice(0, 6).forEach((el2) => list.appendChild(el2));
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
      await flashStamp('COMPARTMENTED', [
        '> KEY VERIFIED AND BURNED',
        '> COMPARTMENT OPENED — EYES ONLY',
        '> RESEALING DOSSIER…',
      ]);
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
    buildMapPicker();

    const blocks = archiveEl.querySelectorAll('.decrypt');
    blocks.forEach((b) => b.classList.remove('decrypted'));
    FX.staggerIn(blocks, 110);
    await refreshFeed();
  }

  /* ---- channels: the open network vs. the compartment ---- */

  function setChannel(next) {
    channel = next;
    const inCompartment = channel === 'compartment';
    const inMap = channel === 'map';
    const inArmory = channel === 'armory';

    for (const [id, on] of [
      ['#ch-network', channel === 'network'],
      ['#ch-compartment', inCompartment],
      ['#ch-map', inMap],
      ['#ch-armory', inArmory],
    ]) {
      $(id).classList.toggle('active', on);
      $(id).setAttribute('aria-selected', String(on));
    }

    // map and armory are their own layouts; the composer/feed grid stands down
    $('#map-wrap').classList.toggle('hidden', !inMap);
    $('#armory-wrap').classList.toggle('hidden', !inArmory);
    document.querySelector('.archive-grid').classList.toggle('hidden', inMap || inArmory);
    if (inMap || inArmory) return;

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
        // ENGINEER is the loadout class — open the bench for them
        if (cls === 'ENGINEER' && !buildOn) setBuildOn(true);
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
        $('#c-map').value || null, pickedMode,
        $('#c-map').value ? ($('#c-zone').value || null) : null,
        currentBuild()
      );
      if (!res.ok) return composeMsg(MESSAGES[res.code] || 'RELAY ERROR — TRY AGAIN');
      currentDossier = res.dossier;
      $('#c-title').value = '';
      $('#c-body').value = '';
      resetBuild();
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
    syncZonePicker();
  }

  /* Zone options come from the theater's schematic — a drop can only
     be pinned to a zone that exists on the map. */
  function syncZonePicker() {
    const map = $('#c-map').value;
    const row = $('#c-zone-row');
    const sel = $('#c-zone');
    const schematic = MAP_SCHEMATICS[map];
    row.hidden = !schematic || channel === 'compartment';
    sel.innerHTML = '<option value="">— ANYWHERE ON THE MAP —</option>';
    if (!schematic) return;
    for (const z of schematic.zones) {
      const o = document.createElement('option');
      o.value = z.name;
      o.textContent = z.name;
      sel.appendChild(o);
    }
  }

  /* ============================================================
     ARMORY — weapon builds rendered as blueprint schematics
     ============================================================ */

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * A build → a blueprint panel: archetype outline, numbered pins on
   * the filled slots, numbered legend beneath. Outline markup comes
   * from weapons.js (ours); every operator-supplied string goes in
   * through textContent.
   */
  function renderBlueprint(build) {
    const arch = archetypeFor(build.weapon);
    const meta = weaponByName(build.weapon);
    const slots = build.slots || {};

    const wrap = document.createElement('div');
    wrap.className = 'blueprint';

    const head = document.createElement('div');
    head.className = 'bp-head';
    head.append(span('bp-weapon', build.weapon));
    if (meta) head.append(span('', meta.family));
    const filled = arch.slots.filter((s) => slots[s.key]).length;
    head.append(span('bp-fill', `${filled} / ${arch.slots.length} SLOTS FITTED`));
    wrap.appendChild(head);

    const stage = document.createElement('div');
    stage.className = 'bp-stage';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', arch.viewBox);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${build.weapon} build schematic`);
    svg.innerHTML = arch.paths; // trusted: weapons.js

    let n = 0;
    for (const s of arch.slots) {
      if (!slots[s.key]) continue;
      n += 1;
      const [x, y] = s.at;
      const pin = document.createElementNS(SVG_NS, 'circle');
      pin.setAttribute('class', 'bp-pin');
      pin.setAttribute('cx', x);
      pin.setAttribute('cy', y);
      pin.setAttribute('r', 10);
      const num = document.createElementNS(SVG_NS, 'text');
      num.setAttribute('class', 'bp-pin-num');
      num.setAttribute('x', x);
      num.setAttribute('y', y + 4);
      num.textContent = String(n);
      svg.append(pin, num);
    }
    stage.appendChild(svg);
    wrap.appendChild(stage);

    const legend = document.createElement('ol');
    legend.className = 'bp-legend';
    let m = 0;
    for (const s of arch.slots) {
      const val = slots[s.key];
      const li = document.createElement('li');
      if (val) {
        m += 1;
        li.append(span('bp-num', String(m)));
      } else {
        li.className = 'empty';
        li.append(span('bp-num', '–'));
      }
      li.append(span('bp-slot', s.key), span('bp-val', val || 'EMPTY'));
      legend.appendChild(li);
    }
    wrap.appendChild(legend);
    return wrap;
  }

  /* ---- composer: the build editor ---- */

  let buildOn = false;
  let buildWeapon = WEAPONS[0].name;
  let buildSlots = {};

  function buildWeaponPicker() {
    const sel = $('#c-weapon');
    if (sel.options.length) return;
    let family = null;
    let group = null;
    for (const w of WEAPONS) {
      if (w.family !== family) {
        family = w.family;
        group = document.createElement('optgroup');
        group.label = family;
        sel.appendChild(group);
      }
      const o = document.createElement('option');
      o.value = w.name;
      o.textContent = w.name;
      group.appendChild(o);
    }
    sel.value = buildWeapon;
  }

  function renderBuildSlots() {
    const arch = archetypeFor(buildWeapon);
    const wrap = $('#c-build-slots');
    wrap.innerHTML = '';
    for (const s of arch.slots) {
      const row = document.createElement('div');
      row.className = 'build-slot';
      row.append(span('build-slot-label', s.key));
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', s.key);
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '— EMPTY —';
      sel.appendChild(none);
      for (const opt of (ATTACHMENTS[s.key] || [])) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        sel.appendChild(o);
      }
      sel.value = buildSlots[s.key] || '';
      sel.addEventListener('change', () => {
        if (sel.value) buildSlots[s.key] = sel.value;
        else delete buildSlots[s.key];
        renderBuildPreview();
      });
      row.appendChild(sel);
      wrap.appendChild(row);
    }
  }

  function renderBuildPreview() {
    const host = $('#c-build-preview');
    host.innerHTML = '';
    host.appendChild(renderBlueprint({ weapon: buildWeapon, slots: buildSlots }));
  }

  function setBuildOn(on) {
    buildOn = on;
    const btn = $('#c-build-toggle');
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? '− REMOVE WEAPON BUILD' : '+ ATTACH WEAPON BUILD';
    $('#c-build').hidden = !on;
    if (on) {
      buildWeaponPicker();
      renderBuildSlots();
      renderBuildPreview();
    }
  }

  function currentBuild() {
    if (!buildOn) return null;
    return { weapon: buildWeapon, slots: { ...buildSlots } };
  }

  function resetBuild() {
    buildSlots = {};
    setBuildOn(false);
  }

  /* ---- the ARMORY channel ---- */

  function renderArmory() {
    const listEl = $('#armory-feed');
    const sel = $('#a-weapon');
    listEl.innerHTML = '';

    const all = (feedCache?.files || []).filter((f) => f.build || f.buildWeapon);
    const names = [...new Set(all.map((f) => f.build ? f.build.weapon : f.buildWeapon))].sort();

    const keep = sel.value;
    sel.innerHTML = '<option value="">ALL WEAPONS ON FILE</option>';
    for (const nm of names) {
      const o = document.createElement('option');
      o.value = nm;
      o.textContent = nm;
      sel.appendChild(o);
    }
    sel.value = names.includes(keep) ? keep : '';

    const files = sel.value
      ? all.filter((f) => (f.build ? f.build.weapon : f.buildWeapon) === sel.value)
      : all;
    const sealed = files.filter((f) => f.locked).length;
    $('#armory-count').textContent = all.length
      ? `${files.length} BUILD${files.length === 1 ? '' : 'S'}${sealed ? ` // ${sealed} SEALED` : ''}`
      : '';

    if (files.length === 0) {
      const li = document.createElement('li');
      li.className = 'feed-empty';
      li.textContent = all.length
        ? 'NO BUILDS ON FILE FOR THAT WEAPON.'
        : 'NO BUILDS ON FILE. ATTACH ONE TO A DROP AND IT RACKS HERE.';
      listEl.appendChild(li);
      return;
    }
    const rerender = async () => { await refreshFeed(); renderArmory(); };
    for (const f of files) {
      listEl.appendChild(f.locked ? lockedDropRow(f) : dropRow(f, rerender));
    }
  }

  /* ============================================================
     THEATER MAP — clickable schematic wired to the archive
     ============================================================ */

  let mapName = Object.keys(MAP_SCHEMATICS)[0];
  let selectedZone = null;

  function buildMapPicker() {
    const sel = $('#map-pick');
    if (sel.options.length) return;
    for (const name of Object.keys(MAP_SCHEMATICS)) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
    }
    // theaters with no schematic drawn yet — visible, not selectable
    for (const m of intelDB.MAPS) {
      if (MAP_SCHEMATICS[m]) continue;
      const o = document.createElement('option');
      o.value = m;
      o.textContent = `${m} — NO SCHEMATIC ON FILE`;
      o.disabled = true;
      sel.appendChild(o);
    }
    sel.value = mapName;
  }

  /* Schematic content comes from maps.js (ours), so template
     assembly here is safe; operator text never enters the SVG. */
  function renderMapStage() {
    const schematic = MAP_SCHEMATICS[mapName];
    const stage = $('#map-stage');
    $('#map-title').textContent = mapName;
    if (!schematic) {
      stage.innerHTML = '<div class="feed-empty">NO SCHEMATIC ON FILE FOR THIS THEATER.</div>';
      return;
    }
    $('#map-scale').textContent = schematic.scale || '';
    $('#map-caption').textContent = schematic.caption || '';

    const files = (feedCache?.files || []).filter((f) => f.map === mapName);
    const parts = [`<svg viewBox="${schematic.viewBox}" role="img" aria-label="${mapName} tactical schematic">`,
                   schematic.decor];

    for (const z of schematic.zones) {
      const zoneFiles = files.filter((f) => f.zone === z.name);
      const withheld = zoneFiles.filter((f) => f.locked).length;
      const cls = ['map-zone'];
      if (zoneFiles.length) cls.push('has-intel');
      if (zoneFiles.length && withheld === zoneFiles.length) cls.push('locked-only');
      if (selectedZone === z.name) cls.push('selected');
      const count = zoneFiles.length === 0
        ? 'NO INTEL'
        : `${zoneFiles.length} FILE${zoneFiles.length === 1 ? '' : 'S'}` +
          (withheld ? ` // ${withheld} WITHHELD` : '');
      parts.push(
        `<polygon class="${cls.join(' ')}" data-zone="${z.name}" points="${z.points}">`,
        `<title>${z.name}</title></polygon>`,
        `<text class="map-zone-label" x="${z.label[0]}" y="${z.label[1]}">${z.name}</text>`,
        `<text class="map-zone-count${zoneFiles.length ? '' : ' none'}" x="${z.label[0]}" y="${z.label[1] + 19}">${count}</text>`
      );
    }

    for (const ex of schematic.extracts || []) {
      const [x, y] = ex.at;
      const rightSide = x > Number(schematic.viewBox.split(' ')[2]) / 2;
      parts.push(
        `<path class="map-extract" d="M${x - 9},${y} L${x},${y - 9} L${x + 9},${y} L${x},${y + 9} Z"/>`,
        `<text class="map-extract-label" x="${rightSide ? x - 14 : x + 14}" y="${y + 4}"` +
        `${rightSide ? ' text-anchor="end"' : ''}>${ex.name}</text>`
      );
    }

    parts.push('</svg>');
    stage.innerHTML = parts.join('');
    stage.querySelectorAll('.map-zone').forEach((node) =>
      node.addEventListener('click', () => selectZone(node.dataset.zone))
    );
  }

  function selectZone(name) {
    selectedZone = selectedZone === name ? null : name;
    renderMapStage();
    renderZoneFeed();
  }

  function renderZoneFeed() {
    const list = $('#zone-feed');
    list.innerHTML = '';
    const files = (feedCache?.files || []).filter((f) => f.map === mapName);

    if (!selectedZone) {
      $('#zone-title').textContent = 'ZONE INTEL';
      $('#zone-count').textContent = `${files.length} FILE${files.length === 1 ? '' : 'S'} ACROSS THIS THEATER`;
      const li = document.createElement('li');
      li.className = 'feed-empty';
      li.textContent = files.length
        ? 'SELECT A ZONE ON THE SCHEMATIC TO PULL ITS INTEL.'
        : 'NO INTEL FILED IN THIS THEATER YET. TAG A DROP WITH IT AND IT LANDS ON THE MAP.';
      list.appendChild(li);
      return;
    }

    const zoneFiles = files.filter((f) => f.zone === selectedZone);
    const withheld = zoneFiles.filter((f) => f.locked).length;
    $('#zone-title').textContent = selectedZone;
    $('#zone-count').textContent = zoneFiles.length
      ? `${zoneFiles.length} FILE${zoneFiles.length === 1 ? '' : 'S'}${withheld ? ` // ${withheld} WITHHELD` : ''}`
      : 'NOTHING ON FILE';

    const brief = document.createElement('li');
    brief.className = 'zone-brief';
    brief.textContent = `${mapName} // ${selectedZone} — TAP THE ZONE AGAIN TO CLEAR.`;
    list.appendChild(brief);

    if (zoneFiles.length === 0) {
      const li = document.createElement('li');
      li.className = 'feed-empty';
      li.textContent = 'NO INTEL PINNED TO THIS ZONE. BE THE FIRST TO WALK IT.';
      list.appendChild(li);
      return;
    }
    const rerender = async () => { await refreshFeed(); renderMapStage(); renderZoneFeed(); };
    for (const f of zoneFiles) {
      list.appendChild(f.locked ? lockedDropRow(f) : dropRow(f, rerender));
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
    if (f.map) head.append(span('drop-tag', f.zone ? `${f.map} // ${f.zone}` : f.map));
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
    if (f.build) body.appendChild(renderBlueprint(f.build));
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

    /* a burned drop can be disputed — by its author, then by the network */
    let appealBox = null;
    if (f.isBurned) {
      appealBox = document.createElement('div');
      appealBox.className = 'appeal-box';

      if (f.appeal) {
        appealBox.append(span('appeal-label', 'APPEAL ON FILE'), document.createTextNode(f.appeal));
        if (f.appealAt) {
          const backing = span('appeal-count',
            `REINSTATEMENT ${f.reinstates} / ${intelDB.VERIFY_THRESHOLD}` +
            (f.mine ? ' — THE NETWORK DECIDES' : ''));
          appealBox.appendChild(backing);
          if (!f.mine && !f.reinstatedByMe) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'reinstate-btn';
            btn.textContent = 'BACK THE APPEAL';
            btn.style.marginTop = '7px';
            btn.addEventListener('click', async () => {
              btn.disabled = true;
              const r = await intelDB.reinstateIntel(f.id);
              if (!r.ok && r.code !== 'ALREADY_REINSTATED') {
                btn.disabled = false;
                btn.textContent = MESSAGES[r.code] || 'RELAY ERROR';
                return;
              }
              await rerender();
            });
            appealBox.appendChild(btn);
          } else if (f.reinstatedByMe) {
            appealBox.appendChild(span('appeal-count', 'YOU BACKED THIS APPEAL'));
          }
        }
      } else if (f.mine) {
        appealBox.append(span('appeal-label', 'APPEAL THIS BURN'));
        const compose = document.createElement('div');
        compose.className = 'appeal-compose';
        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 500;
        input.placeholder = 'STATE YOUR CASE — WHY THIS INTEL STANDS';
        input.setAttribute('aria-label', 'appeal statement');
        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'reinstate-btn';
        send.textContent = 'FILE APPEAL';
        const submit = async () => {
          const text = input.value.trim();
          if (text.length < 10) {
            input.placeholder = MESSAGES.BAD_APPEAL;
            return;
          }
          send.disabled = true;
          const r = await intelDB.appealBurn(f.id, text);
          if (!r.ok) {
            send.disabled = false;
            input.value = '';
            input.placeholder = MESSAGES[r.code] || 'RELAY ERROR — TRY AGAIN';
            return;
          }
          await rerender();
        };
        send.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        compose.append(input, send);
        appealBox.appendChild(compose);
      } else {
        appealBox.append(span('appeal-label', 'STRUCK'),
          document.createTextNode('THE AUTHOR HAS NOT APPEALED THIS BURN.'));
      }
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

    li.append(head, title, body, foot);
    if (appealBox) li.appendChild(appealBox);
    li.appendChild(thread);
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
    if (f.map) head.append(span('drop-tag', f.zone ? `${f.map} // ${f.zone}` : f.map));
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

    // the weapon is a tease; the attachments stay sealed
    if (f.buildWeapon) {
      const sealed = document.createElement('div');
      sealed.className = 'bp-sealed';
      sealed.append(document.createTextNode('WEAPON BUILD ON FILE — '));
      const b = document.createElement('b');
      b.textContent = f.buildWeapon;
      sealed.append(b, document.createTextNode(' // ATTACHMENTS SEALED AT THIS CLEARANCE'));
      li.appendChild(sealed);
    }
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
  $('#ch-network').addEventListener('click', () => {
    setChannel('network'); buildTierPicker(); syncZonePicker(); renderFeed();
  });
  $('#ch-compartment').addEventListener('click', () => {
    setChannel('compartment'); buildTierPicker(); syncZonePicker(); renderFeed();
  });
  $('#ch-map').addEventListener('click', () => {
    setChannel('map'); renderMapStage(); renderZoneFeed();
  });
  $('#ch-armory').addEventListener('click', () => { setChannel('armory'); renderArmory(); });
  $('#a-weapon').addEventListener('change', renderArmory);
  $('#c-build-toggle').addEventListener('click', () => setBuildOn(!buildOn));
  $('#c-weapon').addEventListener('change', (e) => {
    buildWeapon = e.target.value;
    // keep only the attachments this weapon actually has slots for
    const keys = archetypeFor(buildWeapon).slots.map((s) => s.key);
    buildSlots = Object.fromEntries(
      Object.entries(buildSlots).filter(([k]) => keys.includes(k))
    );
    renderBuildSlots();
    renderBuildPreview();
  });
  $('#map-pick').addEventListener('change', (e) => {
    mapName = e.target.value;
    selectedZone = null;
    renderMapStage();
    renderZoneFeed();
  });
  $('#c-map').addEventListener('change', syncZonePicker);
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
        await enterDossier(
          res.dossier,
          `WELCOME BACK, ${res.dossier.callsign.toUpperCase()}`,
          ['> SESSION TOKEN ACCEPTED',
           `> STANDING: ${res.dossier.clearance}`,
           '> DECRYPTING DOSSIER…']
        );
        return;
      }
      intelDB.clearSession();
    }
    el.gate.classList.remove('hidden');
    el.inCallsign.focus();
  }

  init();
})();
