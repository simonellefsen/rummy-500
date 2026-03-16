"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { cardLabel } from "../lib/rummy/cards";
import type { Card } from "../lib/rummy/types";
import { createBrowserSupabaseClient } from "../lib/supabase/client";
import { getPublicSupabaseEnv } from "../lib/supabase/env";

interface GameRow {
  id: string;
  invite_code: string;
  status: string;
  host_user_id: string;
  turn_user_id: string | null;
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

async function postStartGame(gameId: string, accessToken: string) {
  const response = await fetch(`${supabaseUrl}/functions/v1/start-game`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: anonKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ gameId })
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

function getConfiguredNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getCardsPerPlayer(config: Record<string, unknown> | null | undefined, playerCount: number) {
  return getConfiguredNumber(config?.cardsPerPlayer) ?? (playerCount === 2 ? 13 : 7);
}

export function GameLobbyClient({ gameId }: { gameId: string }) {
  const router = useRouter();
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
              .select("id, invite_code, status, host_user_id, turn_user_id, round_number, config, started_at")
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
          .select("id, invite_code, status, host_user_id, turn_user_id, round_number, config, started_at")
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

    const response = await postStartGame(gameId, currentSession.access_token);

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
        : await postStartGame(gameId, accessToken)
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
  const cardsPerPlayer = getCardsPerPlayer(game?.config, players.length);
  const isCurrentTurn = !!currentUser && game?.turn_user_id === currentUser.id && round?.status === "active";
  const canDraw = isCurrentTurn && hand.length === cardsPerPlayer;
  const canDiscard = isCurrentTurn && hand.length === cardsPerPlayer + 1;
  const activeTurnLabel = game?.turn_user_id ? userLabel(game.turn_user_id, profiles, currentUser) : "Not started";
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
              : "Your turn. Discard one card to end it."
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
          <section className="grid lobby-grid">
            <article className="panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Lobby controls</p>
                  <h2>Game settings</h2>
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
                  <strong>Turn:</strong>{" "}
                  {activeTurnLabel}
                </p>
                <p>
                  <strong>Round:</strong> {game?.round_number ?? 0}
                </p>
                <p>
                  <strong>Start rule:</strong> every seated player must be ready before the host can start.
                </p>
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
            </article>

            <article className="panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Players</p>
                  <h2>Seats and scores</h2>
                </div>
                <span className="stat-pill">{players.length} seated</span>
              </div>

              <div className="player-list">
                {players.map((player) => (
                  <div className="player-row" key={player.user_id}>
                    <div>
                      <strong>{userLabel(player.user_id, profiles, currentUser)}</strong>
                      <p>
                        Seat {player.seat_index + 1} · {player.ready ? "Ready" : "Waiting"}
                      </p>
                    </div>
                    <div className="player-row-meta">
                      {game?.turn_user_id === player.user_id ? <span className="pill">Current turn</span> : null}
                      <span className="pill subtle">Score {player.total_score}</span>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </section>

          <section className="grid lobby-grid">
            <article className="panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Round state</p>
                  <h2>Current table</h2>
                </div>
                {round ? <span className="stat-pill">Stock {round.stock_count}</span> : null}
              </div>

              {!round ? (
                <div className="empty-state">
                  <p>No round has started yet.</p>
                  <span>The start-game Edge Function will deal hands and create the opening discard.</span>
                </div>
              ) : (
                <div className="stack">
                  <div className="pile-grid">
                    <div className="pile-card">
                      <p className="eyebrow">Stock pile</p>
                      <div className="pile-visual pile-visual-stock">Draw</div>
                      <strong>{round.stock_count} cards left</strong>
                      <span className="muted-copy">Face-down draw pile.</span>
                      <button
                        className="button"
                        disabled={!canDraw || isPending || round.stock_count === 0}
                        onClick={() => startTransition(() => void playTurnAction("draw_stock"))}
                        type="button"
                      >
                        Draw from stock
                      </button>
                    </div>

                    <div className="pile-card">
                      <p className="eyebrow">Discard pile</p>
                      <div className="pile-visual">{discardTop ? cardLabel(discardTop) : "Empty"}</div>
                      <strong>{discardCount} cards visible</strong>
                      <span className="muted-copy">Current implementation allows taking the top discard.</span>
                      <button
                        className="button button-secondary"
                        disabled={!canDraw || isPending || discardCount === 0}
                        onClick={() => startTransition(() => void playTurnAction("draw_discard_top"))}
                        type="button"
                      >
                        Take top discard
                      </button>
                    </div>
                  </div>

                  <div className="status-strip">
                    <div>
                      <p className="strip-label">Discard top</p>
                      <strong>{discardTop ? cardLabel(discardTop) : "Empty"}</strong>
                    </div>
                    <div>
                      <p className="strip-label">Meld groups</p>
                      <strong>{round.table_melds?.length ?? 0}</strong>
                    </div>
                    <div>
                      <p className="strip-label">Round status</p>
                      <strong>{round.status}</strong>
                    </div>
                  </div>

                  <div>
                    <p className="eyebrow">Your hand</p>
                    <div className="card-row">
                      {hand.length > 0 ? (
                        hand.map((card) => (
                          <div className="hand-card" key={card.id}>
                            <span className="card-chip">{cardLabel(card)}</span>
                            <button
                              className="button button-ghost card-action"
                              disabled={!canDiscard || isPending}
                              onClick={() => startTransition(() => void playTurnAction("discard_card", card.id))}
                              type="button"
                            >
                              Discard
                            </button>
                          </div>
                        ))
                      ) : (
                        <span className="muted-copy">Your hand becomes visible here after dealing.</span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </article>

            <article className="panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Audit trail</p>
                  <h2>Recent actions</h2>
                </div>
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
