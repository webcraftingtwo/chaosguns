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
| `js/config.js` | Relay coordinates: Supabase project URL + publishable key (safe to ship — it only opens the RPC surface). Blank them to run fully offline on the mock. |
| `js/inteldb.js` | **The data layer.** All persistence behind async `intelDB` methods (`enlistOperator`, `authenticate`, `recoverWithCipher`, `getDossier`, `getClearanceLadder`, session). One facade, two backends: live Supabase RPC when `config.js` has coordinates, localStorage mock otherwise. The UI never touches storage or the network directly and cannot tell the backends apart. |
| `js/fx.js` | Motion utilities: terminal typing, decrypt scramble, staggered materialize. Honors `prefers-reduced-motion`. |
| `js/app.js` | Orchestration: boot → gate → ACCESS GRANTED → dossier reveal. UI only. |
| `css/style.css` | Art direction. One seeded accent (`--accent-h`) themes the entire dossier. |

## Backend (Supabase project `deaddrop-intel-network`)

Auth is **callsign + passphrase in Postgres itself** — not Supabase email
auth, which would break the no-email rule. The `deaddrop_core` migration
defines:

- `operators`, `sessions`, and an `intel_files` stub — all with **RLS enabled
  and zero policies**, so the Data API cannot read or write them directly.
- `SECURITY DEFINER` RPCs as the only door: `enlist_operator`,
  `authenticate_operator`, `recover_operator`, `get_dossier`,
  `terminate_session`, plus the intel surface `file_intel`,
  `get_intel_feed`, `verify_intel`. Passphrases and extraction ciphers are
  stored as bcrypt hashes (pgcrypto); sessions are server-issued 48-hex
  tokens with a 30-day expiry. Burning a cipher (recovery) revokes all
  outstanding sessions.

**Supabase linter note:** the security advisor flags "RLS enabled no policy"
on the three tables and "anon can execute SECURITY DEFINER" on the five RPCs.
Both are this design working as intended — the tables are meant to be
unreachable and the RPCs are the deliberate public surface (enlist and
authenticate must run before any sign-in exists). Helper functions
(`_dossier`, `_new_cipher`, `_issue_session`) have EXECUTE revoked from
`anon`/`authenticated`/`public`.

Known gap, acceptable for this build: no rate limiting on the auth RPCs yet
(bcrypt keeps brute force slow; an edge-function shim or captcha can wrap the
RPCs later without touching the UI).

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
from contribution mix — `PENDING` until earned.

## Intel filing & verification (the clearance economy)

The INTEL ARCHIVE view (reachable from the dossier topbar) is where the
economy runs:

- **Filing.** An operator picks a class, writes a subject + field report, and
  transmits. Drops are classified at the author's clearance at filing time
  and immediately count toward specialization.
- **Feed.** Newest first. Drops above your clearance appear as locked stubs —
  class, tier, and date only; the title and payload never leave the database
  (`get_intel_feed` builds redacted rows server-side).
- **Verification.** Any operator with sufficient clearance can confirm
  someone else's drop (never their own, once each). At **2 confirmations**
  the drop flips to VERIFIED, credits the author's verified-file count, and
  auto-promotes clearance when a tier requirement (3 / 8 / 20 / 50) is met —
  all inside the `verify_intel` RPC, so the client can't forge progression.

The archive ships with starter drops from the `HANDLER` account (SECRET
clearance) — two readable at RESTRICTED, one CONFIDENTIAL and one SECRET, so
new operators see real withheld intel on day one.
