create or replace function rummy500.score_card_jsonb(p_card jsonb)
returns integer
language plpgsql
immutable
as $$
declare
  card_rank text := upper(coalesce(p_card ->> 'rank', ''));
  is_joker boolean := coalesce((p_card ->> 'isJoker')::boolean, false);
begin
  if is_joker or card_rank = 'A' then
    return 15;
  end if;

  if card_rank in ('J', 'Q', 'K') then
    return 10;
  end if;

  return coalesce(nullif(card_rank, '')::integer, 0);
exception
  when invalid_text_representation then
    return 0;
end;
$$;

create or replace function rummy500.score_cards_jsonb(p_cards jsonb)
returns integer
language sql
immutable
as $$
  select coalesce(sum(rummy500.score_card_jsonb(value)), 0)::integer
  from jsonb_array_elements(coalesce(p_cards, '[]'::jsonb)) as cards(value);
$$;

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
begin
  select *
  into current_game
  from rummy500.games
  where id = p_game_id
  for update;

  if not found then
    raise exception 'Game not found';
  end if;

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
          'scores', score_summary
        )
      )
  where id = p_round_id;

  update rummy500.games
  set status = 'finished',
      winner_user_id = p_winner_user_id,
      finished_at = finish_timestamp,
      turn_user_id = null
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
      'scores', score_summary
    )
  );

  return jsonb_build_object(
    'winner_user_id', p_winner_user_id,
    'round_id', p_round_id,
    'scores', score_summary,
    'reason', p_finish_reason
  );
end;
$$;

grant execute on function rummy500.score_card_jsonb(jsonb) to authenticated, service_role;
grant execute on function rummy500.score_cards_jsonb(jsonb) to authenticated, service_role;
grant execute on function rummy500.finish_hand(uuid, uuid, uuid, text) to authenticated, service_role;
