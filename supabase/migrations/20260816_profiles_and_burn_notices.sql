-- ============================================================
-- OPERATOR FILES + BURN NOTICES
--
-- get_operator_file: another operator's personnel file — public
-- standing plus their drops, clearance-gated for the viewer by
-- the same rules as the feed (shared _file_row builder).
--
-- Burn notices: the inverse of verification. Two burns from
-- cleared operators strike a drop with a BURN NOTICE; if it was
-- verified, verification is revoked and the author loses that
-- credit (clearance already granted is not clawed back). An
-- operator cannot burn their own drop, cannot burn twice, and
-- cannot both confirm and burn the same drop. Burned drops can
-- no longer be confirmed; annexes stay open so operators can
-- explain the burn.
--
-- Applied to project deaddrop-intel-network (tmykcaqtnugscxdpsadq)
-- as migration `profiles_and_burn_notices`.
-- ============================================================

alter table public.intel_files
  add column is_burned boolean not null default false;

create table public.intel_burns (
  file_id     uuid not null references public.intel_files(id) on delete cascade,
  operator_id uuid not null references public.operators(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (file_id, operator_id)
);

alter table public.intel_burns enable row level security;
revoke all on public.intel_burns from anon, authenticated;

alter table public.dispatches drop constraint dispatches_kind_check;
alter table public.dispatches add constraint dispatches_kind_check
  check (kind in ('INTEL_VERIFIED','CLEARANCE_GRANTED','ANNEX_ADDED','BURN_NOTICE'));

-- ---------- shared row builder (not callable from the API) ----------

create or replace function public._file_row(f public.intel_files, v public.operators)
returns jsonb
language sql stable
set search_path = public, extensions
as $$
  select case
    when f.clearance_index <= v.clearance_index then
      jsonb_build_object(
        'id', f.id,
        'locked', false,
        'class', f.class,
        'clearanceIndex', f.clearance_index,
        'title', f.title,
        'body', f.body,
        'author', (select callsign from public.operators a where a.id = f.operator_id),
        'mine', f.operator_id = v.id,
        'createdAt', (extract(epoch from f.created_at) * 1000)::bigint,
        'verifications', f.verified_count,
        'isVerified', f.is_verified,
        'verifiedByMe', exists (
          select 1 from public.intel_verifications iv
           where iv.file_id = f.id and iv.operator_id = v.id),
        'map', f.map_tag,
        'mode', f.mode_tag,
        'annexes', (select count(*) from public.intel_annexes x where x.file_id = f.id),
        'isBurned', f.is_burned,
        'burns', (select count(*) from public.intel_burns b where b.file_id = f.id),
        'burnedByMe', exists (
          select 1 from public.intel_burns b
           where b.file_id = f.id and b.operator_id = v.id)
      )
    else
      jsonb_build_object(
        'id', f.id,
        'locked', true,
        'class', f.class,
        'clearanceIndex', f.clearance_index,
        'createdAt', (extract(epoch from f.created_at) * 1000)::bigint,
        'map', f.map_tag,
        'mode', f.mode_tag,
        'annexes', (select count(*) from public.intel_annexes x where x.file_id = f.id)
      )
  end;
$$;

revoke execute on function public._file_row(public.intel_files, public.operators)
  from public, anon, authenticated;

-- ---------- feed now built on the shared row builder ----------

create or replace function public.get_intel_feed(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_op public.operators;
  v_files jsonb;
begin
  v_op := public._operator_from_token(p_token);
  if v_op.id is null then
    return jsonb_build_object('ok', false, 'code', 'SESSION_INVALID');
  end if;

  select coalesce(jsonb_agg(public._file_row(f, v_op) order by f.created_at desc), '[]'::jsonb)
  into v_files
  from (select * from public.intel_files order by created_at desc limit 100) f;

  return jsonb_build_object('ok', true, 'clearanceIndex', v_op.clearance_index, 'files', v_files);
end $$;

-- ---------- operator file (personnel profile) ----------

create or replace function public.get_operator_file(p_token text, p_callsign text)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_op public.operators;
  v_subject public.operators;
  v_files jsonb;
begin
  v_op := public._operator_from_token(p_token);
  if v_op.id is null then
    return jsonb_build_object('ok', false, 'code', 'SESSION_INVALID');
  end if;
  select * into v_subject from public.operators
   where callsign_norm = lower(trim(p_callsign));
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_ON_FILE');
  end if;

  select coalesce(jsonb_agg(public._file_row(f, v_op) order by f.created_at desc), '[]'::jsonb)
  into v_files
  from (
    select * from public.intel_files
     where operator_id = v_subject.id
     order by created_at desc limit 50
  ) f;

  return jsonb_build_object(
    'ok', true,
    'profile', jsonb_build_object(
      'callsign', v_subject.callsign,
      'clearanceIndex', v_subject.clearance_index,
      'verifiedCount', v_subject.verified_count,
      'contributions', v_subject.contributions,
      'enlistedAt', (extract(epoch from v_subject.enlisted_at) * 1000)::bigint,
      'lastContact', (extract(epoch from coalesce(
        (select max(s.created_at) from public.sessions s where s.operator_id = v_subject.id),
        v_subject.enlisted_at)) * 1000)::bigint,
      'drops', (select count(*) from public.intel_files f2 where f2.operator_id = v_subject.id),
      'annexes', (select count(*) from public.intel_annexes x where x.operator_id = v_subject.id),
      'burnsReceived', (select count(*) from public.intel_files f3
                         where f3.operator_id = v_subject.id and f3.is_burned),
      'me', v_subject.id = v_op.id
    ),
    'files', v_files
  );
end $$;

-- ---------- burn notice ----------

create or replace function public.burn_intel(p_token text, p_file_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  c_threshold constant int := 2;
  v_op public.operators;
  v_file public.intel_files;
  v_burns int;
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
  if exists (select 1 from public.intel_verifications iv
              where iv.file_id = v_file.id and iv.operator_id = v_op.id) then
    return jsonb_build_object('ok', false, 'code', 'CONFLICTED');
  end if;

  begin
    insert into public.intel_burns (file_id, operator_id) values (v_file.id, v_op.id);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_BURNED');
  end;

  select count(*) into v_burns from public.intel_burns where file_id = v_file.id;

  if v_burns >= c_threshold and not v_file.is_burned then
    update public.intel_files set is_burned = true where id = v_file.id;
    v_file.is_burned := true;

    -- a verified drop that burns loses its verification, and the
    -- author loses that credit (clearance is not clawed back)
    if v_file.is_verified then
      update public.intel_files set is_verified = false where id = v_file.id;
      update public.operators
         set verified_count = greatest(0, verified_count - 1)
       where id = v_file.operator_id;
    end if;

    insert into public.dispatches (operator_id, kind, payload)
    values (v_file.operator_id, 'BURN_NOTICE',
            jsonb_build_object('title', v_file.title, 'class', v_file.class,
                               'wasVerified', v_file.is_verified));
  end if;

  return jsonb_build_object('ok', true, 'burns', v_burns, 'isBurned', v_file.is_burned);
end $$;

-- ---------- verify_intel: burned drops and conflicted votes ----------

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
  if v_file.is_burned then
    return jsonb_build_object('ok', false, 'code', 'BURNED');
  end if;
  if exists (select 1 from public.intel_burns b
              where b.file_id = v_file.id and b.operator_id = v_op.id) then
    return jsonb_build_object('ok', false, 'code', 'CONFLICTED');
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
