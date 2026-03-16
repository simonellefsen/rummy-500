"use client";

import Link from "next/link";
import Script from "next/script";
import { useEffect, useState, useTransition } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { cardLabel } from "../lib/rummy/cards";
import { findSuggestedMelds } from "../lib/rummy/meld-options";
import type { Card } from "../lib/rummy/types";
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
  table_melds: Array<{ cards?: Card[]; owner_user_id?: string; type?: string }>;
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

  const currentUser = session?.user ?? null;
  const currentPlayer = players.find((player) => player.user_id === currentUser?.id) ?? null;
  const isCurrentTurn = !!currentUser && game?.turn_user_id === currentUser.id && round?.status === "active";
  const canDraw = isCurrentTurn && game?.turn_stage === "awaiting_draw";
  const canMeld = isCurrentTurn && game?.turn_stage === "awaiting_discard";
  const canDiscard = isCurrentTurn && game?.turn_stage === "awaiting_discard";
  const activeTurnLabel = game?.turn_user_id ? userLabel(game.turn_user_id, profiles, currentUser) : "Not started";
  const currentSeatIndex = currentPlayer?.seat_index ?? 0;
  const selectedCard = hand.find((card) => card.id === selectedCardId) ?? null;
  const suggestedMelds = selectedCard ? findSuggestedMelds(hand, selectedCard.id) : [];
  const tableSets = (round?.table_melds ?? []).filter((meld) => meld.type === "set");
  const tableRuns = (round?.table_melds ?? []).filter((meld) => meld.type === "run");
  const canStart =
    !!currentUser &&
    !!game &&
    game.status === "lobby" &&
    game.host_user_id === currentUser.id &&
    players.length >= 2 &&
    players.every((player) => player.ready);
  const discardTop = round?.discard_pile?.at(-1) ?? null;
  const discardCount = round?.discard_pile?.length ?? 0;

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
          Create players, mark ready, and start the first hand from a server-authoritative Edge
          Function once everyone in the lobby is prepared.
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
          <section className="table-layout-shell">
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
                      {suggestedMelds.length > 0 ? (
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
                        </div>
                      ) : (
                        <p className="muted-copy">No meld found for this card yet.</p>
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
                          <strong>{discardCount}</strong>
                        </button>
                      </div>

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

                    {selectedCard && suggestedMelds.length > 0 ? (
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
                      </div>
                    ) : null}

                    <div className="hand-fan">
                      {hand.length > 0 ? (
                        hand.map((card) => (
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

          <section className="grid lobby-grid">
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
