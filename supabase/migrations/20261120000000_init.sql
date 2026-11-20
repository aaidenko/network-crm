-- Network CRM schema: people, the interactions you've had with them, and
-- follow-ups you owe them. Access goes only through the service role (the MCP
-- edge function); RLS is on with no policies, so the public anon key sees nothing.

create extension if not exists pg_trgm with schema extensions;

create table public.people (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  company       text,
  role          text,
  email         text,
  phone         text,
  linkedin      text,
  location      text,
  how_met       text,
  met_on        date,
  introduced_by text,
  tags          text[] not null default '{}',
  cadence_days  integer not null default 90 check (cadence_days > 0),
  notes         text,
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.interactions (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references public.people (id) on delete cascade,
  occurred_on date not null default current_date,
  channel     text,
  summary     text not null,
  created_at  timestamptz not null default now()
);

create table public.follow_ups (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references public.people (id) on delete cascade,
  description text not null,
  due_on      date,
  done_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index people_name_trgm on public.people using gin (name extensions.gin_trgm_ops);
create index people_tags on public.people using gin (tags);
create index interactions_person_date on public.interactions (person_id, occurred_on desc);
create index follow_ups_open on public.follow_ups (person_id) where done_at is null;

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger people_touch before update on public.people
  for each row execute function public.touch_updated_at();

alter table public.people       enable row level security;
alter table public.interactions enable row level security;
alter table public.follow_ups   enable row level security;

-- Each person with their last contact and when they're next due.
-- Before any logged interaction, the clock starts from when you met (or were added).
create view public.people_status with (security_invoker = true) as
select
  p.*,
  li.last_contact,
  coalesce(li.last_contact, p.met_on, p.created_at::date) + p.cadence_days as next_due,
  (select count(*) from public.follow_ups f
    where f.person_id = p.id and f.done_at is null)::int as open_follow_ups
from public.people p
left join lateral (
  select max(i.occurred_on) as last_contact
  from public.interactions i
  where i.person_id = p.id
) li on true;

-- Fuzzy search across name, company, role, how you met, and tags.
create function public.search_people(q text, lim integer default 10)
returns setof public.people_status
language sql stable security invoker
set search_path = public, extensions
as $$
  select s.*
  from public.people_status s
  where not s.archived
    and (
      s.name ilike '%' || q || '%'
      or s.company ilike '%' || q || '%'
      or s.role ilike '%' || q || '%'
      or s.how_met ilike '%' || q || '%'
      or lower(q) = any (s.tags)
      or similarity(s.name, q) > 0.25
    )
  order by
    greatest(similarity(s.name, q), similarity(coalesce(s.company, ''), q)) desc,
    s.name
  limit lim;
$$;

revoke all on public.people_status from anon, authenticated;
revoke execute on function public.search_people(text, integer) from public, anon, authenticated;
grant select on public.people_status to service_role;
grant execute on function public.search_people(text, integer) to service_role;
