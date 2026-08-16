-- ============================================================
-- DISPATCHES + COMPARTMENT KEYS
--
-- Dispatches: events queued for an operator while they were away
-- (drop verified, clearance granted), delivered once on next
-- contact via get_dispatches.
--
-- Compartment keys: COMPARTMENTED (tier 4) is no longer earned by
-- verified-file count — auto-promotion now caps at TOP SECRET.
-- Tier 4 is granted only by redeeming a single-use key issued by
-- an operator who is already COMPARTMENTED. HANDLER is the origin
-- node of the compartment.
--
-- Same posture as before: RLS, no policies, RPCs are the door.
-- Applied to project deaddrop-intel-network (tmykcaqtnugscxdpsadq)
-- as migration `dispatches_and_compartment` (plus a follow-up fix:
-- redeemed_at is the burn marker, redeemed_by is set-null on
-- redeemer deletion).
-- ============================================================

create table public.dispatches (
  id          uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators(id) on delete cascade,
  kind        text not null check (kind in ('INTEL_VERIFIED','CLEARANCE_GRANTED')),
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  seen_at     timestamptz
);
create index dispatches_unseen_idx on public.dispatches (operator_id) where seen_at is null;

create table public.compartment_keys (
  code        text primary key,
  issued_by   uuid not null references public.operators(id) on delete cascade,
  issued_at   timestamptz not null default now(),
  redeemed_by uuid references public.operators(id) on delete set null,
  redeemed_at timestamptz
);

alter table public.dispatches enable row level security;
alter table public.compartment_keys enable row level security;
revoke all on public.dispatches, public.compartment_keys from anon, authenticated;

-- ---------- verify_intel: dispatch on flip, promotion capped at TOP SECRET ----------

create or replace function public.verify_intel(p_token text, p_file_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  c_threshold constant int := 2;
  c_requirements constant int[] := array[0, 3, 8, 20, 50];
  v_op public.operators;
  v_file public.intel_files;
  v_author public.operators;
begin
  v_op := public._operator_from_token(p_token);
  if v_op.id is null then
    return jsonb_build_object('ok', false, 'code', 'SESSION_INVALID');
  end if;

  select * into v_file from public.intel_files where id = p_file_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_ON_FILE');
  end if;
  if v_file.clearance_index > v_op.clearance_index then
    return jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_CLEARANCE');
  end if;
  if v_file.operator_id = v_op.id then
    return jsonb_build_object('ok', false, 'code', 'OWN_FILE');
  end if;

  begin
    insert into public.intel_verifications (file_id, operator_id)
    values (v_file.id, v_op.id);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_VERIFIED');
  end;

  update public.intel_files
     set verified_count = verified_count + 1
   where id = v_file.id
  returning * into v_file;

  if v_file.verified_count >= c_threshold and not v_file.is_verified then
    update public.intel_files set is_verified = true where id = v_file.id;
    v_file.is_verified := true;

    update public.operators
       set verified_count = verified_count + 1
     where id = v_file.operator_id
    returning * into v_author;

    insert into public.dispatches (operator_id, kind, payload)
    values (v_author.id, 'INTEL_VERIFIED',
            jsonb_build_object('title', v_file.title, 'class', v_file.class));

    -- auto-promote, but never into COMPARTMENTED — tier 4 is
    -- invitation-only via compartment keys
    while v_author.clearance_index < 3
      and v_author.verified_count >= c_requirements[v_author.clearance_index + 2] loop
      update public.operators
         set clearance_index = clearance_index + 1
       where id = v_author.id
      returning * into v_author;

      insert into public.dispatches (operator_id, kind, payload)
      values (v_author.id, 'CLEARANCE_GRANTED',
              jsonb_build_object('clearanceIndex', v_author.clearance_index));
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'verifications', v_file.verified_count,
    'isVerified', v_file.is_verified
  );
end $$;

-- ---------- dispatches ----------

create or replace function public.get_dispatches(p_token text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_op public.operators;
  v_out jsonb;
begin
  v_op := public._operator_from_token(p_token);
  if v_op.id is null then
    return jsonb_build_object('ok', false, 'code', 'SESSION_INVALID');
  end if;

  with delivered as (
    update public.dispatches
       set seen_at = now()
     where operator_id = v_op.id and seen_at is null
    returning kind, payload, created_at
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'kind', kind,
      'payload', payload,
      'createdAt', (extract(epoch from created_at) * 1000)::bigint
    ) order by created_at asc), '[]'::jsonb)
  into v_out
  from delivered;

  return jsonb_build_object('ok', true, 'dispatches', v_out);
end $$;

-- ---------- compartment keys ----------

create or replace function public.issue_compartment_key(p_token text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  c_max_active constant int := 3;
  v_op public.operators;
  v_code text;
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  raw bytea := extensions.gen_random_bytes(8);
  chars text := '';
  i int;
begin
  v_op := public._operator_from_token(p_token);
  if v_op.id is null then
    return jsonb_build_object('ok', false, 'code', 'SESSION_INVALID');
  end if;
  if v_op.clearance_index < 4 then
    return jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_CLEARANCE');
  end if;
  -- redeemed_at, not redeemed_by: a deleted redeemer nulls redeemed_by
  -- but the key stays burned
  if (select count(*) from public.compartment_keys
       where issued_by = v_op.id and redeemed_at is null) >= c_max_active then
    return jsonb_build_object('ok', false, 'code', 'KEY_LIMIT');
  end if;

  for i in 0..7 loop
    chars := chars || substr(alphabet, (get_byte(raw, i) % 31) + 1, 1);
  end loop;
  v_code := 'CK-' || substr(chars, 1, 4) || '-' || substr(chars, 5, 4);

  insert into public.compartment_keys (code, issued_by) values (v_code, v_op.id);
  return jsonb_build_object('ok', true, 'key', v_code);
end $$;

create or replace function public.redeem_compartment_key(p_token text, p_code text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_op public.operators;
  v_code text := upper(regexp_replace(p_code, '\s', '', 'g'));
  v_key public.compartment_keys;
begin
  v_op := public._operator_from_token(p_token);
  if v_op.id is null then
    return jsonb_build_object('ok', false, 'code', 'SESSION_INVALID');
  end if;
  if v_op.clearance_index >= 4 then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_COMPARTMENTED');
  end if;
  if v_op.clearance_index < 3 then
    return jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_STANDING');
  end if;

  select * into v_key from public.compartment_keys
   where code = v_code and redeemed_at is null
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'KEY_REJECTED');
  end if;

  update public.compartment_keys
     set redeemed_by = v_op.id, redeemed_at = now()
   where code = v_key.code;

  update public.operators
     set clearance_index = 4
   where id = v_op.id
  returning * into v_op;

  insert into public.dispatches (operator_id, kind, payload)
  values (v_op.id, 'CLEARANCE_GRANTED', jsonb_build_object('clearanceIndex', 4));

  return jsonb_build_object('ok', true, 'dossier', public._dossier(v_op));
end $$;
