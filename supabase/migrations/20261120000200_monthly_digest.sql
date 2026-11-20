-- Reminder email goes monthly instead of weekly: 1st of each month, 15:00 UTC
-- (7am PST / 8am PDT). Same Vault-stored URL as before.

select cron.unschedule('weekly-network-digest');

select cron.schedule(
  'monthly-network-digest',
  '0 15 1 * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'crm_digest_url'),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  )
  where exists (select 1 from vault.decrypted_secrets where name = 'crm_digest_url');
  $$
);
