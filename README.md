# Network CRM

A personal CRM for keeping up with your professional network, with **no app and no UI to build**. You talk to it through Claude (phone, desktop, or web) via a remote [MCP](https://modelcontextprotocol.io) server.

> "Had coffee with Priya from Stripe yesterday. She's moving to their AI infra team. Remind me to send her the eval paper this week."

Claude finds Priya (or adds her), logs the conversation, resets her reach-out clock, and creates the follow-up. On the 1st of each month you get a short email listing who you've lost touch with.

No LLM API calls: Claude does the language understanding inside your existing Claude plan. The server is a thin, deterministic layer over Postgres.

## Architecture

```
Claude app (phone / desktop / web)
        │  custom connector (remote MCP, Streamable HTTP)
        ▼
Supabase Edge Function  supabase/functions/crm-mcp
        │  service role
        ▼
Postgres                supabase/migrations
        ▲
pg_cron ── monthly POST /digest ──► Resend email
```

- **Stateless MCP over HTTP** with JSON responses, implemented directly (no SDK) in about 100 lines: [`index.ts`](supabase/functions/crm-mcp/index.ts)
- **Tools**: [`tools.ts`](supabase/functions/crm-mcp/tools.ts)
- **Schema**: `people`, `interactions`, `follow_ups`, plus a `people_status` view that computes `last_contact` and `next_due` from each person's cadence
- **Fuzzy name resolution** with `pg_trgm`: "priya" or "Priyaa Sha" finds Priya Shah. Ambiguous names return candidates so Claude asks you which one you meant.

## Tools

| Tool | Purpose |
|---|---|
| `who_to_reach_out` | People past their cadence, plus follow-ups that are due |
| `find_people` | Fuzzy search by name, company, role, how you met, tag |
| `get_person` | Full profile, interaction history, open follow-ups |
| `add_person` | Add someone (refuses duplicates unless asked) |
| `update_person` | Edit fields, add/remove tags, append dated notes, change cadence |
| `log_interaction` | Record a conversation and optionally a follow-up |
| `list_follow_ups` / `complete_follow_up` | Things you owe people |
| `delete_interaction` | Undo a mistaken log |
| `archive_person` | Hide someone from reminders and search (reversible) |

**Cadence** is how often you want to stay in touch, in days: 30 for close contacts, 90 by default, 180 for loose ones. Someone is due when `last contact + cadence` has passed. Before any interaction is logged, the clock starts from when you met them.

## Security model

- **RLS is on, with no policies.** The public anon key can't read anything. Only the edge function (service role) touches the data.
- **The MCP endpoint lives at a secret path:** `/functions/v1/crm-mcp/<MCP_SECRET>`. Claude custom connectors can't send a Supabase JWT, so the secret URL acts as the credential. Treat that URL like a password. Requests with a wrong or missing secret get a 404.
- **The cron job reads the digest URL from Supabase Vault,** so no secret appears in this repo.

## Setup

Prerequisites: [Supabase CLI](https://supabase.com/docs/guides/cli) and a Supabase project.

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push                      # tables, view, search function, cron job

SECRET=$(openssl rand -hex 24)
supabase secrets set MCP_SECRET=$SECRET CRM_TIMEZONE=America/Los_Angeles
supabase functions deploy crm-mcp --no-verify-jwt

echo "https://<project-ref>.supabase.co/functions/v1/crm-mcp/$SECRET"
```

**Connect Claude:** on claude.ai, go to *Settings → Connectors → Add custom connector* and paste the URL. It then works in the Claude mobile and desktop apps too.

**Monthly email (optional):** create a free [Resend](https://resend.com) account and an API key. Without a verified domain, Resend only delivers to your own account email.

```bash
supabase secrets set RESEND_API_KEY=re_... DIGEST_EMAIL=you@example.com
```

Then, in the Supabase SQL editor, run:

```sql
select vault.create_secret(
  'https://<project-ref>.supabase.co/functions/v1/crm-mcp/<MCP_SECRET>/digest',
  'crm_digest_url'
);
```

The digest runs on the 1st of each month at 15:00 UTC. To change that, add a migration that reschedules `monthly-network-digest` (see `supabase/migrations/*_monthly_digest.sql`).

## Local development

```bash
supabase start
echo "MCP_SECRET=localtest" > /tmp/crm.env
supabase functions serve --env-file /tmp/crm.env

curl -s -X POST http://127.0.0.1:56321/functions/v1/crm-mcp/localtest \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Local ports are moved to 563xx in `supabase/config.toml` so they don't collide with other local Supabase projects.

## License

MIT
