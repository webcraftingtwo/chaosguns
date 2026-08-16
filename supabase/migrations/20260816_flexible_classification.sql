-- ============================================================
-- FLEXIBLE CLASSIFICATION: an operator may file a drop at any
-- tier UP TO their own clearance (a COMPARTMENTED operator can
-- publish beginner intel at RESTRICTED, or keep it inside the
-- compartment at tier 4). Omitted tier defaults to the author's
-- clearance — the old behavior.
-- The old 4-arg signature is dropped so PostgREST resolution
-- stays unambiguous.
--
-- Applied to project deaddrop-intel-network (tmykcaqtnugscxdpsadq)
-- as migration `flexible_classification`.
-- ============================================================

drop function public.file_intel(text, text, text, text);

create function public.file_intel(
  p_token text, p_class text, p_title text, p_body text,
  p_clearance int default null
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

  v_tier := coalesce(p_clearance, v_op.clearance_index);
  -- never above the author's own clearance
  if v_tier < 0 or v_tier > v_op.clearance_index then
    return jsonb_build_object('ok', false, 'code', 'BAD_CLEARANCE');
  end if;

  insert into public.intel_files (operator_id, class, clearance_index, title, body)
  values (v_op.id, p_class, v_tier, trim(p_title), trim(p_body))
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
