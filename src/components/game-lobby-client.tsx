"use client";

import Link from "next/link";
import Script from "next/script";
import { useEffect, useState, useTransition } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { cardLabel } from "../lib/rummy/cards";
import { findSuggestedLayoffs, findSuggestedMelds } from "../lib/rummy/meld-options";
import type { Card, TableMeld } from "../lib/rummy/types";
import { createBrowserSupabaseClient } from "../lib/supabase/client";
import { getPublicSupabaseEnv } from "../lib/supabase/env";

interface GameRow {
  id: string;
  invite_code: string;
  status: string;
  host_user_id: string;
  turn_user_id: string | null;
  turn_stage: "awaiting_draw" | "awaiting_discard";
  round_number: number;
  config: Record<string, unknown>;
  started_at: string | null;
}

interface PlayerRow {
  user_id: string;
  seat_index: number;
  ready: boolean;
  total_score: number;
  current_hand_score: number;
}

interface RoundRow {
  id: string;
  round_number: number;
  status: string;
  stock_count: number;
  discard_pile: Card[];
  table_melds: TableMeld[];
}

interface ActionRow {
  id: number;
  actor_user_id: string;
  action_type: string;
  created_at: string;
  payload: Record<string, unknown>;
}

interface StartGameDiagnostics {
  capturedAt: string;
  sessionPresent: boolean;
  sessionUserId: string | null;
  getUserId: string | null;
  accessTokenPreview: string | null;
  accessTokenClaims: {
    sub?: string;
    role?: string;
    aud?: string | string[];
    iss?: string;
    exp?: number;
  } | null;
  functionRequest: {
    url: string;
    status: number | null;
    ok: boolean;
    body: string | null;
  };
}

const supabase = createBrowserSupabaseClient();
const { anonKey, url: supabaseUrl } = getPublicSupabaseEnv();
const CARDMEISTER_SUITS: Record<Exclude<Card["suit"], null>, string> = {
  clubs: "c",
  diamonds: "d",
  hearts: "h",
  spades: "s"
};
const RANK_ORDER: Record<Card["rank"], number> = {
  A: 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 11,
  Q: 12,
  K: 13,
  JOKER: 14
};
const SUIT_ORDER: Record<Exclude<Card["suit"], null>, number> = {
  clubs: 0,
  spades: 1,
  hearts: 2,
  diamonds: 3
};

function decodeJwtClaims(token: string) {
  try {
    const [, payload] = token.split(".");

    if (!payload) {
      return null;
    }

    const normalizedPayload = payload.replace(/-/gu, "+").replace(/_/gu, "/");
    const paddedPayload = normalizedPayload.padEnd(Math.ceil(normalizedPayload.length / 4) * 4, "=");
    const json = window.atob(paddedPayload);

    return JSON.parse(json) as StartGameDiagnostics["accessTokenClaims"];
  } catch {
    return null;
  }
}

function getTokenPreview(token: string) {
  if (token.length <= 24) {
    return token;
  }

  return `${token.slice(0, 12)}...${token.slice(-12)}`;
}

async function postEdgeFunction(functionName: string, body: Record<string, unknown>, accessToken: string) {
  const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: anonKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const rawBody = await response.text();
  let parsedBody: unknown = null;

  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody) as unknown;
    } catch {
      parsedBody = rawBody;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    body: parsedBody,
    rawBody
  };
}

function userLabel(userId: string, profiles: Record<string, string | null>, currentUser?: User | null) {
  const name = profiles[userId];

  if (name?.trim()) {
    return name.trim();
  }

  if (currentUser?.id === userId) {
    if (typeof currentUser.user_metadata?.display_name === "string" && currentUser.user_metadata.display_name.trim()) {
      return currentUser.user_metadata.display_name.trim();
    }

    return currentUser.email ?? `You (${userId.slice(0, 6)})`;
  }

  return `Player ${userId.slice(0, 6)}`;
}

function getSeatStyle(seatIndex: number, totalPlayers: number, currentSeatIndex: number) {
  const relativeSeat = ((seatIndex - currentSeatIndex) % totalPlayers + totalPlayers) % totalPlayers;
  const angle = Math.PI / 2 + (relativeSeat / totalPlayers) * Math.PI * 2;
  const x = 50 + Math.cos(angle) * 39;
  const y = 50 + Math.sin(angle) * 33;

  return {
    left: `${x}%`,
    top: `${y}%`
  };
}

function getCardmeisterCid(card: Card) {
  if (card.isJoker || !card.suit) {
    return null;
  }

  const rank =
    card.rank === "A" || card.rank === "J" || card.rank === "Q" || card.rank === "K"
      ? card.rank
      : card.rank === "10"
        ? "T"
        : card.rank;

  return `${rank}${CARDMEISTER_SUITS[card.suit]}`;
}

function PlayingCardFace({
  card,
  size,
  selected = false
}: {
  card: Card;
  size: "hand" | "mini" | "tiny";
  selected?: boolean;
}) {
  const cid = getCardmeisterCid(card);

  if (!cid) {
    return (
      <div className={`cardmeister-shell ${size} ${selected ? "is-selected" : ""}`}>
        <div className="joker-card-face">
          <span>JOKER</span>
          <small>Wild</small>
        </div>
      </div>
    );
  }

  return (
    <div className={`cardmeister-shell ${size} ${selected ? "is-selected" : ""}`}>
      <playing-card cid={cid} bordercolor="#cabf9d" borderradius="14" borderline="1" opacity="1"></playing-card>
    </div>
  );
}

function StockCardBack() {
  return (
    <div className="cardmeister-shell mini">
      <playing-card
        rank="0"
        backcolor="#1848a6"
        backtext="500"
        backtextcolor="#f5f2ea"
        bordercolor="#cabf9d"
        borderradius="14"
        borderline="1"
      ></playing-card>
    </div>
  );
}

