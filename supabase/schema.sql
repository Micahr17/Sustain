-- =====================================================================
-- Sustain — cloud sync schema
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New
-- query → paste → Run).
--
-- The security model that matters is Row Level Security. Every policy
-- below compares auth.uid() — the identity Supabase derives from the
-- request's signed token — against the row's user_id. The browser never
-- gets to say who it is. Even though the anon key is public and shipped
-- in the page (that is what it is for), a signed-in user can only ever
-- read or write their own rows, and an anonymous request can read
-- nothing at all.
-- =====================================================================

-- ---------------------------------------------------------------------
-- One row per night. The evening half and the morning half live in the
-- same row, mirroring the local model exactly, so sync stays a copy
-- rather than a translation.
-- ---------------------------------------------------------------------
create table if not exists public.nights (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  date        date        not null,
  evening     jsonb,
  morning     jsonb,
  complete    boolean     not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, date)
);

-- ---------------------------------------------------------------------
-- Habits, preferences and saved insights: small enough to keep as one
-- row per user rather than three more tables.
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  user_id     uuid        primary key references auth.users(id) on delete cascade,
  habits      jsonb       not null default '[]'::jsonb,
  settings    jsonb       not null default '{}'::jsonb,
  insights    jsonb       not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.nights   enable row level security;
alter table public.profiles enable row level security;

-- Policies are written per action rather than as one blanket rule, so a
-- mistake in one cannot silently widen the others.
drop policy if exists nights_select on public.nights;
drop policy if exists nights_insert on public.nights;
drop policy if exists nights_update on public.nights;
drop policy if exists nights_delete on public.nights;

create policy nights_select on public.nights
  for select using (auth.uid() = user_id);
create policy nights_insert on public.nights
  for insert with check (auth.uid() = user_id);
create policy nights_update on public.nights
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy nights_delete on public.nights
  for delete using (auth.uid() = user_id);

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;

create policy profiles_select on public.profiles
  for select using (auth.uid() = user_id);
create policy profiles_insert on public.profiles
  for insert with check (auth.uid() = user_id);
create policy profiles_update on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Fetching "my nights, newest first" is the only read pattern the app has.
create index if not exists nights_user_date_idx
  on public.nights (user_id, date desc);

-- updated_at drives last-write-wins during sync, so it must not depend on
-- the client's clock being honest.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists nights_touch on public.nights;
create trigger nights_touch before insert or update on public.nights
  for each row execute function public.touch_updated_at();

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before insert or update on public.profiles
  for each row execute function public.touch_updated_at();
