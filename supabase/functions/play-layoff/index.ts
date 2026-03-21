import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders } from "../_shared/cors.ts";
import { analyzeLayoff, scoreCard, type Card, type TableMeld } from "../_shared/rummy.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing required Supabase Edge Function environment variables.");
    }

    const authHeader = request.headers.get("Authorization");

    if (!authHeader) {
      return Response.json({ error: "Missing authorization header." }, { status: 401, headers: corsHeaders });
    }

    const accessToken = authHeader.replace(/^Bearer\s+/iu, "").trim();

    if (!accessToken) {
      return Response.json({ error: "Invalid authorization header." }, { status: 401, headers: corsHeaders });
    }

    const body = (await request.json()) as { gameId?: string; cardId?: string; meldIndex?: number };

    if (!body.gameId) {
      return Response.json({ error: "gameId is required." }, { status: 400, headers: corsHeaders });
    }

    if (!body.cardId) {
      return Response.json({ error: "cardId is required." }, { status: 400, headers: corsHeaders });
    }

    if (!Number.isInteger(body.meldIndex) || body.meldIndex < 0) {
      return Response.json({ error: "meldIndex must be a non-negative integer." }, { status: 400, headers: corsHeaders });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
      return Response.json({ error: "Not authenticated." }, { status: 401, headers: corsHeaders });
    }

    const { data: game, error: gameError } = await supabase
      .schema("rummy500")
      .from("games")
      .select("id, status, turn_user_id, turn_stage, round_number, config, required_pickup_card_id")
      .eq("id", body.gameId)
      .single();

    if (gameError || !game) {
      return Response.json({ error: "Game not found." }, { status: 404, headers: corsHeaders });
    }

    if (game.status !== "in_progress") {
      return Response.json({ error: "Game is not currently in progress." }, { status: 409, headers: corsHeaders });
    }

    if (game.turn_user_id !== user.id) {
      return Response.json({ error: "It is not your turn." }, { status: 403, headers: corsHeaders });
    }

    if (game.turn_stage !== "awaiting_discard") {
      return Response.json({ error: "You must draw before laying off a card." }, { status: 409, headers: corsHeaders });
    }

    const { data: round, error: roundError } = await supabase
      .schema("rummy500")
      .from("game_rounds")
      .select("id, status, table_melds, action_log")
      .eq("game_id", body.gameId)
      .eq("round_number", game.round_number)
      .single();

    if (roundError || !round) {
      return Response.json({ error: "Active round not found." }, { status: 404, headers: corsHeaders });
    }

    if (round.status !== "active") {
      return Response.json({ error: "Round is not active." }, { status: 409, headers: corsHeaders });
    }

    const tableMelds = ((round.table_melds ?? []) as TableMeld[]) || [];
    const targetMeld = tableMelds[body.meldIndex];

    if (!targetMeld) {
      return Response.json({ error: "Target meld not found." }, { status: 404, headers: corsHeaders });
    }

    const { data: handRow, error: handError } = await supabase
      .schema("rummy500")
      .from("player_hands")
      .select("cards")
      .eq("round_id", round.id)
      .eq("user_id", user.id)
      .single();

    if (handError || !handRow) {
      return Response.json({ error: "Current player hand not found." }, { status: 404, headers: corsHeaders });
    }

    const cards = (handRow.cards ?? []) as Card[];
    const selectedCard = cards.find((card) => card.id === body.cardId);
    const requiredPickupCardId =
      typeof game.required_pickup_card_id === "string" && game.required_pickup_card_id.trim()
        ? game.required_pickup_card_id.trim()
        : null;

    if (!selectedCard) {
      return Response.json({ error: "Selected card is not in the current hand." }, { status: 400, headers: corsHeaders });
    }

    if (requiredPickupCardId && body.cardId !== requiredPickupCardId) {
      return Response.json(
        { error: "You must use the picked discard in a meld or layoff before making any other play." },
        { status: 409, headers: corsHeaders }
      );
    }

    const layoff = analyzeLayoff(targetMeld, selectedCard);

    if (!layoff.isValid || layoff.kind === "invalid") {
      return Response.json({ error: layoff.reason ?? "Invalid layoff." }, { status: 400, headers: corsHeaders });
    }

    const nextHand = cards.filter((card) => card.id !== body.cardId);
    const mustDiscardToGoOut =
      typeof game.config?.variants?.mustDiscardToGoOut === "boolean" ? game.config.variants.mustDiscardToGoOut : true;

    if (nextHand.length === 0 && mustDiscardToGoOut) {
      return Response.json(
        { error: "This table requires a final discard to go out. Keep one card to discard." },
        { status: 409, headers: corsHeaders }
      );
    }

    const nextTableMelds = [...tableMelds];
    nextTableMelds[body.meldIndex] = {
      ...targetMeld,
      type: layoff.kind,
      cards: [...(targetMeld.cards ?? []), selectedCard],
      points: layoff.points,
      card_owner_user_ids: {
        ...((targetMeld.card_owner_user_ids ?? {}) as Record<string, string>),
        [selectedCard.id]: user.id
      }
    };
    const nextActionLog = [
      ...(((round.action_log ?? []) as Record<string, unknown>[]) || []),
      {
        type: "lay_off",
        actor_user_id: user.id,
        meld_index: body.meldIndex,
        meld_type: layoff.kind,
        card: selectedCard,
        at: new Date().toISOString()
      }
    ];

    const { error: updateHandError } = await supabase
      .schema("rummy500")
      .from("player_hands")
      .update({ cards: nextHand })
      .eq("round_id", round.id)
      .eq("user_id", user.id);

    if (updateHandError) {
      throw updateHandError;
    }

    const { data: playerRow, error: playerError } = await supabase
      .schema("rummy500")
      .from("game_players")
      .select("current_hand_score")
      .eq("game_id", body.gameId)
      .eq("user_id", user.id)
      .single();

    if (playerError) {
      throw playerError;
    }

    const { error: scoreError } = await supabase
      .schema("rummy500")
      .from("game_players")
      .update({
        current_hand_score:
          (typeof playerRow?.current_hand_score === "number" ? playerRow.current_hand_score : 0) + scoreCard(selectedCard)
      })
      .eq("game_id", body.gameId)
      .eq("user_id", user.id);

    if (scoreError) {
      throw scoreError;
    }

    const { error: updateRoundError } = await supabase
      .schema("rummy500")
      .from("game_rounds")
      .update({
        table_melds: nextTableMelds,
        action_log: nextActionLog
      })
      .eq("id", round.id);

    if (updateRoundError) {
      throw updateRoundError;
    }

    if (requiredPickupCardId) {
      const { error: updateGameError } = await supabase
        .schema("rummy500")
        .from("games")
        .update({ required_pickup_card_id: null })
        .eq("id", body.gameId);

      if (updateGameError) {
        throw updateGameError;
      }
    }

    const { error: actionError } = await supabase.schema("rummy500").from("game_actions").insert({
      game_id: body.gameId,
      round_id: round.id,
      actor_user_id: user.id,
      action_type: "lay_off",
      payload: {
        meld_index: body.meldIndex,
        meld_type: layoff.kind,
        card: selectedCard,
        points: layoff.points
      }
    });

    if (actionError) {
      throw actionError;
    }

    if (nextHand.length === 0 && !mustDiscardToGoOut) {
      const { data: finishData, error: finishError } = await supabase.schema("rummy500").rpc("finish_hand", {
        p_game_id: body.gameId,
        p_round_id: round.id,
        p_winner_user_id: user.id,
        p_finish_reason: "layoff_go_out"
      });

      if (finishError) {
        throw finishError;
      }

      return Response.json(
        {
          meldIndex: body.meldIndex,
          meldType: layoff.kind,
          points: layoff.points,
          remainingHandCount: nextHand.length,
          handFinished: true,
          result: finishData
        },
        { headers: corsHeaders }
      );
    }

    return Response.json(
      {
        meldIndex: body.meldIndex,
        meldType: layoff.kind,
        points: layoff.points,
        remainingHandCount: nextHand.length
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ error: message }, { status: 500, headers: corsHeaders });
  }
});
