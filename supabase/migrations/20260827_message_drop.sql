-- ============================================================
-- OPERATOR MESSAGE DROP — end-to-end encrypted.
--
-- The server stores ciphertext and nothing else. Each operator
-- holds an ECDH P-256 identity keypair:
--   • public_key  — public, handed out so others can address them
--   • vault_blob  — their PRIVATE key, encrypted in the browser
--                   with a key derived from their passphrase
--                   (PBKDF2). The server never sees the passphrase
--                   that unlocks it and cannot unwrap this.
--
-- Message bodies are AES-GCM ciphertext under a key both parties
-- derive by ECDH. This database can be dumped in full and the
-- message contents stay unreadable.
--
-- What IS visible here: who messaged whom, when, and roughly how
-- long each message was. Metadata is not protected. See the
-- threat model at the top of js/crypto.js.
--
-- Applied to project deaddrop-intel-network (tmykcaqtnugscxdpsadq)
-- as migrations `message_drop` + `rekey_passphrase`.
-- ============================================================

alter table public.operators
  add column public_key  text,
  add column vault_blob  text,
  add column vault_iv    text,
  add column vault_salt  text,
  add column key_set_at  timestamptz;

create table public.messages (
  id           uuid primary key default gen_random_uuid(),
  sender_id    uuid not null references public.operators(id) on delete cascade,
  recipient_id uuid not null references public.operators(id) on delete cascade,
  ciphertext   text not null check (length(ciphertext) between 1 and 8000),
  iv           text not null check (length(iv) between 1 and 64),
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  hidden_by_sender    boolean not null default false,
  hidden_by_recipient boolean not null default false
);
create index messages_recipient_idx on public.messages (recipient_id, created_at desc);
create index messages_sender_idx on public.messages (sender_id, created_at desc);

alter table public.messages enable row level security;
revoke all on public.messages from anon, authenticated;

-- RPCs added by these migrations (bodies as applied to the project):
--   register_keys(token, public_key, vault_blob, vault_iv, vault_salt)
--   get_vault(token)                  -- own wrapped key material
--   get_public_key(token, callsign)   -- someone else's public key
--   send_message(token, recipient, ciphertext, iv)   -- 20/hour cap
--   get_messages(token, limit)        -- ciphertext + counterpart key
--   mark_message_read(token, id)
--   hide_message(token, id)           -- burned by both sides = deleted
--   rekey_passphrase(token, new_secret)
--     Clients now authenticate with an auth secret (PBKDF2 of the
--     passphrase under an auth-only salt) rather than the passphrase
--     itself, so the value the server bcrypts cannot unwrap a vault.
--     Accounts predating this migrate in place on next login.
