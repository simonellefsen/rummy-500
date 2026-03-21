import { createClient } from "npm:@supabase/supabase-js@2";

import { corsHeaders } from "../_shared/cors.ts";

type Suit = "clubs" | "diamonds" | "hearts" | "spades";
type Rank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K" | "JOKER";

interface Card {
  id: string;
  deck: number;
  rank: Rank;
  suit: Suit | null;
  isJoker: boolean;
}

const suits: Suit[] = ["clubs", "diamonds", "hearts", "spades"];
const ranks: Exclude<Rank, "JOKER">[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function createDeck(decks: number, jokers: number): Card[] {
  const cards: Card[] = [];

  for (let deck = 1; deck <= decks; deck += 1) {
    for (const suit of suits) {
      for (const rank of ranks) {
        cards.push({
          id: `${deck}-${suit}-${rank}`,
          deck,
          rank,
          suit,
          isJoker: false
        });
      }
    }
  }

  for (let jokerIndex = 0; jokerIndex < jokers; jokerIndex += 1) {
    const deck = (jokerIndex % decks) + 1;
    cards.push({
      id: `${deck}-joker-${jokerIndex + 1}`,
      deck,
      rank: "JOKER",
      suit: null,
      isJoker: true
    });
  }

  return cards;
}

function shuffle(cards: Card[]): Card[] {
  const nextCards = [...cards];
  const randomBytes = crypto.getRandomValues(new Uint32Array(nextCards.length));

  for (let index = nextCards.length - 1; index > 0; index -= 1) {
    const swapIndex = randomBytes[index] % (index + 1);
    const current = nextCards[index];
    nextCards[index] = nextCards[swapIndex];
    nextCards[swapIndex] = current;
  }

  return nextCards;
}

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

    const body = (await request.json()) as { gameId?: string };

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
      .select("id, host_user_id, status, config, round_number, winner_user_id")
      .eq("id", body.gameId)
      .single();

    if (gameError || !game) {
      return Response.json({ error: "Game not found." }, { status: 404, headers: corsHeaders });
    }

    if (game.host_user_id !== user.id) {
      return Response.json({ error: "Only the host can start the game." }, { status: 403, headers: corsHeaders });
    }

    if (game.status !== "lobby") {
      return Response.json({ error: "Game has already started." }, { status: 409, headers: corsHeaders });
    }

    const { data: players, error: playersError } = await supabase
      .schema("rummy500")
      .from("game_players")
      .select("user_id, seat_index, ready")
      .eq("game_id", body.gameId)
      .order("seat_index", { ascending: true });

    if (playersError || !players || players.length < 2) {
      return Response.json(
        { error: "At least two players are required to start." },
        { status: 400, headers: corsHeaders }
      );
    }

    const playerCount = players.length;
    const existingVariants = typeof game.config?.variants === "object" && game.config.variants ? game.config.variants : {};
    const targetScore = typeof game.config?.target_score === "number" ? game.config.target_score : 500;
    const config = {
      decks: typeof game.config?.decks === "number" ? game.config.decks : playerCount >= 5 ? 2 : 1,
      jokers: typeof game.config?.jokers === "number" ? game.config.jokers : playerCount >= 5 ? 4 : 2,
      cardsPerPlayer:
        typeof game.config?.cardsPerPlayer === "number" ? game.config.cardsPerPlayer : playerCount === 2 ? 13 : 7
    };
    const resolvedConfig = {
      ...(typeof game.config === "object" && game.config ? game.config : {}),
      ...config,
      target_score: targetScore,
      variants: {
        aceCanBeLow: true,
        aceCanBeHigh: true,
        minimumInitialMeldPoints: 0,
        mustDiscardToGoOut:
          typeof existingVariants.mustDiscardToGoOut === "boolean" ? existingVariants.mustDiscardToGoOut : true,
        visibleDiscardPile:
          typeof existingVariants.visibleDiscardPile === "boolean" ? existingVariants.visibleDiscardPile : false,
        ...existingVariants
      }
    };

    const { data: previousRound } = await supabase
      .schema("rummy500")
      .from("game_rounds")
      .select("dealer_user_id")
      .eq("game_id", body.gameId)
      .eq("round_number", game.round_number)
      .maybeSingle();

    let dealer = players[0];

    if (previousRound?.dealer_user_id) {
      const previousDealerIndex = players.findIndex((player) => player.user_id === previousRound.dealer_user_id);

      if (previousDealerIndex >= 0) {
        dealer = players[(previousDealerIndex + 1) % players.length];
      }
    }

    const dealerIndex = players.findIndex((player) => player.user_id === dealer.user_id);
    const firstTurn = players[(dealerIndex + 1) % players.length];

    const roundNumber = Number(game.round_number) + 1;
    const cards = shuffle(createDeck(config.decks, config.jokers));
    const hands: Record<string, Card[]> = {};
    const remainingCards = [...cards];

    for (const player of players) {
      hands[player.user_id] = [];
    }

    for (let cardIndex = 0; cardIndex < config.cardsPerPlayer; cardIndex += 1) {
      for (const player of players) {
        const nextCard = remainingCards.shift();

        if (!nextCard) {
          throw new Error("Deck exhausted while dealing.");
        }

        hands[player.user_id].push(nextCard);
      }
    }

    const firstDiscard = remainingCards.shift();

    if (!firstDiscard) {
      throw new Error("Deck exhausted before discard pile creation.");
    }

    const { data: round, error: roundError } = await supabase
      .schema("rummy500")
      .from("game_rounds")
      .insert({
        game_id: body.gameId,
        round_number: roundNumber,
        dealer_user_id: dealer.user_id,
        status: "active",
        stock_pile: remainingCards,
        stock_count: remainingCards.length,
        discard_pile: [firstDiscard],
        table_melds: [],
        action_log: [
          {
            type: "round_started",
            actor_user_id: user.id,
            at: new Date().toISOString()
          }
        ]
      })
      .select("id")
      .single();

    if (roundError || !round) {
      throw roundError ?? new Error("Failed to create game round.");
    }

    const handRows = players.map((player) => ({
      round_id: round.id,
      user_id: player.user_id,
      cards: hands[player.user_id]
    }));

    const { error: handsError } = await supabase.schema("rummy500").from("player_hands").insert(handRows);

    if (handsError) {
      throw handsError;
    }

    const { error: resetScoresError } = await supabase
      .schema("rummy500")
      .from("game_players")
      .update({ current_hand_score: 0 })
      .eq("game_id", body.gameId);

    if (resetScoresError) {
      throw resetScoresError;
    }

    const { error: updateGameError } = await supabase
      .schema("rummy500")
      .from("games")
      .update({
        status: "in_progress",
        config: resolvedConfig,
        round_number: roundNumber,
        winner_user_id: null,
        turn_user_id: firstTurn.user_id,
        turn_stage: "awaiting_draw",
        started_at: new Date().toISOString(),
        finished_at: null
      })
      .eq("id", body.gameId);

    if (updateGameError) {
      throw updateGameError;
    }

    const { error: actionError } = await supabase.schema("rummy500").from("game_actions").insert({
      game_id: body.gameId,
      round_id: round.id,
      actor_user_id: user.id,
      action_type: "start_game",
      payload: {
        round_number: roundNumber,
        stock_count: remainingCards.length,
        discard_top: firstDiscard
      }
    });

    if (actionError) {
      throw actionError;
    }

    return Response.json(
      {
        gameId: body.gameId,
        roundId: round.id,
        roundNumber,
        turnUserId: firstTurn.user_id,
        stockCount: remainingCards.length
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return Response.json({ error: message }, { status: 500, headers: corsHeaders });
  }
});
