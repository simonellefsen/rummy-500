alter table rummy500.games
add column if not exists required_pickup_card_id text;

create or replace function rummy500.finish_hand(
  p_game_id uuid,
  p_round_id uuid,
  p_winner_user_id uuid,
  p_finish_reason text default 'go_out'
)
returns jsonb
language plpgsql
security definer
set search_path = rummy500, public
as $$
declare
  current_game rummy500.games%rowtype;
  current_round rummy500.game_rounds%rowtype;
  player_record record;
  deadwood_score integer;
  final_hand_score integer;
  score_summary jsonb := '[]'::jsonb;
  finish_timestamp timestamptz := timezone('utc', now());
  target_score integer;
  match_finished boolean := false;
  match_winner_user_id uuid := null;
begin
  select *
  into current_game
  from rummy500.games
  where id = p_game_id
  for update;

  if not found then
    raise exception 'Game not found';
  end if;

  target_score := coalesce((current_game.config ->> 'target_score')::integer, 500);

  select *
  into current_round
  from rummy500.game_rounds
  where id = p_round_id
    and game_id = p_game_id
  for update;

  if not found then
    raise exception 'Round not found';
  end if;

  if current_round.status <> 'active' then
    return jsonb_build_object(
      'winner_user_id', current_game.winner_user_id,
      'round_id', current_round.id,
      'status', current_round.status
    );
  end if;

  for player_record in
    select gp.user_id,
           gp.current_hand_score,
           coalesce(ph.cards, '[]'::jsonb) as cards
    from rummy500.game_players gp
    left join rummy500.player_hands ph
      on ph.round_id = p_round_id
     and ph.user_id = gp.user_id
    where gp.game_id = p_game_id
    order by gp.seat_index asc
  loop
    deadwood_score := rummy500.score_cards_jsonb(player_record.cards);
    final_hand_score := coalesce(player_record.current_hand_score, 0) - deadwood_score;

    update rummy500.game_players
    set current_hand_score = final_hand_score,
        total_score = total_score + final_hand_score
    where game_id = p_game_id
      and user_id = player_record.user_id;

    score_summary := score_summary || jsonb_build_array(
      jsonb_build_object(
        'user_id', player_record.user_id,
        'deadwood_score', deadwood_score,
        'hand_score', final_hand_score
      )
    );
  end loop;

  select gp.user_id
  into match_winner_user_id
  from rummy500.game_players gp
  where gp.game_id = p_game_id
  order by gp.total_score desc, gp.seat_index asc
  limit 1;

  select exists (
    select 1
    from rummy500.game_players gp
    where gp.game_id = p_game_id
      and gp.total_score >= target_score
  )
  into match_finished;

  update rummy500.game_rounds
  set status = 'finished',
      finished_at = finish_timestamp,
      action_log = action_log || jsonb_build_array(
        jsonb_build_object(
          'type', 'finish_hand',
          'actor_user_id', p_winner_user_id,
          'winner_user_id', p_winner_user_id,
          'reason', p_finish_reason,
          'at', finish_timestamp,
          'scores', score_summary,
          'match_finished', match_finished
        )
      )
  where id = p_round_id;

  update rummy500.games
  set status = case
        when match_finished then 'finished'::rummy500.game_status
        else 'lobby'::rummy500.game_status
      end,
      winner_user_id = case when match_finished then match_winner_user_id else p_winner_user_id end,
      finished_at = case when match_finished then finish_timestamp else null end,
      turn_user_id = null,
      turn_stage = 'awaiting_draw',
      required_pickup_card_id = null
  where id = p_game_id;

  insert into rummy500.game_actions (game_id, round_id, actor_user_id, action_type, payload)
  values (
    p_game_id,
    p_round_id,
    p_winner_user_id,
    'finish_hand',
    jsonb_build_object(
      'winner_user_id', p_winner_user_id,
      'reason', p_finish_reason,
      'scores', score_summary,
      'match_finished', match_finished,
      'match_winner_user_id', case when match_finished then match_winner_user_id else null end,
      'target_score', target_score
    )
  );

  return jsonb_build_object(
    'winner_user_id', p_winner_user_id,
    'round_id', p_round_id,
    'scores', score_summary,
    'reason', p_finish_reason,
    'match_finished', match_finished,
    'match_winner_user_id', case when match_finished then match_winner_user_id else null end,
    'target_score', target_score
  );
