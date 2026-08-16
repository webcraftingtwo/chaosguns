-- ============================================================
-- INTEL FILING: file drops, read the clearance-gated feed,
-- verify other operators' intel. Verification is the engine:
-- 2 confirmations flip a file to VERIFIED, which credits the
-- author and auto-promotes clearance through the tier ladder
-- (0 / 3 / 8 / 20 / 50 verified files).
-- Same posture as deaddrop_core: RLS everywhere, no policies,
-- SECURITY DEFINER RPCs are the only door.
--
-- Applied to project deaddrop-intel-network (tmykcaqtnugscxdpsadq)
-- as migration `intel_filing`.
-- ============================================================

alter table public.intel_files
  add column is_verified boolean not null default false;

create table public.intel_verifications (
  file_id     uuid not null references public.intel_files(id) on delete cascade,
  operator_id uuid not null references public.operators(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (file_id, operator_id)
);

alter table public.intel_verifications enable row level security;
revoke all on public.intel_verifications from anon, authenticated;

create index intel_files_created_idx on public.intel_files (created_at desc);

-- ---------- helpers (not callable from the API) ----------

create or replace function public._operator_from_token(p_token text)
returns public.operators
language sql stable
set search_path = public, extensions
as $$
  select o.*
    from public.sessions s
    join public.operators o on o.id = s.operator_id
   where s.token = p_token and s.expires_at > now();
$$;

revoke execute on function public._operator_from_token(text) from public, anon, authenticated;

-- ---------- RPC surface ----------

create or replace function public.file_intel(p_token text, p_class text, p_title text, p_body text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare
  v_op public.operators;
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

  -- intel is classified at the author's clearance at filing time
  insert into public.intel_files (operator_id, class, clearance_index, title, body)
  values (v_op.id, p_class, v_op.clearance_index, trim(p_title), trim(p_body))
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
          )
        )
      else
        -- above the viewer's clearance: class, tier and date only —
        -- title and payload never leave the database
        jsonb_build_object(
          'id', f.id,
          'locked', true,
          'class', f.class,
          'clearanceIndex', f.clearance_index,
          'createdAt', (extract(epoch from f.created_at) * 1000)::bigint
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

  -- crossing the threshold confirms the drop and credits the author
  if v_file.verified_count >= c_threshold and not v_file.is_verified then
    update public.intel_files set is_verified = true where id = v_file.id;
    v_file.is_verified := true;

    update public.operators
       set verified_count = verified_count + 1
     where id = v_file.operator_id
    returning * into v_author;

    -- auto-promote through any tier requirements now met
    while v_author.clearance_index < 4
      and v_author.verified_count >= c_requirements[v_author.clearance_index + 2] loop
      update public.operators
         set clearance_index = clearance_index + 1
       where id = v_author.id
      returning * into v_author;
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'verifications', v_file.verified_count,
    'isVerified', v_file.is_verified
  );
end $$;
