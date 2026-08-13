# DEAD DROP — Operator Intel Network: Access Terminal

Community intel site for **Delta Force**, skinned as a classified military
intelligence terminal. This build is the front door and the identity: the
boot sequence, the callsign-gated access terminal, and the personal operator
dossier. The community intel database itself is stubbed behind the data layer.

## Run it

No build step. Serve the folder with any static server:

```
python3 -m http.server 8080
```

then open `http://localhost:8080`. (Opening `index.html` directly also works;
seed hashing falls back to a documented deterministic hash if `crypto.subtle`
is unavailable outside a secure context.)

## How it fits together

| File | Role |
| --- | --- |
| `js/seed.js` | Pure functions. SHA-256 of the lowercased callsign → accent hue, operator ID (`OP-XXXX-NN`), insignia, and stable teaser numbers. Same callsign → identical dossier, nothing stored. |
| `js/inteldb.js` | **The data layer.** All persistence behind async `intelDB` methods (`enlistOperator`, `authenticate`, `recoverWithCipher`, `getDossier`, `getClearanceLadder`, session). Currently a localStorage mock; every method carries a `SUPABASE SEAM` comment marking where real Supabase auth + Postgres (with clearance-enforcing RLS) drop in. The UI never touches storage directly. |
| `js/fx.js` | Motion utilities: terminal typing, decrypt scramble, staggered materialize. Honors `prefers-reduced-motion`. |
| `js/app.js` | Orchestration: boot → gate → ACCESS GRANTED → dossier reveal. UI only. |
| `css/style.css` | Art direction. One seeded accent (`--accent-h`) themes the entire dossier. |

## Identity model

Callsign + passphrase only — no email. Enlisting issues a one-time
**extraction cipher** (`DD-XXXX-XXXX-XXXX`), the only recovery path; the mock
stores only digests of the passphrase and cipher. Using the cipher to reset a
passphrase burns it and issues a fresh one.

## Clearance & specialization

Five tiers (`RESTRICTED → CONFIDENTIAL → SECRET → TOP SECRET → COMPARTMENTED`).
Everyone starts RESTRICTED; tiers above the operator render as redacted
teasers — real numbers visible, payload under physical black bars (block
characters only in the DOM, nothing to reveal). Specialization uses the real
Delta Force classes (RECON / ENGINEER / ASSAULT / MEDIC), assigned emergently
from contribution mix — `PENDING` until earned. Verification logic is stubbed;
the dossier already displays progress toward the next tier.