end;
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
  hand_result jsonb;
  visible_discard_pile boolean := false;
  taken_cards jsonb := '[]'::jsonb;
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

  visible_discard_pile := coalesce((current_game.config -> 'variants' ->> 'visibleDiscardPile')::boolean, false);

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
    if current_game.turn_stage <> 'awaiting_draw' then
      raise exception 'You must finish your current turn before drawing again';
    end if;

    if current_hand_count > cards_per_player then
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

    update rummy500.games
    set turn_stage = 'awaiting_discard',
        required_pickup_card_id = null
    where id = p_game_id;

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
      'stock_count', jsonb_array_length(next_stock_pile),
      'turn_stage', 'awaiting_discard'
    );
  end if;

  if normalized_action = 'draw_discard_top' then
    if current_game.turn_stage <> 'awaiting_draw' then
      raise exception 'You must finish your current turn before drawing again';
    end if;

    if current_hand_count > cards_per_player then
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

    update rummy500.games
    set turn_stage = 'awaiting_discard',
        required_pickup_card_id = drawn_card ->> 'id'
    where id = p_game_id;

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
      'discard_count', jsonb_array_length(next_discard_pile),
      'turn_stage', 'awaiting_discard'
    );
  end if;

  if normalized_action = 'draw_discard_stack' then
    if not visible_discard_pile then
      raise exception 'This table only allows taking the top discard';
    end if;

    if current_game.turn_stage <> 'awaiting_draw' then
      raise exception 'You must finish your current turn before drawing again';
    end if;

    if current_hand_count > cards_per_player then
      raise exception 'You must discard before drawing again';
    end if;

    if p_card_id is null or length(trim(p_card_id)) = 0 then
      raise exception 'card_id is required when drawing from the discard pile';
    end if;

    select ordinality
    into target_card_ordinality
    from jsonb_array_elements(current_round.discard_pile) with ordinality as discard(value, ordinality)
    where value ->> 'id' = p_card_id
    limit 1;

    if target_card_ordinality is null then
      raise exception 'Selected discard card was not found';
    end if;

    select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
    into taken_cards
    from jsonb_array_elements(current_round.discard_pile) with ordinality as discard(value, ordinality)
    where ordinality >= target_card_ordinality;

    select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
    into next_discard_pile
    from jsonb_array_elements(current_round.discard_pile) with ordinality as discard(value, ordinality)
    where ordinality < target_card_ordinality;

    next_hand := current_hand || taken_cards;

    update rummy500.player_hands
    set cards = next_hand
    where round_id = current_round.id
      and user_id = current_user_id;

    event_payload := jsonb_build_object(
      'type', 'draw_discard_stack',
      'actor_user_id', current_user_id,
      'at', timezone('utc', now()),
      'card_id', p_card_id,
      'taken_count', jsonb_array_length(taken_cards)
    );

    update rummy500.game_rounds
    set discard_pile = next_discard_pile,
        action_log = action_log || jsonb_build_array(event_payload)
    where id = current_round.id;

    update rummy500.games
    set turn_stage = 'awaiting_discard',
        required_pickup_card_id = p_card_id
    where id = p_game_id;

    insert into rummy500.game_actions (game_id, round_id, actor_user_id, action_type, payload)
    values (
      p_game_id,
      current_round.id,
      current_user_id,
      'draw_discard_stack',
      jsonb_build_object(
        'card_id', p_card_id,
        'taken_count', jsonb_array_length(taken_cards)
      )
    );

    return jsonb_build_object(
      'action', 'draw_discard_stack',
      'card_id', p_card_id,
      'taken_count', jsonb_array_length(taken_cards),
      'discard_count', jsonb_array_length(next_discard_pile),
      'turn_stage', 'awaiting_discard'
    );
  end if;

  if normalized_action = 'discard_card' then
    if current_game.turn_stage <> 'awaiting_discard' then
      raise exception 'You must draw before discarding';
    end if;

    if current_hand_count = 0 then
      raise exception 'There are no cards left to discard';
    end if;

    if current_game.required_pickup_card_id is not null
       and exists (
         select 1
         from jsonb_array_elements(current_hand) as hand_card(value)
         where value ->> 'id' = current_game.required_pickup_card_id
       ) then
      raise exception 'You must use the picked discard in a meld or layoff before discarding';
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

    update rummy500.player_hands
    set cards = next_hand
    where round_id = current_round.id
      and user_id = current_user_id;

    event_payload := jsonb_build_object(
      'type', 'discard_card',
      'actor_user_id', current_user_id,
      'at', timezone('utc', now()),
      'card', discarded_card
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
      'discard_card',
      jsonb_build_object('card', discarded_card)
    );

    if jsonb_array_length(next_hand) = 0 then
      hand_result := rummy500.finish_hand(p_game_id, current_round.id, current_user_id, 'discard_go_out');

      return jsonb_build_object(
        'action', 'discard_card',
        'card', discarded_card,
        'hand_finished', true,
        'winner_user_id', current_user_id,
        'result', hand_result
      );
    end if;

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

    update rummy500.games
    set turn_user_id = next_turn_user_id,
        turn_stage = 'awaiting_draw',
        required_pickup_card_id = null
    where id = p_game_id;

    return jsonb_build_object(
      'action', 'discard_card',
      'card', discarded_card,
      'turn_user_id', next_turn_user_id,
      'discard_count', jsonb_array_length(next_discard_pile),
      'turn_stage', 'awaiting_draw'
    );
  end if;

  raise exception 'Unsupported action: %', normalized_action;
end;
$$;
