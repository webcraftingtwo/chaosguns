/* ============================================================
   fx.js — motion utilities: terminal typing, decrypt scramble.
   Every effect here is used deliberately (boot, reveal, flicker);
   nothing decorative-everywhere. Honors prefers-reduced-motion.
   ============================================================ */

'use strict';

const FX = (() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const SCRAMBLE_CHARS = '█▓▒░<>/\\|#$%&@=+*ABCDEF0123456789';

  /**
   * Types `lines` into `container` one character at a time.
   * `skip` is a shared flag object — set skip.now = true to finish
   * the whole sequence instantly.
   */
  async function typeSequence(container, lines, skip, opts = {}) {
    const charDelay = opts.charDelay ?? 11;
    const lineDelay = opts.lineDelay ?? 170;
    for (const line of lines) {
      const el = document.createElement('div');
      el.className = 'boot-line';
      container.appendChild(el);
      if (reducedMotion || skip.now) {
        el.textContent = line;
        continue;
      }
      for (let i = 0; i < line.length; i++) {
        if (skip.now) {
          el.textContent = line;
          break;
        }
        el.textContent = line.slice(0, i + 1);
        await wait(charDelay);
      }
      if (!skip.now) await wait(lineDelay);
    }
  }

  /**
   * Decrypt effect: element resolves from noise into `finalText`,
   * settling left → right. The centerpiece of the dossier reveal.
   */
  function scramble(el, finalText, duration = 600) {
    if (reducedMotion) {
      el.textContent = finalText;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const start = performance.now();
      function frame(now) {
        const t = Math.min(1, (now - start) / duration);
        const settled = Math.floor(t * finalText.length);
        let out = finalText.slice(0, settled);
        for (let i = settled; i < finalText.length; i++) {
          out += finalText[i] === ' '
            ? ' '
            : SCRAMBLE_CHARS[(Math.random() * SCRAMBLE_CHARS.length) | 0];
        }
        el.textContent = out;
        if (t < 1) requestAnimationFrame(frame);
        else {
          el.textContent = finalText;
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  /**
   * Staggered materialize: adds .decrypted to each node in order.
   * CSS owns the actual clip/glow transition.
   */
  async function staggerIn(nodes, step = 90) {
    for (const node of nodes) {
      node.classList.add('decrypted');
      if (!reducedMotion) await wait(step);
    }
  }

  return { wait, typeSequence, scramble, staggerIn, reducedMotion };
})();