function sortHandCards(hand: Card[], mode: "natural" | "rank" | "suit") {
  if (mode === "natural") {
    return hand;
  }

  return [...hand].sort((left, right) => {
    if (mode === "rank") {
      const rankDelta = RANK_ORDER[left.rank] - RANK_ORDER[right.rank];

      if (rankDelta !== 0) {
        return rankDelta;
      }

      return (SUIT_ORDER[left.suit ?? "clubs"] ?? 99) - (SUIT_ORDER[right.suit ?? "clubs"] ?? 99);
    }

    const suitDelta = (SUIT_ORDER[left.suit ?? "clubs"] ?? 99) - (SUIT_ORDER[right.suit ?? "clubs"] ?? 99);

    if (suitDelta !== 0) {
      return suitDelta;
    }

    return RANK_ORDER[left.rank] - RANK_ORDER[right.rank];
  });
}

export function GameLobbyClient({ gameId }: { gameId: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [game, setGame] = useState<GameRow | null>(null);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, string | null>>({});
  const [round, setRound] = useState<RoundRow | null>(null);
  const [hand, setHand] = useState<Card[]>([]);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [startGameDiagnostics, setStartGameDiagnostics] = useState<StartGameDiagnostics | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [handSortMode, setHandSortMode] = useState<"natural" | "rank" | "suit">("rank");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let isActive = true;

    async function loadSession() {
      const {
        data: { session: nextSession }
      } = await supabase.auth.getSession();

      if (!isActive) {
        return;
      }

      setSession(nextSession);
      setLoading(false);

      if (nextSession?.user) {
        void refreshState(nextSession.user.id);
      }
    }

    async function refreshState(currentUserId: string) {
      try {
        const [{ data: gameData, error: gameError }, { data: playersData, error: playersError }, { data: actionsData, error: actionsError }] =
          await Promise.all([
            supabase
              .schema("rummy500")
              .from("games")
              .select("id, invite_code, status, host_user_id, turn_user_id, turn_stage, round_number, config, started_at")
              .eq("id", gameId)
              .single(),
            supabase
              .schema("rummy500")
              .from("game_players")
              .select("user_id, seat_index, ready, total_score, current_hand_score")
              .eq("game_id", gameId)
              .order("seat_index", { ascending: true }),
            supabase
              .schema("rummy500")
              .from("game_actions")
              .select("id, actor_user_id, action_type, created_at, payload")
              .eq("game_id", gameId)
              .order("created_at", { ascending: false })
              .limit(8)
          ]);

        if (gameError) {
          throw gameError;
        }

        if (playersError) {
          throw playersError;
        }

        if (actionsError) {
          throw actionsError;
        }

        const profileIds = (playersData ?? []).map((player) => player.user_id);
        const { data: profileRows, error: profileError } = await supabase
          .schema("rummy500")
          .from("profiles")
          .select("user_id, display_name")
          .in("user_id", profileIds);

        if (profileError) {
          throw profileError;
        }

        const nextProfiles = Object.fromEntries(
          (profileRows ?? []).map((profile) => [profile.user_id, profile.display_name])
        );

        const { data: roundData, error: roundError } = await supabase
          .schema("rummy500")
          .from("game_rounds")
          .select("id, round_number, status, stock_count, discard_pile, table_melds")
          .eq("game_id", gameId)
          .order("round_number", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (roundError) {
          throw roundError;
        }

        let nextHand: Card[] = [];

        if (roundData) {
          const { data: handRow, error: handError } = await supabase
            .schema("rummy500")
            .from("player_hands")
            .select("cards")
            .eq("round_id", roundData.id)
            .eq("user_id", currentUserId)
            .maybeSingle();

          if (handError) {
            throw handError;
          }

          nextHand = (handRow?.cards ?? []) as Card[];
        }

        if (!isActive) {
          return;
        }

        setGame(gameData);
        setPlayers(playersData ?? []);
        setProfiles(nextProfiles);
        setRound((roundData as RoundRow | null) ?? null);
        setHand(nextHand);
        setActions((actionsData as ActionRow[] | null) ?? []);
      } catch (error) {
        if (!isActive) {
          return;
        }

        setErrorMessage(error instanceof Error ? error.message : "Failed to load lobby.");
      }
    }

    void loadSession();

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!isActive) {
        return;
      }

      setSession(nextSession);
      setLoading(false);

      if (!nextSession) {
        setGame(null);
        setPlayers([]);
        setProfiles({});
        setRound(null);
        setHand([]);
        setSelectedCardId(null);
        return;
      }

      startTransition(() => {
        void refreshState(nextSession.user.id);
      });
    });

    const pollId = window.setInterval(() => {
      const currentUserId = session?.user.id;

      if (!currentUserId) {
        return;
      }

      void refreshState(currentUserId);
    }, 5000);

    return () => {
      isActive = false;
      window.clearInterval(pollId);
      subscription.unsubscribe();
    };
  }, [gameId, session?.user.id]);

  async function refreshLobby() {
    const currentUserId = session?.user.id;

    if (!currentUserId) {
      return;
    }

    setErrorMessage(null);
    setStatusMessage(null);

    const [{ data: gameData, error: gameError }, { data: playersData, error: playersError }, { data: actionsData, error: actionsError }] =
      await Promise.all([
        supabase
          .schema("rummy500")
          .from("games")
          .select("id, invite_code, status, host_user_id, turn_user_id, turn_stage, round_number, config, started_at")
          .eq("id", gameId)
          .single(),
        supabase
          .schema("rummy500")
          .from("game_players")
          .select("user_id, seat_index, ready, total_score, current_hand_score")
          .eq("game_id", gameId)
          .order("seat_index", { ascending: true }),
        supabase
          .schema("rummy500")
          .from("game_actions")
          .select("id, actor_user_id, action_type, created_at, payload")
          .eq("game_id", gameId)
          .order("created_at", { ascending: false })
          .limit(8)
      ]);

    if (gameError) {
      setErrorMessage(gameError.message);
      return;
    }

    if (playersError) {
      setErrorMessage(playersError.message);
      return;
    }

    if (actionsError) {
      setErrorMessage(actionsError.message);
      return;
    }

    const profileIds = (playersData ?? []).map((player) => player.user_id);
    const { data: profileRows, error: profileError } = await supabase
      .schema("rummy500")
      .from("profiles")
      .select("user_id, display_name")
      .in("user_id", profileIds);

    if (profileError) {
      setErrorMessage(profileError.message);
      return;
    }

    const nextProfiles = Object.fromEntries((profileRows ?? []).map((profile) => [profile.user_id, profile.display_name]));

    const { data: roundData, error: roundError } = await supabase
      .schema("rummy500")
      .from("game_rounds")
      .select("id, round_number, status, stock_count, discard_pile, table_melds")
      .eq("game_id", gameId)
      .order("round_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (roundError) {
      setErrorMessage(roundError.message);
      return;
    }

    let nextHand: Card[] = [];

    if (roundData) {
      const { data: handRow, error: handError } = await supabase
        .schema("rummy500")
        .from("player_hands")
        .select("cards")
        .eq("round_id", roundData.id)
        .eq("user_id", currentUserId)
        .maybeSingle();

      if (handError) {
        setErrorMessage(handError.message);
        return;
      }

      nextHand = (handRow?.cards ?? []) as Card[];
    }

    setGame(gameData);
    setPlayers(playersData ?? []);
    setProfiles(nextProfiles);
    setRound((roundData as RoundRow | null) ?? null);
    setHand(nextHand);
    setSelectedCardId((currentSelectedCardId) =>
      nextHand.some((card) => card.id === currentSelectedCardId) ? currentSelectedCardId : null
    );
    setActions((actionsData as ActionRow[] | null) ?? []);
  }

  async function updateReady(nextReady: boolean) {
    setErrorMessage(null);
    setStatusMessage(null);

    const { error } = await supabase.schema("rummy500").rpc("set_player_ready", {
      p_game_id: gameId,
      p_ready: nextReady
    });

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    setStatusMessage(nextReady ? "Marked ready." : "Marked not ready.");
    await refreshLobby();
  }

  async function startGame() {
    setErrorMessage(null);
    setStatusMessage(null);
    setStartGameDiagnostics(null);

    const {
      data: { session: currentSession },
      error: sessionError
    } = await supabase.auth.getSession();

    if (sessionError) {
      setErrorMessage(sessionError.message);
      return;
    }

    if (!currentSession?.access_token) {
      setErrorMessage("No Supabase session token is available in the browser.");
      return;
    }

    const response = await postEdgeFunction("start-game", { gameId }, currentSession.access_token);

    if (!response.ok) {
      const message =
        typeof response.body === "object" && response.body && "message" in response.body
          ? String(response.body.message)
          : response.rawBody || `start-game failed with status ${response.status}`;

      setErrorMessage(message);
      return;
    }

    setStatusMessage("Game started.");
    await refreshLobby();
  }

  async function playTurnAction(action: "draw_stock" | "draw_discard_top" | "discard_card", cardId?: string) {
    setErrorMessage(null);
    setStatusMessage(null);

    const { error } = await supabase.schema("rummy500").rpc("play_turn_action", {
      p_game_id: gameId,
      p_action: action,
      p_card_id: cardId ?? null
    });

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    if (action === "draw_stock") {
      setStatusMessage("Drew from the stock pile.");
    } else if (action === "draw_discard_top") {
      setStatusMessage("Picked up the top discard.");
    } else {
      setStatusMessage("Discarded card and passed the turn.");
    }

    if (action === "discard_card") {
      setSelectedCardId(null);
    }

    await refreshLobby();
  }

  async function playSuggestedMeld(cardIds: string[]) {
    setErrorMessage(null);
    setStatusMessage(null);

    const {
      data: { session: currentSession },
      error: sessionError
    } = await supabase.auth.getSession();

    if (sessionError) {
      setErrorMessage(sessionError.message);
      return;
    }

    if (!currentSession?.access_token) {
      setErrorMessage("No Supabase session token is available in the browser.");
      return;
    }

    const response = await postEdgeFunction("play-meld", { gameId, cardIds }, currentSession.access_token);

    if (!response.ok) {
      const message =
        typeof response.body === "object" && response.body && "error" in response.body
          ? String(response.body.error)
          : response.rawBody || `play-meld failed with status ${response.status}`;

      setErrorMessage(message);
      return;
    }

    setSelectedCardId(null);
    setStatusMessage("Meld placed on the table.");
    await refreshLobby();
  }

  async function playLayoff(meldIndex: number, cardId: string) {
    setErrorMessage(null);
    setStatusMessage(null);

    const {
      data: { session: currentSession },
      error: sessionError
    } = await supabase.auth.getSession();

    if (sessionError) {
      setErrorMessage(sessionError.message);
      return;
    }

    if (!currentSession?.access_token) {
      setErrorMessage("No Supabase session token is available in the browser.");
      return;
    }

    const response = await postEdgeFunction("play-layoff", { gameId, cardId, meldIndex }, currentSession.access_token);

    if (!response.ok) {
      const message =
        typeof response.body === "object" && response.body && "error" in response.body
          ? String(response.body.error)
          : response.rawBody || `play-layoff failed with status ${response.status}`;

      setErrorMessage(message);
      return;
    }

    setSelectedCardId(null);
    setStatusMessage("Card laid off on an existing meld.");
    await refreshLobby();
  }

  async function runStartGameDiagnostics() {
    setErrorMessage(null);
    setStatusMessage(null);

    const [
      {
        data: { session: currentSession },
        error: sessionError
      },
      {
        data: { user: authenticatedUser },
        error: getUserError
      }
    ] = await Promise.all([supabase.auth.getSession(), supabase.auth.getUser()]);

    const accessToken = currentSession?.access_token ?? null;
    const functionRequest =
      accessToken === null
        ? {
            url: `${supabaseUrl}/functions/v1/start-game`,
            status: null,
            ok: false,
            body: sessionError?.message ?? getUserError?.message ?? "No access token available."
          }
        : await postEdgeFunction("start-game", { gameId }, accessToken)
            .then((result) => ({
              url: `${supabaseUrl}/functions/v1/start-game`,
              status: result.status,
              ok: result.ok,
              body: result.rawBody
            }))
            .catch((error: unknown) => ({
              url: `${supabaseUrl}/functions/v1/start-game`,
              status: null,
              ok: false,
              body: error instanceof Error ? error.message : "Unknown network error"
            }));

    setStartGameDiagnostics({
      capturedAt: new Date().toISOString(),
      sessionPresent: !!currentSession,
      sessionUserId: currentSession?.user.id ?? null,
      getUserId: authenticatedUser?.id ?? null,
      accessTokenPreview: accessToken ? getTokenPreview(accessToken) : null,
      accessTokenClaims: accessToken ? decodeJwtClaims(accessToken) : null,
      functionRequest
    });
  }

  async function copyCode() {
    if (!game?.invite_code) {
      return;
    }

    try {
      await navigator.clipboard.writeText(game.invite_code);
      setStatusMessage("Invite code copied.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to copy invite code.");
    }
  }

  async function shareInvite() {
    if (!game?.invite_code || typeof window === "undefined") {
      return;
    }

    const inviteUrl = `${window.location.origin}/games/${gameId}`;
    const shareData = {
      title: "Rummy 500",
      text: `Join my Rummy 500 lobby with code ${game.invite_code}`,
      url: inviteUrl
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
        setStatusMessage("Invite shared.");
        return;
      }

      await navigator.clipboard.writeText(`${shareData.text}\n${inviteUrl}`);
      setStatusMessage("Invite link copied.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to share invite.");
    }
  }

  const currentUser = session?.user ?? null;
  const currentPlayer = players.find((player) => player.user_id === currentUser?.id) ?? null;
  const otherPlayers = players.filter((player) => player.user_id !== currentUser?.id);
  const isCurrentTurn = !!currentUser && game?.turn_user_id === currentUser.id && round?.status === "active";
  const canDraw = isCurrentTurn && game?.turn_stage === "awaiting_draw";
  const canMeld = isCurrentTurn && game?.turn_stage === "awaiting_discard";
  const canDiscard = isCurrentTurn && game?.turn_stage === "awaiting_discard";
  const activeTurnLabel = game?.turn_user_id ? userLabel(game.turn_user_id, profiles, currentUser) : "Not started";
  const currentSeatIndex = currentPlayer?.seat_index ?? 0;
  const selectedCard = hand.find((card) => card.id === selectedCardId) ?? null;
  const sortedHand = sortHandCards(hand, handSortMode);
  const suggestedMelds = selectedCard ? findSuggestedMelds(hand, selectedCard.id) : [];
  const suggestedLayoffs = selectedCard ? findSuggestedLayoffs(round?.table_melds ?? [], selectedCard) : [];
  const tableSets = (round?.table_melds ?? []).filter((meld) => meld.type === "set");
  const tableRuns = (round?.table_melds ?? []).filter((meld) => meld.type === "run");
  const canStart =
    !!currentUser &&
    !!game &&
    game.status === "lobby" &&
    game.host_user_id === currentUser.id &&
    players.length >= 2;
  const showReadyOverlay = !!currentPlayer && game?.status === "lobby" && !currentPlayer.ready;
  const discardTop = round?.discard_pile?.at(-1) ?? null;
  const discardCount = round?.discard_pile?.length ?? 0;
  const mobileTopPlayer = otherPlayers[0] ?? null;
  const mobileLeftPlayer = otherPlayers[1] ?? null;
  const mobileRightPlayer = otherPlayers[2] ?? null;
  const mobilePrompt = statusMessage
    ? statusMessage
    : canDraw
      ? "It's your turn. Start by drawing a card from the stock or the discard pile."
      : canMeld
        ? selectedCard && suggestedMelds.length + suggestedLayoffs.length > 0
          ? suggestedLayoffs.length > 0
            ? "Selected card can be laid off on the table or used in a new meld."
            : "Selected card can form a meld. Play it or discard another card."
          : "It's your turn. Select a card to see meld options, or pick a card to discard."
        : `${activeTurnLabel} is up next.`;
  const desktopPrompt =
    canDraw
      ? "Your turn: draw from the stock or take the top discard."
      : canMeld
        ? selectedCard && suggestedMelds.length + suggestedLayoffs.length > 0
          ? suggestedLayoffs.length > 0
            ? "Selected card can be laid off on an existing meld or used in a new meld."
            : "Selected card can be melded. Play it or discard to end your turn."
          : "Your turn: select a card in your hand, then meld or discard."
        : `${activeTurnLabel} is up next.`;
  const primarySuggestedMeld = suggestedMelds[0] ?? null;
  const primarySuggestedLayoff = suggestedLayoffs[0] ?? null;

  return (
    <main className="page-shell">
      <Script src="/vendor/cardmeister/elements.cardmeister.min.js" strategy="afterInteractive" />
      <section className="hero-panel">
        <div className="hero-topline">
          <Link className="back-link" href="/">
            Back to dashboard
          </Link>
          <span className="stat-pill">{game?.status ?? "loading"}</span>
        </div>
        <h1>{game ? `Lobby ${game.invite_code}` : "Loading lobby"}</h1>
        <p className="hero-copy">
          Seat players and start the first hand from a server-authoritative Edge Function once at
          least two players have joined the lobby.
        </p>
      </section>

      {loading ? <p className="muted-copy">Checking session…</p> : null}
      {statusMessage ? <p className="banner banner-success">{statusMessage}</p> : null}
      {errorMessage ? <p className="banner banner-error">{errorMessage}</p> : null}
      {currentUser && game?.status === "in_progress" ? (
        <p className={`banner ${isCurrentTurn ? "banner-success" : ""}`}>
          {isCurrentTurn
            ? canDraw
              ? "Your turn. Draw from the stock pile or take the top discard."
              : "Your turn. Lay down a set or run, or discard to end it."
            : `${activeTurnLabel} is up next.`}
        </p>
      ) : null}

      {!currentUser ? (
        <section className="panel">
          <h2>Authentication required</h2>
          <p className="muted-copy">Return to the homepage and sign in before opening a lobby.</p>
        </section>
      ) : (
        <>
          {showReadyOverlay ? (
            <div className="ready-overlay" role="presentation">
              <section
                aria-labelledby="ready-overlay-title"
                aria-modal="true"
                className="ready-overlay-card"
                role="dialog"
              >
                <p className="eyebrow">You joined the lobby</p>
                <h2 id="ready-overlay-title">
                  {game?.invite_code ? `Lobby ${game.invite_code}` : "Ready to play?"}
                </h2>
                <p className="ready-overlay-copy">
                  Mark yourself ready so the host can see you are present. The host can still start the
                  hand once at least two players are seated.
                </p>
                <div className="ready-overlay-meta">
                  <span>{players.length} seated</span>
                  <span>Host: {game ? userLabel(game.host_user_id, profiles, currentUser) : "Unknown"}</span>
                </div>
                <div className="ready-overlay-actions">
                  <button
                    className="button button-google"
                    onClick={() => startTransition(() => void updateReady(true))}
                    type="button"
                  >
                    Mark ready
                  </button>
                  <button
                    className="button button-ghost"
                    onClick={() => startTransition(() => void copyCode())}
                    type="button"
                  >
                    Copy code
                  </button>
                  {game?.host_user_id === currentUser.id ? (
                    <button
                      className="button button-secondary"
                      disabled={!canStart || isPending}
                      onClick={() => startTransition(() => void startGame())}
                      type="button"
                    >
                      Start hand
                    </button>
                  ) : null}
                </div>
              </section>
            </div>
          ) : null}

          <section className="table-layout-shell desktop-only">
            <aside className="panel table-sidebar">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Lobby controls</p>
                  <h2>Match controls</h2>
                </div>
                <button className="button button-ghost" onClick={() => startTransition(() => void refreshLobby())} type="button">
                  Refresh
                </button>
              </div>

              <div className="toolbar">
                <button className="button button-secondary" onClick={() => startTransition(() => void copyCode())} type="button">
                  Copy invite code
                </button>
                {currentPlayer ? (
                  <button
                    className="button"
                    onClick={() => startTransition(() => void updateReady(!currentPlayer.ready))}
                    type="button"
                  >
                    {currentPlayer.ready ? "Mark not ready" : "Mark ready"}
                  </button>
                ) : null}
                {game?.host_user_id === currentUser.id ? (
                  <button
                    className="button button-google"
                    disabled={!canStart || isPending}
                    onClick={() => startTransition(() => void startGame())}
                    type="button"
                  >
                    Start game
                  </button>
                ) : null}
              </div>

              <div className="meta-stack">
                <p>
                  <strong>Host:</strong> {game ? userLabel(game.host_user_id, profiles, currentUser) : "Unknown"}
                </p>
                <p>
                  <strong>Invite:</strong> {game?.invite_code ?? "----"}
                </p>
                <p>
                  <strong>Turn:</strong> {activeTurnLabel}
                </p>
                <p>
                  <strong>Round:</strong> {game?.round_number ?? 0}
                </p>
              </div>

              <div className="stack">
                <div className="selection-panel">
                  <p className="eyebrow">Selected card</p>
                  <h3>{selectedCard ? cardLabel(selectedCard) : "Choose a card from your hand"}</h3>
                  {!selectedCard ? (
                        <p className="muted-copy">Selecting a card reveals possible plays for sets, runs, or discard.</p>
                  ) : (
                    <>
                      {suggestedMelds.length > 0 || suggestedLayoffs.length > 0 ? (
                        <div className="suggestion-list">
                          {suggestedMelds.map((suggestion) => (
                            <div className="suggestion-card" key={`${selectedCard.id}-${suggestion.kind}`}>
                              <strong>{suggestion.kind === "set" ? "Possible set" : "Possible run"}</strong>
                              <p>{suggestion.cards.map((card) => cardLabel(card)).join(" · ")}</p>
                              {canMeld ? (
                                <button
                                  className="button button-secondary"
                                  onClick={() => startTransition(() => void playSuggestedMeld(suggestion.cards.map((card) => card.id)))}
                                  type="button"
                                >
                                  Play {suggestion.kind}
                                </button>
                              ) : null}
                            </div>
                          ))}
                          {suggestedLayoffs.map((suggestion) => (
                            <div className="suggestion-card" key={`${selectedCard.id}-layoff-${suggestion.meldIndex}`}>
                              <strong>{suggestion.kind === "set" ? "Lay off on set" : "Lay off on run"}</strong>
                              <p>{suggestion.targetCards.map((card) => cardLabel(card)).join(" · ")}</p>
                              {canMeld ? (
                                <button
                                  className="button button-secondary"
                                  onClick={() => startTransition(() => void playLayoff(suggestion.meldIndex, suggestion.card.id))}
                                  type="button"
                                >
                                  Lay off card
                                </button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="muted-copy">No meld or layoff found for this card yet.</p>
                      )}
                      {canDiscard ? (
                        <button
                          className="button"
                          onClick={() => startTransition(() => void playTurnAction("discard_card", selectedCard.id))}
                          type="button"
                        >
                          Discard selected card
                        </button>
                      ) : null}
                    </>
                  )}
                </div>

                <details className="diagnostics-panel">
                  <summary>Auth diagnostics</summary>
                  <div className="stack">
                    <p className="muted-copy">
                      Capture the live browser session and call <code>start-game</code> directly with
                      the current bearer token.
                    </p>
                    <button
                      className="button button-ghost"
                      disabled={isPending}
                      onClick={() => startTransition(() => void runStartGameDiagnostics())}
                      type="button"
                    >
                      Run diagnostics
                    </button>
                    {startGameDiagnostics ? (
                      <pre className="diagnostics-output">
                        {JSON.stringify(startGameDiagnostics, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                </details>
              </div>
            </aside>

            <section className="game-table-panel">
              {!round ? (
                <div className="panel empty-state">
                  <p>No round has started yet.</p>
                  <span>The start-game Edge Function will deal hands and create the opening discard.</span>
                </div>
              ) : (
                <div className="game-table-surface">
                  <div className="table-felt">
                    {players.map((player) => (
                      <div
                        className={`table-seat ${game?.turn_user_id === player.user_id ? "is-active" : ""} ${
                          currentUser?.id === player.user_id ? "is-self" : ""
                        }`}
                        key={player.user_id}
                        style={getSeatStyle(player.seat_index, Math.max(players.length, 1), currentSeatIndex)}
                      >
                        <strong>{userLabel(player.user_id, profiles, currentUser)}</strong>
                        <span>Score {player.total_score}</span>
                        <span>Seat {player.seat_index + 1}</span>
                      </div>
                    ))}

                    <div className="table-center">
                      <div className="center-piles">
                        <button
                          className="table-pile pile-stock"
                          disabled={!canDraw || isPending || round.stock_count === 0}
                          onClick={() => startTransition(() => void playTurnAction("draw_stock"))}
                          type="button"
                        >
                          <span className="pile-label">Stock</span>
                          <StockCardBack />
                          <span className="pile-hint">Draw from deck</span>
                          <strong>{round.stock_count}</strong>
                        </button>

                        <button
                          className="table-pile pile-discard"
                          disabled={!canDraw || isPending || discardCount === 0}
                          onClick={() => startTransition(() => void playTurnAction("draw_discard_top"))}
                          type="button"
                        >
                          <span className="pile-label">Discard</span>
                          {discardTop ? (
                            <PlayingCardFace card={discardTop} size="mini" />
                          ) : (
                            <div className="pile-stack">Empty</div>
                          )}
                          <span className="pile-hint">Take top card</span>
                          <strong>{discardCount}</strong>
                        </button>
                      </div>

                      <p className="table-turn-prompt">{desktopPrompt}</p>

                      <div className="meld-zone">
                        <div className="meld-slot">
                          <p className="eyebrow">Sets</p>
                          {tableSets.length ? (
                            <div className="meld-preview-row">
                              {tableSets.map((meld, index) => (
                                <div className="meld-preview" key={`${meld.type ?? "meld"}-${index}`}>
                                  {(meld.cards ?? []).map((card) => (
                                    <PlayingCardFace card={card} key={card.id} size="tiny" />
                                  ))}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span className="muted-copy">Room for sets.</span>
                          )}
                        </div>
                        <div className="meld-slot">
                          <p className="eyebrow">Runs</p>
                          {tableRuns.length ? (
                            <div className="meld-preview-row">
                              {tableRuns.map((meld, index) => (
                                <div className="meld-preview" key={`${meld.type ?? "meld"}-${index}`}>
                                  {(meld.cards ?? []).map((card) => (
                                    <PlayingCardFace card={card} key={card.id} size="tiny" />
                                  ))}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span className="muted-copy">Room for runs.</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="table-footer">
                    <div className="section-heading">
                      <div>
                        <p className="eyebrow">Your hand</p>
                        <h2>Playing cards</h2>
                      </div>
                      <span className="stat-pill">{hand.length} cards</span>
                    </div>

                    {selectedCard && suggestedMelds.length + suggestedLayoffs.length > 0 ? (
                      <div className="suggestion-table-strip">
                        {suggestedMelds.map((suggestion) => (
                          <div className="suggestion-card" key={`table-${suggestion.kind}`}>
                            <strong>{suggestion.kind === "set" ? "Possible set" : "Possible run"}</strong>
                            <p>{suggestion.cards.map((card) => cardLabel(card)).join(" · ")}</p>
                            {canMeld ? (
                              <button
                                className="button button-secondary"
                                onClick={() => startTransition(() => void playSuggestedMeld(suggestion.cards.map((card) => card.id)))}
                                type="button"
                              >
                                Play {suggestion.kind}
                              </button>
                            ) : null}
                          </div>
                        ))}
                        {suggestedLayoffs.map((suggestion) => (
                          <div className="suggestion-card" key={`table-layoff-${suggestion.meldIndex}`}>
                            <strong>{suggestion.kind === "set" ? "Lay off on set" : "Lay off on run"}</strong>
                            <p>{suggestion.targetCards.map((card) => cardLabel(card)).join(" · ")}</p>
                            {canMeld ? (
                              <button
                                className="button button-secondary"
                                onClick={() => startTransition(() => void playLayoff(suggestion.meldIndex, suggestion.card.id))}
                                type="button"
                              >
                                Lay off card
                              </button>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    <div className="desktop-action-row">
                      <button
                        className="button"
                        disabled={!canMeld || !selectedCard || (!primarySuggestedMeld && !primarySuggestedLayoff)}
                        onClick={() =>
                          startTransition(() => {
                            if (primarySuggestedMeld) {
                              return void playSuggestedMeld(primarySuggestedMeld.cards.map((card) => card.id));
                            }

                            if (primarySuggestedLayoff) {
                              return void playLayoff(primarySuggestedLayoff.meldIndex, primarySuggestedLayoff.card.id);
                            }
                          })
                        }
                        type="button"
                      >
                        {primarySuggestedLayoff && !primarySuggestedMeld ? "Lay off" : "Meld"}
                      </button>
                      <button
                        className="button button-secondary"
                        disabled={!canDiscard || !selectedCard}
                        onClick={() => startTransition(() => void playTurnAction("discard_card", selectedCard?.id))}
                        type="button"
                      >
                        Discard
                      </button>
                      <button
                        className="button button-ghost"
                        onClick={() =>
                          setHandSortMode((currentSortMode) =>
                            currentSortMode === "rank" ? "suit" : currentSortMode === "suit" ? "natural" : "rank"
                          )
                        }
                        type="button"
                      >
                        Sort
                      </button>
                    </div>

                    <div className="hand-fan">
                      {hand.length > 0 ? (
                        sortedHand.map((card) => (
                          <button
                            className="hand-playing-card"
                            key={card.id}
                            onClick={() => setSelectedCardId((currentSelected) => (currentSelected === card.id ? null : card.id))}
                            type="button"
                          >
                            <PlayingCardFace card={card} selected={selectedCardId === card.id} size="hand" />
                          </button>
                        ))
                      ) : (
                        <span className="muted-copy">Your hand becomes visible here after dealing.</span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>
          </section>

          <section className="mobile-game-shell mobile-only">
            <div className="mobile-topbar">
              <button
                aria-label="Open lobby settings"
                className="mobile-gear-button"
                onClick={() => setSettingsOpen(true)}
                type="button"
              >
                ⚙
              </button>
              <div className="mobile-title-lockup">
                <h2>Rummy 500</h2>
                <span>{activeTurnLabel}</span>
              </div>
              <button
                className="button button-ghost mobile-refresh"
                onClick={() => startTransition(() => void refreshLobby())}
                type="button"
              >
                Refresh
              </button>
            </div>

            {settingsOpen ? (
              <div className="mobile-settings-overlay" onClick={() => setSettingsOpen(false)} role="presentation">
                <section className="mobile-settings-sheet" onClick={(event) => event.stopPropagation()}>
                  <div className="mobile-settings-head">
                    <div>
                      <p className="eyebrow">Lobby settings</p>
                      <h3>{game?.invite_code ? `Code ${game.invite_code}` : "Invite players"}</h3>
                    </div>
                    <button className="button button-ghost mobile-close-button" onClick={() => setSettingsOpen(false)} type="button">
                      Close
                    </button>
                  </div>

                  <div className="mobile-settings-grid">
                    <button className="button button-secondary" onClick={() => startTransition(() => void copyCode())} type="button">
                      Copy code
                    </button>
                    <button className="button" onClick={() => startTransition(() => void shareInvite())} type="button">
                      Share invite
                    </button>
                    <Link className="button button-ghost mobile-settings-link" href="/">
                      Back to lobby list
                    </Link>
                  </div>

                  <div className="mobile-settings-card">
                    <strong>Lobby</strong>
                    <p>Invite players with code <code>{game?.invite_code ?? "----"}</code>.</p>
                    <p>{players.length} seated. Host can start once at least two players are seated.</p>
                  </div>

                  <div className="mobile-settings-card">
                    <strong>AI opponents</strong>
                    <p>Planned for 1-3 bot seats plus you, but bot gameplay is not implemented yet.</p>
                    <div className="mobile-ai-row" aria-disabled="true">
                      <span className="mobile-ai-pill is-disabled">0</span>
                      <span className="mobile-ai-pill is-disabled">1</span>
                      <span className="mobile-ai-pill is-disabled">2</span>
                      <span className="mobile-ai-pill is-disabled">3</span>
                    </div>
                  </div>

                  {currentPlayer ? (
                    <div className="mobile-settings-grid">
                      <button
                        className="button button-ghost"
                        onClick={() => startTransition(() => void updateReady(!currentPlayer.ready))}
                        type="button"
                      >
                        {currentPlayer.ready ? "Not ready" : "Ready up"}
                      </button>
                      {game?.host_user_id === currentUser.id ? (
                        <button
                          className="button button-google"
                          disabled={!canStart || isPending}
                          onClick={() => startTransition(() => void startGame())}
                          type="button"
                        >
                          Start hand
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              </div>
            ) : null}

            {mobileTopPlayer ? (
              <div className={`mobile-seat top ${game?.turn_user_id === mobileTopPlayer.user_id ? "is-active" : ""}`}>
                <strong>{userLabel(mobileTopPlayer.user_id, profiles, currentUser)}</strong>
                <div className="mobile-back-stack">
                  <StockCardBack />
                  <StockCardBack />
                  <StockCardBack />
                </div>
              </div>
            ) : null}

            <div className="mobile-table-zone">
              {mobileLeftPlayer ? (
                <div className={`mobile-seat side left ${game?.turn_user_id === mobileLeftPlayer.user_id ? "is-active" : ""}`}>
                  <div className="mobile-side-stack">
                    <StockCardBack />
                    <StockCardBack />
                    <StockCardBack />
                  </div>
                  <strong>{userLabel(mobileLeftPlayer.user_id, profiles, currentUser)}</strong>
                </div>
              ) : null}

              <div className="mobile-center-table">
                <div className="mobile-meld-lane">
                  {tableSets.map((meld, index) => (
                    <div className="mobile-meld-stack" key={`mobile-set-${index}`}>
                      {(meld.cards ?? []).map((card) => (
                        <PlayingCardFace card={card} key={card.id} size="tiny" />
                      ))}
                    </div>
                  ))}
                  {tableRuns.map((meld, index) => (
                    <div className="mobile-meld-stack" key={`mobile-run-${index}`}>
                      {(meld.cards ?? []).map((card) => (
                        <PlayingCardFace card={card} key={card.id} size="tiny" />
                      ))}
                    </div>
                  ))}
                </div>

                <div className="mobile-pile-row">
                  <button
                    className="mobile-pile-button"
                    disabled={!canDraw || isPending || round?.stock_count === 0}
                    onClick={() => startTransition(() => void playTurnAction("draw_stock"))}
                    type="button"
                  >
                    <StockCardBack />
                    <span>Stock</span>
                  </button>

                  <button
                    className="mobile-pile-button"
                    disabled={!canDraw || isPending || discardCount === 0}
                    onClick={() => startTransition(() => void playTurnAction("draw_discard_top"))}
                    type="button"
                  >
                    {discardTop ? <PlayingCardFace card={discardTop} size="mini" /> : <div className="pile-stack">Empty</div>}
                    <span>Discard</span>
                  </button>
                </div>
              </div>

              {mobileRightPlayer ? (
                <div className={`mobile-seat side right ${game?.turn_user_id === mobileRightPlayer.user_id ? "is-active" : ""}`}>
                  <div className="mobile-side-stack">
                    <StockCardBack />
                    <StockCardBack />
                    <StockCardBack />
                  </div>
                  <strong>{userLabel(mobileRightPlayer.user_id, profiles, currentUser)}</strong>
                </div>
              ) : null}
            </div>

            <div className="mobile-bottom-area">
              <div className="mobile-prompt">
                <p>{mobilePrompt}</p>
                {selectedCard && suggestedMelds.length + suggestedLayoffs.length > 0 ? (
                  <div className="mobile-suggestion-actions">
                    {suggestedMelds.map((suggestion) => (
                      <button
                        className="button button-secondary"
                        key={`mobile-${suggestion.kind}`}
                        onClick={() => startTransition(() => void playSuggestedMeld(suggestion.cards.map((card) => card.id)))}
                        type="button"
                      >
                        Play {suggestion.kind}
                      </button>
                    ))}
                    {suggestedLayoffs.map((suggestion) => (
                      <button
                        className="button button-secondary"
                        key={`mobile-layoff-${suggestion.meldIndex}`}
                        onClick={() => startTransition(() => void playLayoff(suggestion.meldIndex, suggestion.card.id))}
                        type="button"
                      >
                        Lay off on {suggestion.kind}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="mobile-hand-scroll">
                {sortedHand.map((card) => (
                  <button
                    className="mobile-hand-card-button"
                    key={card.id}
                    onClick={() => setSelectedCardId((currentSelected) => (currentSelected === card.id ? null : card.id))}
                    type="button"
                  >
                    <PlayingCardFace card={card} selected={selectedCardId === card.id} size="hand" />
                  </button>
                ))}
              </div>

              <div className="mobile-action-row">
                <button
                  className="button mobile-icon-button"
                  disabled={!canMeld || !selectedCard || (!primarySuggestedMeld && !primarySuggestedLayoff)}
                  onClick={() =>
                    startTransition(() => {
                      if (primarySuggestedMeld) {
                        return void playSuggestedMeld(primarySuggestedMeld.cards.map((card) => card.id));
                      }

                      if (primarySuggestedLayoff) {
                        return void playLayoff(primarySuggestedLayoff.meldIndex, primarySuggestedLayoff.card.id);
                      }
                    })
                  }
                  type="button"
                >
                  <span>♣</span>
                  <small>{primarySuggestedLayoff && !primarySuggestedMeld ? "Lay off" : "Meld"}</small>
                </button>
                <button
                  className="button button-secondary mobile-icon-button"
                  disabled={!canDiscard || !selectedCard}
                  onClick={() => startTransition(() => void playTurnAction("discard_card", selectedCard?.id))}
                  type="button"
                >
                  <span>↗</span>
                  <small>Discard</small>
                </button>
                <button
                  className="button button-ghost mobile-icon-button"
                  onClick={() =>
                    setHandSortMode((currentSortMode) =>
                      currentSortMode === "rank" ? "suit" : currentSortMode === "suit" ? "natural" : "rank"
                    )
                  }
                  type="button"
                >
                  <span>⇅</span>
                  <small>Sort</small>
                </button>
              </div>

              {currentPlayer ? (
                <div className={`mobile-seat self ${isCurrentTurn ? "is-active" : ""}`}>
                  <strong>{userLabel(currentPlayer.user_id, profiles, currentUser)}</strong>
                  <span>{game?.turn_stage === "awaiting_draw" ? "Draw phase" : "Play / discard"}</span>
                </div>
              ) : null}
            </div>
          </section>

          <section className="grid lobby-grid audit-section">
            <article className="panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Audit trail</p>
                  <h2>Recent actions</h2>
                </div>
                <span className="stat-pill">{players.length} seated</span>
              </div>

              {actions.length === 0 ? (
                <div className="empty-state">
                  <p>No actions yet.</p>
                  <span>Ready-state changes and round starts are logged here.</span>
                </div>
              ) : (
                <div className="log-list">
                  {actions.map((action) => (
                    <div className="log-row" key={action.id}>
                      <strong>{action.action_type}</strong>
                      <p>{userLabel(action.actor_user_id, profiles, currentUser)}</p>
                      <span>{new Date(action.created_at).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </section>
        </>
      )}
    </main>
  );
}
