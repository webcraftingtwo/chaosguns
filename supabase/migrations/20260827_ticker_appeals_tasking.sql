-- ============================================================
-- ACTIVITY TICKER + BURN APPEALS + STANDING TASKING
--
-- Ticker: the network's recent movement, assembled from what
-- already happened (files, verifications, burns, annexes,
-- enlistments, promotions) — no new write path. Titles above the
-- viewer's clearance are withheld; the event itself still shows.
--
-- Appeals: the author of a burned drop may file one appeal. Two
-- reinstatements from cleared operators lift the burn, recompute
-- the drop's verification from the confirmations it still holds,
-- and hand the author's credit back. Clearance already granted is
-- never clawed back in either direction.
--
-- Tasking: what this operator could usefully do next.
--
-- Applied to project deaddrop-intel-network (tmykcaqtnugscxdpsadq)
-- as migrations `ticker_appeals_tasking` + `ticker_tasking_functions`.
-- NOTE: applied after an unplanned project pause/restore; no data
-- was lost, but see the header of 20260827_schema_baseline.sql.
-- ============================================================

alter table public.operators add column promoted_at timestamptz;

alter table public.intel_files
  add column appeal_text text check (appeal_text is null or length(appeal_text) between 10 and 500),
  add column appeal_at timestamptz;

create table public.intel_reinstates (
  file_id     uuid not null references public.intel_files(id) on delete cascade,
  operator_id uuid not null references public.operators(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (file_id, operator_id)
);
alter table public.intel_reinstates enable row level security;
revoke all on public.intel_reinstates from anon, authenticated;

alter table public.dispatches drop constraint dispatches_kind_check;
alter table public.dispatches add constraint dispatches_kind_check
  check (kind in ('INTEL_VERIFIED','CLEARANCE_GRANTED','ANNEX_ADDED',
                  'BURN_NOTICE','APPEAL_FILED','BURN_LIFTED'));

-- _file_row gains appeal state; verify_intel and redeem_compartment_key
-- gain promoted_at stamping; appeal_burn, reinstate_intel, get_activity
-- and get_tasking are added. Full bodies are those applied to the
-- project; see git history of this file for the exact text.
