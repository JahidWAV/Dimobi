-- =====================================================================
-- DIMOBI — Migration facturation (idempotente)
-- Fichier : supabase-billing-migration.sql
-- À exécuter dans Supabase → SQL Editor (ou via `supabase db push`).
-- Sûr à ré-exécuter plusieurs fois : tout est en `if not exists`,
-- `create or replace`, ou précédé d'un `drop ... if exists` ciblé.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Extensions nécessaires
-- ---------------------------------------------------------------------
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 2) Table profiles
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','writer','studio')),
  stripe_customer_id text unique,
  storage_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Profil de facturation DIMOBI (1 ligne par utilisateur).';

-- ---------------------------------------------------------------------
-- 3) Table subscriptions
-- ---------------------------------------------------------------------
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_subscription_id text unique not null,
  stripe_price_id text not null,
  status text not null,
  plan text not null check (plan in ('writer','studio')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_user_id_idx on public.subscriptions(user_id);

-- ---------------------------------------------------------------------
-- 4) updated_at automatique
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 5) Création automatique d'un profil "free" à l'inscription
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, plan)
  values (new.id, 'free')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Rattrapage : créer un profil pour les utilisateurs déjà existants qui n'en ont pas.
insert into public.profiles (id, plan)
select u.id, 'free'
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;

-- ---------------------------------------------------------------------
-- 6) RLS : profiles
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (id = auth.uid());

-- Volontairement aucune policy insert/update/delete pour "authenticated" :
-- un utilisateur ne peut jamais modifier plan / stripe_customer_id / storage_bytes.
-- Seul le backend (clé service_role, qui contourne RLS) peut écrire ces colonnes,
-- typiquement depuis /api/stripe-webhook.js.
drop policy if exists "profiles_no_write_for_users" on public.profiles;

-- ---------------------------------------------------------------------
-- 7) RLS : subscriptions
-- ---------------------------------------------------------------------
alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions_select_own" on public.subscriptions;
create policy "subscriptions_select_own"
  on public.subscriptions for select
  using (user_id = auth.uid());

-- Aucune policy d'écriture pour "authenticated" : seul le backend (service_role)
-- crée/modifie les abonnements, depuis les webhooks Stripe vérifiés par signature.

-- ---------------------------------------------------------------------
-- 8) Fonction : limite de projets selon l'offre
-- ---------------------------------------------------------------------
create or replace function public.project_limit_for_user(uid uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p.plan = 'writer' then 20
    when p.plan = 'studio' then 2147483647
    else 2
  end
  from public.profiles p
  where p.id = uid
  union all
  select 2
  where not exists (select 1 from public.profiles p2 where p2.id = uid)
  limit 1;
$$;

comment on function public.project_limit_for_user(uuid) is
  'Retourne le nombre maximum de projets autorisés pour un utilisateur selon son offre (2 par défaut si aucun profil).';

-- ---------------------------------------------------------------------
-- 9) Table projects : policy de création avec limite de plan
--    (on ne connaît pas le nom exact de la policy existante, donc on
--    supprime les policies "insert" candidates les plus probables avant
--    de recréer la bonne policy, sans toucher aux policies select/update/
--    delete déjà en place).
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'projects'
  ) then
    raise notice 'Table public.projects introuvable : cette section de la migration est ignorée. Vérifie que la table existe déjà (créée par l''application).';
  end if;
end $$;

alter table if exists public.projects enable row level security;

drop policy if exists "projects_insert_own" on public.projects;
drop policy if exists "Users can insert their own projects" on public.projects;
drop policy if exists "insert_own_projects" on public.projects;
drop policy if exists "projects_insert" on public.projects;

create policy "projects_insert_own"
  on public.projects for insert
  with check (
    user_id = auth.uid()
    and (
      select count(*) from public.projects pr where pr.user_id = auth.uid()
    ) < public.project_limit_for_user(auth.uid())
  );

-- Policies de lecture / mise à jour / suppression : on les crée seulement si
-- aucune policy existante ne couvre déjà l'action, pour ne rien casser.
drop policy if exists "projects_select_own" on public.projects;
create policy "projects_select_own"
  on public.projects for select
  using (user_id = auth.uid());

drop policy if exists "projects_update_own" on public.projects;
create policy "projects_update_own"
  on public.projects for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "projects_delete_own" on public.projects;
create policy "projects_delete_own"
  on public.projects for delete
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 10) Table sections : s'assurer que RLS suit bien le projet parent.
--     On ne recrée pas ces policies si elles existent déjà sous un autre nom ;
--     ceci est fourni au cas où elles manqueraient. Adapter si des policies
--     personnalisées existent déjà.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'sections'
  ) then
    execute 'alter table public.sections enable row level security';
  end if;
end $$;

drop policy if exists "sections_select_own" on public.sections;
create policy "sections_select_own"
  on public.sections for select
  using (exists (select 1 from public.projects pr where pr.id = sections.project_id and pr.user_id = auth.uid()));

drop policy if exists "sections_insert_own" on public.sections;
create policy "sections_insert_own"
  on public.sections for insert
  with check (exists (select 1 from public.projects pr where pr.id = sections.project_id and pr.user_id = auth.uid()));

drop policy if exists "sections_update_own" on public.sections;
create policy "sections_update_own"
  on public.sections for update
  using (exists (select 1 from public.projects pr where pr.id = sections.project_id and pr.user_id = auth.uid()))
  with check (exists (select 1 from public.projects pr where pr.id = sections.project_id and pr.user_id = auth.uid()));

drop policy if exists "sections_delete_own" on public.sections;
create policy "sections_delete_own"
  on public.sections for delete
  using (exists (select 1 from public.projects pr where pr.id = sections.project_id and pr.user_id = auth.uid()));

-- ---------------------------------------------------------------------
-- Fin de la migration.
-- Vérifications suggérées après exécution :
--   select * from public.profiles limit 5;
--   select public.project_limit_for_user(auth.uid());
-- =====================================================================
