import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders } from "../_shared/cors.ts";
import { analyzeMeld, getMeldBindingOptions, type Card, type JokerBinding } from "../_shared/rummy.ts";

type TableMeld = {
  owner_user_id: string;
  type: "set" | "run";
  cards: Card[];
  points: number;
  created_at: string;
  joker_bindings?: JokerBinding[];
};

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

    const body = (await request.json()) as { gameId?: string; cardIds?: string[]; jokerBindings?: JokerBinding[] };

    if (!body.gameId) {
      return Response.json({ error: "gameId is required." }, { status: 400, headers: corsHeaders });
    }

    if (!Array.isArray(body.cardIds) || body.cardIds.length < 3) {
      return Response.json({ error: "cardIds must contain at least three cards." }, { status: 400, headers: corsHeaders });
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
      return Response.json({ error: "You must draw before placing a meld." }, { status: 409, headers: corsHeaders });
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
    const selectedIds = [...new Set(body.cardIds)];
    const selectedCards = cards.filter((card) => selectedIds.includes(card.id));
    const requiredPickupCardId =
      typeof game.required_pickup_card_id === "string" && game.required_pickup_card_id.trim()
        ? game.required_pickup_card_id.trim()
        : null;

    if (selectedCards.length !== selectedIds.length) {
      return Response.json({ error: "One or more selected cards are not in the current hand." }, { status: 400, headers: corsHeaders });
    }

    if (requiredPickupCardId && !selectedIds.includes(requiredPickupCardId)) {
      return Response.json(
        { error: "You must use the picked discard in a meld or layoff before making any other play." },
        { status: 409, headers: corsHeaders }
      );
    }

    const meld = analyzeMeld(selectedCards);

    if (!meld.isValid || meld.kind === "invalid") {
      return Response.json({ error: meld.reason ?? "Invalid meld." }, { status: 400, headers: corsHeaders });
    }

    const jokerBindingOptions = getMeldBindingOptions(selectedCards, meld.kind);
    const submittedJokerBindings = Array.isArray(body.jokerBindings) ? body.jokerBindings : [];
    let resolvedJokerBindings: JokerBinding[] = jokerBindingOptions[0] ?? [];

    if (jokerBindingOptions.length > 1) {
      if (submittedJokerBindings.length === 0) {
        return Response.json(
          { error: "This joker meld is ambiguous. Choose what each joker represents before playing it." },
          { status: 409, headers: corsHeaders }
        );
      }

      const submittedKey = normalizeJokerBindings(submittedJokerBindings);
      const matchingOption = jokerBindingOptions.find((option) => normalizeJokerBindings(option) === submittedKey);

      if (!matchingOption) {
        return Response.json(
          { error: "Submitted joker declaration is not valid for this meld." },
          { status: 409, headers: corsHeaders }
        );
      }

      resolvedJokerBindings = matchingOption;
    } else if (submittedJokerBindings.length > 0) {
      resolvedJokerBindings = submittedJokerBindings;
    }

    const nextHand = cards.filter((card) => !selectedIds.includes(card.id));
    const mustDiscardToGoOut =
      typeof game.config?.variants?.mustDiscardToGoOut === "boolean" ? game.config.variants.mustDiscardToGoOut : true;

    if (nextHand.length === 0 && mustDiscardToGoOut) {
      return Response.json(
        { error: "This table requires a final discard to go out. Keep one card to discard." },
        { status: 409, headers: corsHeaders }
      );
    }

    const nextTableMelds = [
      ...(((round.table_melds ?? []) as TableMeld[]) || []),
      {
        owner_user_id: user.id,
        type: meld.kind,
        cards: selectedCards,
        points: meld.points,
        created_at: new Date().toISOString(),
        joker_bindings: resolvedJokerBindings
      }
    ];
    const nextActionLog = [
      ...(((round.action_log ?? []) as Record<string, unknown>[]) || []),
      {
        type: "play_meld",
        actor_user_id: user.id,
        meld_type: meld.kind,
        cards: selectedCards,
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
        current_hand_score: (typeof playerRow?.current_hand_score === "number" ? playerRow.current_hand_score : 0) + meld.points
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
      action_type: "play_meld",
      payload: {
        type: meld.kind,
        points: meld.points,
        cards: selectedCards,
        joker_bindings: resolvedJokerBindings
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
        p_finish_reason: "meld_go_out"
      });

      if (finishError) {
        throw finishError;
      }

      return Response.json(
        {
          meldType: meld.kind,
          points: meld.points,
          remainingHandCount: nextHand.length,
          handFinished: true,
          result: finishData
        },
        { headers: corsHeaders }
      );
    }

    return Response.json(
      {
        meldType: meld.kind,
        points: meld.points,
        remainingHandCount: nextHand.length
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ error: message }, { status: 500, headers: corsHeaders });
  }
});

function normalizeJokerBindings(bindings: JokerBinding[]) {
  return bindings
    .map((binding) => `${binding.joker_id}:${binding.rank}:${binding.suit}`)
    .sort()
    .join("|");
}
