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
  set status = case when match_finished then 'finished' else 'lobby' end,
      winner_user_id = case when match_finished then match_winner_user_id else p_winner_user_id end,
      finished_at = case when match_finished then finish_timestamp else null end,
      turn_user_id = null,
      turn_stage = 'awaiting_draw'
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
