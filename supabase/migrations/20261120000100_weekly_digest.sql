-- Weekly reminder email: every Monday 15:00 UTC (7am PST / 8am PDT), call the
-- edge function's /digest route.
--
-- The digest URL contains MCP_SECRET, so it lives in Supabase Vault rather than
-- in this repo. Store it once (see README):
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/crm-mcp/<MCP_SECRET>/digest', 'crm_digest_url');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'weekly-network-digest',
  '0 15 * * 1',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'crm_digest_url'),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  )
  where exists (select 1 from vault.decrypted_secrets where name = 'crm_digest_url');
  $$
);
