-- Who knows whom. One row per pair, stored with person_a < person_b so a pair
-- can't be entered twice in opposite directions.

create table public.relationships (
  id         uuid primary key default gen_random_uuid(),
  person_a   uuid not null references public.people (id) on delete cascade,
  person_b   uuid not null references public.people (id) on delete cascade,
  note       text,
  created_at timestamptz not null default now(),
  check (person_a < person_b),
  unique (person_a, person_b)
);

create index relationships_b on public.relationships (person_b);

alter table public.relationships enable row level security;
