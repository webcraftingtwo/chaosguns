-- ============================================================
-- DEAD DROP core schema: operators, sessions, intel stub, and
-- the RPC surface. Identity is callsign + passphrase (no email);
-- recovery is the one-time extraction cipher. Tables carry RLS
-- with NO policies — the Data API cannot touch them directly.
-- Every access path is a SECURITY DEFINER function below.
--
-- Applied to project deaddrop-intel-network (tmykcaqtnugscxdpsadq)
-- as migration `deaddrop_core`. Kept here so the schema is
-- versioned with the site.
--
-- Linter note: the Supabase security advisor flags "RLS enabled
-- no policy" on these tables and "anon can execute SECURITY
-- DEFINER" on the five RPCs. Both are intended: the tables are
-- meant to be unreachable and the RPCs are the public surface
-- (enlist/authenticate must run before any sign-in exists).
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

create table public.operators (
  id             uuid primary key default gen_random_uuid(),
  callsign       text not null,
  callsign_norm  text not null unique,
  pass_hash      text not null,          -- bcrypt
  cipher_hash    text not null,          -- bcrypt of the one-time extraction cipher
  enlisted_at    timestamptz not null default now(),
  clearance_index int not null default 0 check (clearance_index between 0 and 4),
  verified_count int not null default 0,
  contributions  jsonb not null default '{"RECON":0,"ENGINEER":0,"ASSAULT":0,"MEDIC":0}'::jsonb
);

create table public.sessions (
  token       text primary key,
  operator_id uuid not null references public.operators(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days'
);

-- Stub for the future community intel database. Row-level security
-- will gate reads by clearance_index when the content site lands.
create table public.intel_files (
  id             uuid primary key default gen_random_uuid(),
  operator_id    uuid not null references public.operators(id) on delete cascade,
  class          text not null check (class in ('RECON','ENGINEER','ASSAULT','MEDIC')),
  clearance_index int not null default 0 check (clearance_index between 0 and 4),
  title          text not null,
  body           text not null,
  verified_count int not null default 0,
  created_at     timestamptz not null default now()
);

alter table public.operators  enable row level security;
alter table public.sessions   enable row level security;
alter table public.intel_files enable row level security;
revoke all on public.operators, public.sessions, public.intel_files from anon, authenticated;

-- ---------- helpers (not callable from the API) ----------

create or replace function public._dossier(op public.operators)
returns jsonb
language sql stable
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'id', op.id,
    'callsign', op.callsign,
    'enlistedAt', (extract(epoch from op.enlisted_at) * 1000)::bigint,
    'clearanceIndex', op.clearance_index,
    'verifiedCount', op.verified_count,
    'contributions', op.contributions
  );
$$;

create or replace function public._new_cipher()
returns text
language plpgsql volatile
set search_path = public, extensions
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- no ambiguous chars
  raw bytea := extensions.gen_random_bytes(12);
  chars text := '';
  i int;
begin
  for i in 0..11 loop
    chars := chars || substr(alphabet, (get_byte(raw, i) % 31) + 1, 1);
  end loop;
  return 'DD-' || substr(chars, 1, 4) || '-' || substr(chars, 5, 4) || '-' || substr(chars, 9, 4);
end $$;

create or replace function public._issue_session(p_operator uuid)
returns text
language plpgsql volatile
set search_path = public, extensions
as $$
declare
  t text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  delete from public.sessions where expires_at < now(); -- opportunistic sweep
  insert into public.sessions (token, operator_id) values (t, p_operator);
  return t;
end $$;

revoke execute on function public._dossier(public.operators) from public, anon, authenticated;
revoke execute on function public._new_cipher() from public, anon, authenticated;
revoke execute on function public._issue_session(uuid) from public, anon, authenticated;

-- ---------- RPC surface (the only door) ----------

create or replace function public.enlist_operator(p_callsign text, p_passphrase text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_cs text := trim(p_callsign);
  v_norm text := lower(v_cs);
  v_cipher text;
  v_op public.operators;
begin
  if v_cs !~ '^[A-Za-z0-9_-]{3,16}$' then
    return jsonb_build_object('ok', false, 'code', 'BAD_CALLSIGN');
  end if;
  if length(p_passphrase) < 6 then
    return jsonb_build_object('ok', false, 'code', 'BAD_PASS');
  end if;
  if exists (select 1 from public.operators where callsign_norm = v_norm) then
    return jsonb_build_object('ok', false, 'code', 'CALLSIGN_IN_SERVICE');
  end if;

  v_cipher := public._new_cipher();
  insert into public.operators (callsign, callsign_norm, pass_hash, cipher_hash)
  values (
    v_cs,
    v_norm,
    extensions.crypt(p_passphrase, extensions.gen_salt('bf')),
    extensions.crypt(v_cipher, extensions.gen_salt('bf'))
  )
  returning * into v_op;

  return jsonb_build_object(
    'ok', true,
    'dossier', public._dossier(v_op),
    'cipher', v_cipher,                      -- returned exactly once, never readable again
    'token', public._issue_session(v_op.id)
  );
exception when unique_violation then
  return jsonb_build_object('ok', false, 'code', 'CALLSIGN_IN_SERVICE');
end $$;

create or replace function public.authenticate_operator(p_callsign text, p_passphrase text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_op public.operators;
begin
  select * into v_op from public.operators where callsign_norm = lower(trim(p_callsign));
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CALLSIGN_NOT_ON_FILE');
  end if;
  if v_op.pass_hash <> extensions.crypt(p_passphrase, v_op.pass_hash) then
    return jsonb_build_object('ok', false, 'code', 'CREDENTIALS_REJECTED');
  end if;
  return jsonb_build_object(
    'ok', true,
    'dossier', public._dossier(v_op),
    'token', public._issue_session(v_op.id)
  );
end $$;

create or replace function public.recover_operator(p_callsign text, p_cipher text, p_new_passphrase text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_op public.operators;
  v_cipher_in text := upper(regexp_replace(p_cipher, '\s', '', 'g'));
  v_fresh text;
begin
  if length(p_new_passphrase) < 6 then
    return jsonb_build_object('ok', false, 'code', 'BAD_PASS');
  end if;
  select * into v_op from public.operators where callsign_norm = lower(trim(p_callsign));
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CALLSIGN_NOT_ON_FILE');
  end if;
  if v_op.cipher_hash <> extensions.crypt(v_cipher_in, v_op.cipher_hash) then
    return jsonb_build_object('ok', false, 'code', 'CIPHER_REJECTED');
  end if;

  v_fresh := public._new_cipher();
  update public.operators
     set pass_hash   = extensions.crypt(p_new_passphrase, extensions.gen_salt('bf')),
         cipher_hash = extensions.crypt(v_fresh, extensions.gen_salt('bf'))
   where id = v_op.id
  returning * into v_op;

  -- burning the cipher revokes every outstanding session
  delete from public.sessions where operator_id = v_op.id;

  return jsonb_build_object(
    'ok', true,
    'dossier', public._dossier(v_op),
    'cipher', v_fresh,
    'token', public._issue_session(v_op.id)
  );
end $$;

create or replace function public.get_dossier(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_op public.operators;
begin
  select o.* into v_op
    from public.sessions s
    join public.operators o on o.id = s.operator_id
   where s.token = p_token and s.expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'code', 'SESSION_INVALID');
  end if;
  return jsonb_build_object('ok', true, 'dossier', public._dossier(v_op));
end $$;

create or replace function public.terminate_session(p_token text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
begin
  delete from public.sessions where token = p_token;
  return jsonb_build_object('ok', true);
end $$;
