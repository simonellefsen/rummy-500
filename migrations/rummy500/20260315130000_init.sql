create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists rummy500;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'rummy500'
      and t.typname = 'game_status'
  ) then
    create type rummy500.game_status as enum ('lobby', 'dealing', 'in_progress', 'finished', 'cancelled');
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'rummy500'
      and t.typname = 'round_status'
  ) then
    create type rummy500.round_status as enum ('waiting', 'active', 'finished');
  end if;
end
$$;

create or replace function rummy500.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists rummy500.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists rummy500.games (
  id uuid primary key default gen_random_uuid(),
  invite_code text not null,
  host_user_id uuid not null references auth.users (id) on delete restrict,
  status rummy500.game_status not null default 'lobby',
  config jsonb not null default '{}'::jsonb,
  turn_user_id uuid references auth.users (id) on delete set null,
  round_number integer not null default 0,
  winner_user_id uuid references auth.users (id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint games_invite_code_not_blank check (length(trim(invite_code)) >= 4),
  constraint games_config_is_object check (jsonb_typeof(config) = 'object')
);

create unique index if not exists games_invite_code_key on rummy500.games (invite_code);
create index if not exists games_host_user_id_idx on rummy500.games (host_user_id);

create table if not exists rummy500.game_players (
  game_id uuid not null references rummy500.games (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  seat_index integer not null,
  ready boolean not null default false,
  total_score integer not null default 0,
  current_hand_score integer not null default 0,
  joined_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (game_id, user_id),
  constraint game_players_seat_index_non_negative check (seat_index >= 0)
);

create unique index if not exists game_players_game_seat_idx on rummy500.game_players (game_id, seat_index);
create index if not exists game_players_user_id_idx on rummy500.game_players (user_id);

create table if not exists rummy500.game_rounds (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references rummy500.games (id) on delete cascade,
  round_number integer not null,
  dealer_user_id uuid references auth.users (id) on delete set null,
  status rummy500.round_status not null default 'waiting',
  stock_count integer not null default 0,
  discard_pile jsonb not null default '[]'::jsonb,
  table_melds jsonb not null default '[]'::jsonb,
  action_log jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  unique (game_id, round_number),
  constraint game_rounds_discard_array check (jsonb_typeof(discard_pile) = 'array'),
  constraint game_rounds_melds_array check (jsonb_typeof(table_melds) = 'array'),
  constraint game_rounds_action_log_array check (jsonb_typeof(action_log) = 'array')
);

create index if not exists game_rounds_game_id_idx on rummy500.game_rounds (game_id);

create table if not exists rummy500.player_hands (
  round_id uuid not null references rummy500.game_rounds (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  cards jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (round_id, user_id),
  constraint player_hands_cards_array check (jsonb_typeof(cards) = 'array')
);

create index if not exists player_hands_user_id_idx on rummy500.player_hands (user_id);

create table if not exists rummy500.game_actions (
  id bigint generated always as identity primary key,
  game_id uuid not null references rummy500.games (id) on delete cascade,
  round_id uuid references rummy500.game_rounds (id) on delete cascade,
  actor_user_id uuid not null references auth.users (id) on delete restrict,
  action_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint game_actions_payload_is_object check (jsonb_typeof(payload) = 'object')
);

create index if not exists game_actions_game_id_created_idx on rummy500.game_actions (game_id, created_at desc);

drop trigger if exists profiles_set_updated_at on rummy500.profiles;
create trigger profiles_set_updated_at
before update on rummy500.profiles
for each row execute function rummy500.set_updated_at();

drop trigger if exists games_set_updated_at on rummy500.games;
create trigger games_set_updated_at
before update on rummy500.games
for each row execute function rummy500.set_updated_at();

drop trigger if exists game_players_set_updated_at on rummy500.game_players;
create trigger game_players_set_updated_at
before update on rummy500.game_players
for each row execute function rummy500.set_updated_at();

drop trigger if exists game_rounds_set_updated_at on rummy500.game_rounds;
create trigger game_rounds_set_updated_at
before update on rummy500.game_rounds
for each row execute function rummy500.set_updated_at();

drop trigger if exists player_hands_set_updated_at on rummy500.player_hands;
create trigger player_hands_set_updated_at
before update on rummy500.player_hands
for each row execute function rummy500.set_updated_at();

create or replace function rummy500.generate_invite_code(code_length integer default 6)
returns text
language plpgsql
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  idx integer;
begin
  loop
    candidate := '';
    for idx in 1..code_length loop
      candidate := candidate || substr(alphabet, floor(random() * length(alphabet) + 1)::integer, 1);
    end loop;

    exit when not exists (
      select 1
      from rummy500.games
      where invite_code = candidate
    );
  end loop;

  return candidate;
end;
$$;

create or replace function rummy500.is_game_participant(target_game_id uuid)
returns boolean
language sql
stable
security definer
set search_path = rummy500, public
as $$
  select exists (
    select 1
    from rummy500.game_players gp
    where gp.game_id = target_game_id
      and gp.user_id = auth.uid()
  );
$$;

create or replace function rummy500.create_game(p_config jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = rummy500, public
as $$
declare
  current_user_id uuid := auth.uid();
  next_game_id uuid;
  next_invite_code text;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  next_invite_code := rummy500.generate_invite_code();

  insert into rummy500.games (invite_code, host_user_id, config)
  values (next_invite_code, current_user_id, coalesce(p_config, '{}'::jsonb))
  returning id into next_game_id;

  insert into rummy500.game_players (game_id, user_id, seat_index, ready)
  values (next_game_id, current_user_id, 0, true);

  return next_game_id;
end;
$$;

create or replace function rummy500.join_game(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = rummy500, public
as $$
declare
  current_user_id uuid := auth.uid();
  target_game rummy500.games%rowtype;
  seat_count integer;
  max_players integer;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  select *
  into target_game
  from rummy500.games
  where invite_code = upper(trim(p_invite_code));

  if not found then
    raise exception 'Game not found';
  end if;

  if target_game.status <> 'lobby' then
    raise exception 'Game is no longer joinable';
  end if;

  if exists (
    select 1
    from rummy500.game_players
    where game_id = target_game.id
      and user_id = current_user_id
  ) then
    return target_game.id;
  end if;

  select count(*)
  into seat_count
  from rummy500.game_players
  where game_id = target_game.id;

  max_players := coalesce((target_game.config ->> 'max_players')::integer, 8);

  if seat_count >= max_players then
    raise exception 'Game is full';
  end if;

  insert into rummy500.game_players (game_id, user_id, seat_index, ready)
  values (target_game.id, current_user_id, seat_count, false);

  return target_game.id;
end;
$$;

grant usage on schema rummy500 to authenticated, service_role;
grant select on all tables in schema rummy500 to authenticated;
grant insert, update on rummy500.profiles to authenticated;
grant all on all tables in schema rummy500 to service_role;
grant usage, select on all sequences in schema rummy500 to service_role;
grant execute on function rummy500.generate_invite_code(integer) to authenticated, service_role;
grant execute on function rummy500.is_game_participant(uuid) to authenticated, service_role;
grant execute on function rummy500.create_game(jsonb) to authenticated, service_role;
grant execute on function rummy500.join_game(text) to authenticated, service_role;

alter table rummy500.profiles enable row level security;
alter table rummy500.games enable row level security;
alter table rummy500.game_players enable row level security;
alter table rummy500.game_rounds enable row level security;
alter table rummy500.player_hands enable row level security;
alter table rummy500.game_actions enable row level security;

drop policy if exists "profiles_select_authenticated" on rummy500.profiles;
create policy "profiles_select_authenticated"
on rummy500.profiles
for select
to authenticated
using (true);

drop policy if exists "profiles_insert_self" on rummy500.profiles;
create policy "profiles_insert_self"
on rummy500.profiles
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "profiles_update_self" on rummy500.profiles;
create policy "profiles_update_self"
on rummy500.profiles
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "games_select_participants" on rummy500.games;
create policy "games_select_participants"
on rummy500.games
for select
to authenticated
using (rummy500.is_game_participant(id));

drop policy if exists "game_players_select_participants" on rummy500.game_players;
create policy "game_players_select_participants"
on rummy500.game_players
for select
to authenticated
using (rummy500.is_game_participant(game_id));

drop policy if exists "game_rounds_select_participants" on rummy500.game_rounds;
create policy "game_rounds_select_participants"
on rummy500.game_rounds
for select
to authenticated
using (rummy500.is_game_participant(game_id));

drop policy if exists "player_hands_select_owner" on rummy500.player_hands;
create policy "player_hands_select_owner"
on rummy500.player_hands
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "game_actions_select_participants" on rummy500.game_actions;
create policy "game_actions_select_participants"
on rummy500.game_actions
for select
to authenticated
using (rummy500.is_game_participant(game_id));
