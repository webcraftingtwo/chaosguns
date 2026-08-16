-- ============================================================
-- ZONE TAGS: drops can be pinned to a named zone within a
-- theater (e.g. ZERO DAM // SPILLWAY). Zone names are defined
-- client-side in js/maps.js so new maps and renamed zones need
-- no migration; the column validates shape only (<= 40 chars).
-- A zone without a theater is rejected.
--
-- Applied to project deaddrop-intel-network (tmykcaqtnugscxdpsadq)
-- as migration `zone_tags`.
-- ============================================================

alter table public.intel_files
  add column zone_tag text check (zone_tag is null or length(zone_tag) between 1 and 40);

drop function public.file_intel(text, text, text, text, int, text, text);

create function public.file_intel(
  p_token text, p_class text, p_title text, p_body text,
  p_clearance int default null, p_map text default null,
  p_mode text default null, p_zone text default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_op public.operators;
  v_tier int;
  v_zone text := nullif(trim(coalesce(p_zone, '')), '');
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
  if v_zone is not null and (p_map is null or length(v_zone) > 40) then
    -- a zone without a theater is meaningless
    return jsonb_build_object('ok', false, 'code', 'BAD_TAG');
  end if;

  v_tier := coalesce(p_clearance, v_op.clearance_index);
  if v_tier < 0 or v_tier > v_op.clearance_index then
    return jsonb_build_object('ok', false, 'code', 'BAD_CLEARANCE');
  end if;

  insert into public.intel_files
    (operator_id, class, clearance_index, title, body, map_tag, mode_tag, zone_tag)
  values
    (v_op.id, p_class, v_tier, trim(p_title), trim(p_body), p_map, p_mode, v_zone)
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

-- ---------- row builder exposes the zone on both locked and open rows ----------

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
        'zone', f.zone_tag,
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
        'zone', f.zone_tag,
        'annexes', (select count(*) from public.intel_annexes x where x.file_id = f.id)
      )
  end;
$$;

revoke execute on function public._file_row(public.intel_files, public.operators)
  from public, anon, authenticated;
