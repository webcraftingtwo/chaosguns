-- ============================================================
-- ANNEXES + ROSTER + THEATER TAGS
--
-- Annexes: field notes appended under a drop by any operator
-- cleared to read it — corroborations, corrections, updates.
-- Appending to someone's drop queues them a dispatch.
--
-- Theater/mode tags: optional map + mode metadata on drops.
-- Locked stubs expose the tags (you can know WHERE the withheld
-- intel applies, never WHAT it says).
--
-- Roster: the operator directory — standing, specialization
-- source data, drop counts, last contact.
--
-- Applied to project deaddrop-intel-network (tmykcaqtnugscxdpsadq)
-- as migration `annexes_roster_tags`.
-- ============================================================

alter table public.intel_files
  add column map_tag text check (map_tag is null or map_tag in
    ('ZERO DAM','LAYALI GROVE','SPACE CITY','BRAKKESH','TIDE PRISON',
     'ASCENSION','THRESHOLD','SHAFTED','CRACKED')),
  add column mode_tag text check (mode_tag is null or mode_tag in ('OPERATIONS','WARFARE'));

create table public.intel_annexes (
  id          uuid primary key default gen_random_uuid(),
  file_id     uuid not null references public.intel_files(id) on delete cascade,
  operator_id uuid not null references public.operators(id) on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index intel_annexes_file_idx on public.intel_annexes (file_id, created_at);

alter table public.intel_annexes enable row level security;
revoke all on public.intel_annexes from anon, authenticated;

alter table public.dispatches drop constraint dispatches_kind_check;
alter table public.dispatches add constraint dispatches_kind_check
  check (kind in ('INTEL_VERIFIED','CLEARANCE_GRANTED','ANNEX_ADDED'));

-- ---------- file_intel: gains optional theater/mode tags ----------

drop function public.file_intel(text, text, text, text, int);

create function public.file_intel(
  p_token text, p_class text, p_title text, p_body text,
  p_clearance int default null, p_map text default null, p_mode text default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_op public.operators;
  v_tier int;
  v_file public.intel_files;
begin
  v_op := public._operator_from_token(p_token);
  if v_op.id is null then
    return jsonb_build_object('ok', false, 'code', 'SESSION_INVALID');
  end if;
  if p_class not in ('RECON','ENGINEER','ASSAULT','MEDIC') then
    return jsonb_build_object('ok', false, 'code', 'BAD_CLASS');
  end if;
  if length(trim(p_title)) not between 4 and 80 then
    return jsonb_build_object('ok', false, 'code', 'BAD_TITLE');
  end if;
  if length(trim(p_body)) not between 20 and 2000 then
    return jsonb_build_object('ok', false, 'code', 'BAD_BODY');
  end if;
  if p_map is not null and p_map not in
    ('ZERO DAM','LAYALI GROVE','SPACE CITY','BRAKKESH','TIDE PRISON',
     'ASCENSION','THRESHOLD','SHAFTED','CRACKED') then
    return jsonb_build_object('ok', false, 'code', 'BAD_TAG');
  end if;
  if p_mode is not null and p_mode not in ('OPERATIONS','WARFARE') then
    return jsonb_build_object('ok', false, 'code', 'BAD_TAG');
  end if;

  v_tier := coalesce(p_clearance, v_op.clearance_index);
  if v_tier < 0 or v_tier > v_op.clearance_index then
    return jsonb_build_object('ok', false, 'code', 'BAD_CLEARANCE');
  end if;

  insert into public.intel_files (operator_id, class, clearance_index, title, body, map_tag, mode_tag)
  values (v_op.id, p_class, v_tier, trim(p_title), trim(p_body), p_map, p_mode)
  returning * into v_file;

  update public.operators
     set contributions = jsonb_set(
           contributions,
           array[p_class],
           to_jsonb(coalesce((contributions->>p_class)::int, 0) + 1)
         )
   where id = v_op.id
  returning * into v_op;

  return jsonb_build_object(
    'ok', true,
    'dossier', public._dossier(v_op),
    'fileId', v_file.id
  );
end $$;

-- ---------- feed: tags + annex counts on every row ----------

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

  select coalesce(jsonb_agg(
    case
      when f.clearance_index <= v_op.clearance_index then
        jsonb_build_object(
          'id', f.id,
          'locked', false,
          'class', f.class,
          'clearanceIndex', f.clearance_index,
          'title', f.title,
          'body', f.body,
          'author', a.callsign,
          'mine', f.operator_id = v_op.id,
          'createdAt', (extract(epoch from f.created_at) * 1000)::bigint,
          'verifications', f.verified_count,
          'isVerified', f.is_verified,
          'verifiedByMe', exists (
            select 1 from public.intel_verifications iv
             where iv.file_id = f.id and iv.operator_id = v_op.id
          ),
          'map', f.map_tag,
          'mode', f.mode_tag,
          'annexes', (select count(*) from public.intel_annexes x where x.file_id = f.id)
        )
      else
        -- locked: tags stay visible — you may know WHERE, never WHAT
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
    end
    order by f.created_at desc
  ), '[]'::jsonb)
  into v_files
  from (
    select * from public.intel_files order by created_at desc limit 100
  ) f
  join public.operators a on a.id = f.operator_id;

  return jsonb_build_object('ok', true, 'clearanceIndex', v_op.clearance_index, 'files', v_files);
end $$;

-- ---------- annexes ----------

create or replace function public.annex_intel(p_token text, p_file_id uuid, p_body text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_op public.operators;
  v_file public.intel_files;
  v_annex public.intel_annexes;
  v_count int;
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
  if length(trim(p_body)) not between 2 and 500 then
    return jsonb_build_object('ok', false, 'code', 'BAD_ANNEX');
  end if;

  insert into public.intel_annexes (file_id, operator_id, body)
  values (v_file.id, v_op.id, trim(p_body))
  returning * into v_annex;

  -- the author learns their drop was annotated (not for self-annex)
  if v_file.operator_id <> v_op.id then
    insert into public.dispatches (operator_id, kind, payload)
    values (v_file.operator_id, 'ANNEX_ADDED',
            jsonb_build_object('title', v_file.title, 'author', v_op.callsign));
  end if;

  select count(*) into v_count from public.intel_annexes where file_id = v_file.id;

  return jsonb_build_object(
    'ok', true,
    'annex', jsonb_build_object(
      'author', v_op.callsign, 'body', v_annex.body, 'mine', true,
      'createdAt', (extract(epoch from v_annex.created_at) * 1000)::bigint
    ),
    'count', v_count
  );
end $$;

create or replace function public.get_annexes(p_token text, p_file_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
as $$
declare
  v_op public.operators;
  v_file public.intel_files;
  v_out jsonb;
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'author', o.callsign,
    'body', x.body,
    'mine', x.operator_id = v_op.id,
    'createdAt', (extract(epoch from x.created_at) * 1000)::bigint
  ) order by x.created_at asc), '[]'::jsonb)
  into v_out
  from public.intel_annexes x
  join public.operators o on o.id = x.operator_id
  where x.file_id = v_file.id;

  return jsonb_build_object('ok', true, 'annexes', v_out);
end $$;

-- ---------- roster ----------

create or replace function public.get_roster(p_token text)
returns jsonb
language plpgsql stable security definer
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

  select coalesce(jsonb_agg(row_json order by clearance_index desc, verified_count desc, enlisted_at asc), '[]'::jsonb)
  into v_out
  from (
    select o.clearance_index, o.verified_count, o.enlisted_at,
      jsonb_build_object(
        'callsign', o.callsign,
        'clearanceIndex', o.clearance_index,
        'verifiedCount', o.verified_count,
        'contributions', o.contributions,
        'enlistedAt', (extract(epoch from o.enlisted_at) * 1000)::bigint,
        'drops', (select count(*) from public.intel_files f where f.operator_id = o.id),
        'annexes', (select count(*) from public.intel_annexes x where x.operator_id = o.id),
        'lastContact', (extract(epoch from coalesce(
          (select max(s.created_at) from public.sessions s where s.operator_id = o.id),
          o.enlisted_at)) * 1000)::bigint,
        'me', o.id = v_op.id
      ) as row_json
    from public.operators o
    limit 100
  ) r;

  return jsonb_build_object('ok', true, 'roster', v_out);
end $$;
