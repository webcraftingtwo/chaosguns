/* ============================================================
   config.js — relay coordinates for the live backend.
   ------------------------------------------------------------
   The publishable key is designed to ship to clients: it only
   opens the RPC surface (enlist / authenticate / recover /
   get_dossier / terminate_session). Every table is behind RLS
   with no policies, so the Data API exposes nothing else.

   Delete or blank these values to fall back to the offline
   localStorage mock (useful for local dev with no network).
   ============================================================ */

'use strict';

window.DEADDROP_CONFIG = {
  supabaseUrl: 'https://tmykcaqtnugscxdpsadq.supabase.co',
  supabaseKey: 'sb_publishable_hNRg6Pq4aOjYQNhpRvwP0A_qSd2BHyb',
};
