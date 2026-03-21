import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders } from "../_shared/cors.ts";
import { findDiscardPickupUses, type Card, type TableMeld } from "../_shared/rummy.ts";

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

    const body = (await request.json()) as { gameId?: string; cardId?: string | null };

    if (!body.gameId) {
      return Response.json({ error: "gameId is required." }, { status: 400, headers: corsHeaders });
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

    if (game.turn_stage !== "awaiting_draw") {
      return Response.json({ error: "You must finish your current turn before drawing again." }, { status: 409, headers: corsHeaders });
    }

    const { data: round, error: roundError } = await supabase
      .schema("rummy500")
      .from("game_rounds")
      .select("id, status, discard_pile, table_melds, action_log")
      .eq("game_id", body.gameId)
      .eq("round_number", game.round_number)
      .single();

    if (roundError || !round) {
      return Response.json({ error: "Active round not found." }, { status: 404, headers: corsHeaders });
    }

    if (round.status !== "active") {
      return Response.json({ error: "Round is not active." }, { status: 409, headers: corsHeaders });
    }

    const discardPile = ((round.discard_pile ?? []) as Card[]) || [];

    if (discardPile.length === 0) {
      return Response.json({ error: "The discard pile is empty." }, { status: 409, headers: corsHeaders });
    }

    const visibleDiscardPile =
      typeof game.config?.variants?.visibleDiscardPile === "boolean" ? game.config.variants.visibleDiscardPile : false;
    const selectedCardId = body.cardId?.trim() || null;
    const targetIndex = selectedCardId
      ? discardPile.findIndex((card) => card.id === selectedCardId)
      : discardPile.length - 1;

    if (targetIndex < 0) {
      return Response.json({ error: "Selected discard card was not found." }, { status: 404, headers: corsHeaders });
    }

    if (!visibleDiscardPile && targetIndex !== discardPile.length - 1) {
      return Response.json({ error: "This table only allows taking the top discard." }, { status: 409, headers: corsHeaders });
    }

    const takenCards = discardPile.slice(targetIndex);
    const chosenCard = discardPile[targetIndex];
    const nextDiscardPile = discardPile.slice(0, targetIndex);

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

    const hand = (handRow.cards ?? []) as Card[];
    const { count: playerCount = 0, error: playerCountError } = await supabase
      .schema("rummy500")
      .from("game_players")
      .select("user_id", { count: "exact", head: true })
      .eq("game_id", body.gameId);

    if (playerCountError) {
      throw playerCountError;
    }

    const cardsPerPlayer =
      typeof game.config?.cardsPerPlayer === "number" ? game.config.cardsPerPlayer : playerCount === 2 ? 13 : 7;

    if (hand.length > cardsPerPlayer) {
      return Response.json({ error: "You must discard before drawing again." }, { status: 409, headers: corsHeaders });
    }

    const nextHand = [...hand, ...takenCards];
    const immediateUseOptions = findDiscardPickupUses(nextHand, ((round.table_melds ?? []) as TableMeld[]) || [], chosenCard.id);

    if (immediateUseOptions.length === 0) {
      return Response.json(
        {
          error:
            "You can only take from the discard pile when the chosen card can be used immediately in a meld or layoff."
        },
        { status: 409, headers: corsHeaders }
      );
    }

    const actionType = selectedCardId && targetIndex !== discardPile.length - 1 ? "draw_discard_stack" : "draw_discard_top";
    const actionAt = new Date().toISOString();

    const { error: updateHandError } = await supabase
      .schema("rummy500")
      .from("player_hands")
      .update({ cards: nextHand })
      .eq("round_id", round.id)
      .eq("user_id", user.id);

    if (updateHandError) {
      throw updateHandError;
    }

    const nextActionLog = [
      ...((((round.action_log ?? []) as Record<string, unknown>[]) || [])),
      {
        type: actionType,
        actor_user_id: user.id,
        at: actionAt,
        card_id: chosenCard.id,
        taken_count: takenCards.length,
        requires_immediate_use: true
      }
    ];

    const { error: updateRoundError } = await supabase
      .schema("rummy500")
      .from("game_rounds")
      .update({
        discard_pile: nextDiscardPile,
        action_log: nextActionLog
      })
      .eq("id", round.id);

    if (updateRoundError) {
      throw updateRoundError;
    }

    const { error: updateGameError } = await supabase
      .schema("rummy500")
      .from("games")
      .update({
        turn_stage: "awaiting_discard",
        required_pickup_card_id: chosenCard.id
      })
      .eq("id", body.gameId);

    if (updateGameError) {
      throw updateGameError;
    }

    const { error: actionError } = await supabase.schema("rummy500").from("game_actions").insert({
      game_id: body.gameId,
      round_id: round.id,
      actor_user_id: user.id,
      action_type: actionType,
      payload: {
        card_id: chosenCard.id,
        taken_count: takenCards.length,
        requires_immediate_use: true
      }
    });

    if (actionError) {
      throw actionError;
    }

    return Response.json(
      {
        action: actionType,
        card: chosenCard,
        cardId: chosenCard.id,
        takenCount: takenCards.length,
        discardCount: nextDiscardPile.length,
        turnStage: "awaiting_discard",
        requiresImmediateUse: true,
        immediateUseOptions
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ error: message }, { status: 500, headers: corsHeaders });
  }
});
