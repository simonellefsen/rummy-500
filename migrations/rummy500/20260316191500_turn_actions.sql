alter table rummy500.game_rounds
add column if not exists stock_pile jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'game_rounds_stock_pile_array'
      and connamespace = 'rummy500'::regnamespace
  ) then
    alter table rummy500.game_rounds
    add constraint game_rounds_stock_pile_array check (jsonb_typeof(stock_pile) = 'array');
  end if;
end
$$;

create or replace function rummy500.play_turn_action(
  p_game_id uuid,
  p_action text,
  p_card_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = rummy500, public
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_action text := lower(trim(coalesce(p_action, '')));
  current_game rummy500.games%rowtype;
  current_round rummy500.game_rounds%rowtype;
  current_hand jsonb;
  current_hand_count integer;
  player_count integer;
  cards_per_player integer;
  discard_count integer;
  current_seat_index integer;
  next_turn_user_id uuid;
  drawn_card jsonb;
  discarded_card jsonb;
  next_stock_pile jsonb := '[]'::jsonb;
  next_discard_pile jsonb := '[]'::jsonb;
  next_hand jsonb := '[]'::jsonb;
  event_payload jsonb;
  target_card_ordinality integer;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  select *
  into current_game
  from rummy500.games
  where id = p_game_id
  for update;

  if not found then
    raise exception 'Game not found';
  end if;

  if current_game.status <> 'in_progress' then
    raise exception 'Game is not currently in progress';
  end if;

  if current_game.turn_user_id is distinct from current_user_id then
    raise exception 'It is not your turn';
  end if;

  select *
  into current_round
  from rummy500.game_rounds
  where game_id = p_game_id
    and round_number = current_game.round_number
  order by round_number desc
  limit 1
  for update;

  if not found or current_round.status <> 'active' then
    raise exception 'No active round found';
  end if;

  select cards
  into current_hand
  from rummy500.player_hands
  where round_id = current_round.id
    and user_id = current_user_id
  for update;

  if not found then
    raise exception 'Current player hand not found';
  end if;

  current_hand_count := jsonb_array_length(current_hand);

  select count(*)
  into player_count
  from rummy500.game_players
  where game_id = p_game_id;

  cards_per_player := coalesce((current_game.config ->> 'cardsPerPlayer')::integer, case when player_count = 2 then 13 else 7 end);

  if normalized_action = 'draw_stock' then
    if current_hand_count <> cards_per_player then
      raise exception 'You must discard before drawing again';
    end if;

    if jsonb_array_length(current_round.stock_pile) = 0 then
      raise exception 'The stock pile is empty';
    end if;

    drawn_card := current_round.stock_pile -> 0;

    select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
    into next_stock_pile
    from jsonb_array_elements(current_round.stock_pile) with ordinality as stock(value, ordinality)
    where ordinality > 1;

    next_hand := current_hand || jsonb_build_array(drawn_card);

    update rummy500.player_hands
    set cards = next_hand
    where round_id = current_round.id
      and user_id = current_user_id;

    event_payload := jsonb_build_object(
      'type', 'draw_stock',
      'actor_user_id', current_user_id,
      'at', timezone('utc', now()),
      'stock_count', jsonb_array_length(next_stock_pile)
    );

    update rummy500.game_rounds
    set stock_pile = next_stock_pile,
        stock_count = jsonb_array_length(next_stock_pile),
        action_log = action_log || jsonb_build_array(event_payload)
    where id = current_round.id;

    insert into rummy500.game_actions (game_id, round_id, actor_user_id, action_type, payload)
    values (
      p_game_id,
      current_round.id,
      current_user_id,
      'draw_stock',
      jsonb_build_object('stock_count', jsonb_array_length(next_stock_pile))
    );

    return jsonb_build_object(
      'action', 'draw_stock',
      'stock_count', jsonb_array_length(next_stock_pile)
    );
  end if;

  if normalized_action = 'draw_discard_top' then
    if current_hand_count <> cards_per_player then
      raise exception 'You must discard before drawing again';
    end if;

    discard_count := jsonb_array_length(current_round.discard_pile);

    if discard_count = 0 then
      raise exception 'The discard pile is empty';
    end if;

    drawn_card := current_round.discard_pile -> (discard_count - 1);

    select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
    into next_discard_pile
    from jsonb_array_elements(current_round.discard_pile) with ordinality as discard(value, ordinality)
    where ordinality < discard_count;

    next_hand := current_hand || jsonb_build_array(drawn_card);

    update rummy500.player_hands
    set cards = next_hand
    where round_id = current_round.id
      and user_id = current_user_id;

    event_payload := jsonb_build_object(
      'type', 'draw_discard_top',
      'actor_user_id', current_user_id,
      'at', timezone('utc', now()),
      'card', drawn_card
    );

    update rummy500.game_rounds
    set discard_pile = next_discard_pile,
        action_log = action_log || jsonb_build_array(event_payload)
    where id = current_round.id;

    insert into rummy500.game_actions (game_id, round_id, actor_user_id, action_type, payload)
    values (
      p_game_id,
      current_round.id,
      current_user_id,
      'draw_discard_top',
      jsonb_build_object('card', drawn_card)
    );

    return jsonb_build_object(
      'action', 'draw_discard_top',
      'card', drawn_card,
      'discard_count', jsonb_array_length(next_discard_pile)
    );
  end if;

  if normalized_action = 'discard_card' then
    if current_hand_count <> cards_per_player + 1 then
      raise exception 'You must draw before discarding';
    end if;

    if p_card_id is null or length(trim(p_card_id)) = 0 then
      raise exception 'card_id is required when discarding';
    end if;

    select ordinality
    into target_card_ordinality
    from jsonb_array_elements(current_hand) with ordinality as hand_card(value, ordinality)
    where value ->> 'id' = p_card_id
    limit 1;

    if target_card_ordinality is null then
      raise exception 'Selected card is not in the current hand';
    end if;

    discarded_card := current_hand -> (target_card_ordinality - 1);

    select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
    into next_hand
    from jsonb_array_elements(current_hand) with ordinality as hand_card(value, ordinality)
    where ordinality <> target_card_ordinality;

    next_discard_pile := current_round.discard_pile || jsonb_build_array(discarded_card);

    select gp.seat_index
    into current_seat_index
    from rummy500.game_players gp
    where gp.game_id = p_game_id
      and gp.user_id = current_user_id;

    select gp.user_id
    into next_turn_user_id
    from rummy500.game_players gp
    where gp.game_id = p_game_id
      and gp.seat_index > current_seat_index
    order by gp.seat_index asc
    limit 1;

    if next_turn_user_id is null then
      select gp.user_id
      into next_turn_user_id
      from rummy500.game_players gp
      where gp.game_id = p_game_id
      order by gp.seat_index asc
      limit 1;
    end if;

    update rummy500.player_hands
    set cards = next_hand
    where round_id = current_round.id
      and user_id = current_user_id;

    event_payload := jsonb_build_object(
      'type', 'discard_card',
      'actor_user_id', current_user_id,
      'at', timezone('utc', now()),
      'card', discarded_card,
      'next_turn_user_id', next_turn_user_id
    );

    update rummy500.game_rounds
    set discard_pile = next_discard_pile,
        action_log = action_log || jsonb_build_array(event_payload)
    where id = current_round.id;

    update rummy500.games
    set turn_user_id = next_turn_user_id
    where id = p_game_id;

    insert into rummy500.game_actions (game_id, round_id, actor_user_id, action_type, payload)
    values (
      p_game_id,
      current_round.id,
      current_user_id,
      'discard_card',
      jsonb_build_object(
        'card', discarded_card,
        'next_turn_user_id', next_turn_user_id
      )
    );

    return jsonb_build_object(
      'action', 'discard_card',
      'card', discarded_card,
      'turn_user_id', next_turn_user_id,
      'discard_count', jsonb_array_length(next_discard_pile)
    );
  end if;

  raise exception 'Unsupported action: %', normalized_action;
end;
$$;

grant execute on function rummy500.play_turn_action(uuid, text, text) to authenticated, service_role;
