begin;

create or replace function rummy500.set_player_ready(p_game_id uuid, p_ready boolean)
returns void
language plpgsql
security definer
set search_path = rummy500, public
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from rummy500.games
    where id = p_game_id
      and status = 'lobby'
  ) then
    raise exception 'Game is not accepting ready-state changes';
  end if;

  update rummy500.game_players
  set ready = p_ready
  where game_id = p_game_id
    and user_id = current_user_id;

  if not found then
    raise exception 'Player is not seated in this game';
  end if;

  insert into rummy500.game_actions (game_id, actor_user_id, action_type, payload)
  values (
    p_game_id,
    current_user_id,
    'set_ready',
    jsonb_build_object('ready', p_ready)
  );
end;
$$;

grant execute on function rummy500.set_player_ready(uuid, boolean) to authenticated, service_role;

commit;
