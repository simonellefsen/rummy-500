"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import Script from "next/script";
import { useEffect, useRef, useState, useTransition } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { createBrowserSupabaseClient } from "../lib/supabase/client";
import { getPublicGoogleClientId } from "../lib/supabase/env";

interface DashboardGame {
  id: string;
  inviteCode: string;
  status: string;
  roundNumber: number;
  hostUserId: string;
  ready: boolean;
  totalScore: number;
  joinedAt: string;
}

const supabase = createBrowserSupabaseClient();

function createGuestName() {
  return `Player ${Math.floor(100 + Math.random() * 900)}`;
}

function getUserLabel(user: User, profileName?: string | null) {
  if (profileName?.trim()) {
    return profileName.trim();
  }

  const metadataName =
    typeof user.user_metadata?.display_name === "string" ? user.user_metadata.display_name.trim() : "";

  if (metadataName) {
    return metadataName;
  }

  if (user.email) {
    return user.email;
  }

  return `Guest ${user.id.slice(0, 6)}`;
}

async function loadDashboard(userId: string) {
  const [{ data: profileData, error: profileError }, { data: memberships, error: membershipsError }] =
    await Promise.all([
      supabase
        .schema("rummy500")
        .from("profiles")
        .select("display_name")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .schema("rummy500")
        .from("game_players")
        .select("game_id, ready, total_score, joined_at")
        .eq("user_id", userId)
        .order("joined_at", { ascending: false })
    ]);

  if (profileError) {
    throw profileError;
  }

  if (membershipsError) {
    throw membershipsError;
  }

  if (!memberships || memberships.length === 0) {
    return {
      displayName: profileData?.display_name ?? null,
      games: [] as DashboardGame[]
    };
  }

  const gameIds = memberships.map((membership) => membership.game_id);
  const { data: games, error: gamesError } = await supabase
    .schema("rummy500")
    .from("games")
    .select("id, invite_code, status, round_number, host_user_id")
    .in("id", gameIds);

  if (gamesError) {
    throw gamesError;
  }

  const gameMap = new Map(games?.map((game) => [game.id, game]));

  return {
    displayName: profileData?.display_name ?? null,
    games: memberships
      .map((membership) => {
        const game = gameMap.get(membership.game_id);

        if (!game) {
          return null;
        }

        return {
          id: game.id,
          inviteCode: game.invite_code,
          status: game.status,
          roundNumber: game.round_number,
          hostUserId: game.host_user_id,
          ready: membership.ready,
          totalScore: membership.total_score,
          joinedAt: membership.joined_at
        };
      })
      .filter((game): game is DashboardGame => game !== null)
  };
}

export function HomeConsole() {
  const router = useRouter();
  const googleButtonRef = useRef<HTMLDivElement | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [guestName, setGuestName] = useState(createGuestName);
  const [joinCode, setJoinCode] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [mustDiscardToGoOut, setMustDiscardToGoOut] = useState(true);
  const [visibleDiscardPile, setVisibleDiscardPile] = useState(false);
  const [games, setGames] = useState<DashboardGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [googleReady, setGoogleReady] = useState(false);
  const [isPending, startTransition] = useTransition();
  const googleClientId = getPublicGoogleClientId();

  useEffect(() => {
    let isActive = true;

    async function bootstrap() {
      const {
        data: { session: nextSession },
        error
      } = await supabase.auth.getSession();

      if (!isActive) {
        return;
      }

      if (error) {
        setErrorMessage(error.message);
      }

      setSession(nextSession);
      setLoading(false);

      if (nextSession?.user) {
        void refreshDashboard(nextSession.user.id, nextSession.user);
      }
    }

    async function refreshDashboard(userId: string, user?: User | null) {
      try {
        const dashboard = await loadDashboard(userId);

        if (!isActive) {
          return;
        }

        setDisplayName(
          dashboard.displayName ??
            (typeof user?.user_metadata?.display_name === "string" ? user.user_metadata.display_name : "")
        );
        setGames(dashboard.games);
      } catch (error) {
        if (!isActive) {
          return;
        }

        setErrorMessage(error instanceof Error ? error.message : "Failed to load dashboard.");
      }
    }

    void bootstrap();

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!isActive) {
        return;
      }

      setSession(nextSession);
      setStatusMessage(null);
      setErrorMessage(null);
      setLoading(false);

      if (nextSession?.user) {
        startTransition(() => {
          void refreshDashboard(nextSession.user.id, nextSession.user);
        });
      } else {
        setDisplayName("");
        setGames([]);
      }
    });

    return () => {
      isActive = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!googleReady || !googleClientId || session?.user || !window.google) {
      return;
    }

    let cancelled = false;

    const handleGoogleCredential = async (response: { credential: string }) => {
      if (cancelled) {
        return;
      }

      setErrorMessage(null);
      setStatusMessage(null);

      const { error } = await supabase.auth.signInWithIdToken({
        provider: "google",
        token: response.credential
      });

      if (error) {
        setErrorMessage(error.message);
        return;
      }

      setStatusMessage("Signed in with Google.");
    };

    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: (response) => {
        void handleGoogleCredential(response);
      },
      auto_select: false,
      cancel_on_tap_outside: false,
      use_fedcm_for_prompt: true,
      context: "signin"
    });

    if (googleButtonRef.current) {
      googleButtonRef.current.innerHTML = "";
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        theme: "filled_black",
        size: "large",
        text: "continue_with",
        shape: "pill",
        width: 280,
        logo_alignment: "left"
      });
    }

    window.google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        setStatusMessage("Google One Tap is unavailable in this browser; use the Google button below.");
      }
    });

    return () => {
      cancelled = true;
      window.google?.accounts.id.cancel();
    };
  }, [googleClientId, googleReady, session?.user]);

  function normalizeCode(value: string) {
    return value.replace(/\s+/g, "").toUpperCase();
  }

  async function refreshSignedInDashboard() {
    const currentUserId = session?.user.id;

    if (!currentUserId) {
      return;
    }

    const dashboard = await loadDashboard(currentUserId);
    setDisplayName(
      dashboard.displayName ??
        (typeof session?.user.user_metadata?.display_name === "string"
          ? session.user.user_metadata.display_name
          : "")
    );
    setGames(dashboard.games);
  }

  async function saveDisplayName() {
    const userId = session?.user.id;

    if (!userId) {
      return;
    }

    setErrorMessage(null);
    setStatusMessage(null);

    const { error } = await supabase.schema("rummy500").from("profiles").upsert(
      {
        user_id: userId,
        display_name: displayName.trim() || null
      },
      { onConflict: "user_id" }
    );

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    setStatusMessage("Display name updated.");
    await refreshSignedInDashboard();
  }

  async function signInAsGuest() {
    setErrorMessage(null);
    setStatusMessage(null);

    const { error } = await supabase.auth.signInAnonymously({
      options: {
        data: {
          display_name: guestName.trim() || createGuestName()
        }
      }
    });

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    setStatusMessage("Signed in as guest.");
  }

  async function createGame() {
    setErrorMessage(null);
    setStatusMessage(null);

    const { data, error } = await supabase.schema("rummy500").rpc("create_game", {
      p_config: {
        max_players: maxPlayers,
        target_score: 500,
        variants: {
          aceCanBeLow: true,
          aceCanBeHigh: true,
          minimumInitialMeldPoints: 0,
          mustDiscardToGoOut,
          visibleDiscardPile
        }
      }
    });

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    router.push(`/games/${data}`);
  }

  async function joinGame() {
    setErrorMessage(null);
    setStatusMessage(null);

    const code = normalizeCode(joinCode);

    if (!code) {
      setErrorMessage("Enter an invite code.");
      return;
    }

    const { data, error } = await supabase.schema("rummy500").rpc("join_game", {
      p_invite_code: code
    });

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    router.push(`/games/${data}`);
  }

  async function signOut() {
    setErrorMessage(null);
    setStatusMessage(null);

    const { error } = await supabase.auth.signOut();

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    window.google?.accounts.id.disableAutoSelect();
    setStatusMessage("Signed out.");
  }

  const user = session?.user ?? null;

  return (
    <section className="grid interactive-grid">
      {!user && googleClientId ? (
        <Script
          onLoad={() => setGoogleReady(true)}
          src="https://accounts.google.com/gsi/client"
          strategy="afterInteractive"
        />
      ) : null}

      <article className="panel auth-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Live Supabase access</p>
            <h2>{user ? `Welcome back, ${getUserLabel(user, displayName)}.` : "Sign in to create or join a game."}</h2>
          </div>
          {user ? (
            <button className="button button-ghost" onClick={() => startTransition(() => void signOut())} type="button">
              Sign out
            </button>
          ) : null}
        </div>

        {loading ? <p className="muted-copy">Checking Supabase session…</p> : null}
        {statusMessage ? <p className="banner banner-success">{statusMessage}</p> : null}
        {errorMessage ? <p className="banner banner-error">{errorMessage}</p> : null}

        {!user ? (
          <div className="stack">
            <div className="form-grid two-up">
              <label className="field">
                <span>Guest name</span>
                <input
                  className="input"
                  maxLength={24}
                  onChange={(event) => setGuestName(event.target.value)}
                  placeholder="Player 500"
                  value={guestName}
                />
              </label>
              <div className="field action-field">
                <span>Quick play</span>
                <button
                  className="button"
                  disabled={isPending}
                  onClick={() => startTransition(() => void signInAsGuest())}
                  type="button"
                >
                  Continue as guest
                </button>
              </div>
            </div>

            <div className="divider" />

            <div className="stack">
              <div>
                <p className="eyebrow">Google One Tap</p>
                <p className="muted-copy">
                  One Tap will open automatically when available. If the browser suppresses it, use the
                  Google button below.
                </p>
              </div>

              {googleClientId ? (
                <div className="google-button-shell" ref={googleButtonRef} />
              ) : (
                <p className="banner banner-error">
                  Missing Google client id. Set <code>NEXT_PUBLIC_GOOGLE_CLIENT_ID</code> or{" "}
                  <code>GOOGLE_CLIENT_ID</code>.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="stack">
            <div className="form-grid two-up">
              <label className="field">
                <span>Display name</span>
                <input
                  className="input"
                  maxLength={24}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Your table name"
                  value={displayName}
                />
              </label>
              <div className="field action-field">
                <span>Profile</span>
                <button
                  className="button button-secondary"
                  disabled={isPending}
                  onClick={() => startTransition(() => void saveDisplayName())}
                  type="button"
                >
                  Save name
                </button>
              </div>
            </div>

            <div className="divider" />

            <div className="form-grid two-up">
              <label className="field">
                <span>New game seats</span>
                <input
                  className="input"
                  max={8}
                  min={2}
                  onChange={(event) => {
                    const parsed = Number(event.target.value);
                    setMaxPlayers(Number.isFinite(parsed) ? Math.max(2, Math.min(8, parsed)) : 4);
                  }}
                  type="number"
                  value={maxPlayers}
                />
              </label>
              <div className="field action-field">
                <span>Host a lobby</span>
                <button
                  className="button"
                  disabled={isPending}
                  onClick={() => startTransition(() => void createGame())}
                  type="button"
                >
                  Create game
                </button>
              </div>
            </div>

            <label className="field">
              <span>Go out rule</span>
              <div className="toggle-row">
                <input
                  checked={mustDiscardToGoOut}
                  onChange={(event) => setMustDiscardToGoOut(event.target.checked)}
                  type="checkbox"
                />
                <span>Require a final discard to go out</span>
              </div>
            </label>

            <label className="field">
              <span>Discard pile rule</span>
              <div className="toggle-row">
                <input
                  checked={visibleDiscardPile}
                  onChange={(event) => setVisibleDiscardPile(event.target.checked)}
                  type="checkbox"
                />
                <span>Show the full discard pile and allow picking from anywhere</span>
              </div>
            </label>

            <div className="form-grid two-up">
              <label className="field">
                <span>Invite code</span>
                <input
                  className="input invite-input"
                  onChange={(event) => setJoinCode(normalizeCode(event.target.value))}
                  placeholder="ABC123"
                  value={joinCode}
                />
              </label>
              <div className="field action-field">
                <span>Join a table</span>
                <button
                  className="button button-secondary"
                  disabled={isPending || !joinCode}
                  onClick={() => startTransition(() => void joinGame())}
                  type="button"
                >
                  Join game
                </button>
              </div>
            </div>
          </div>
        )}
      </article>

      <article className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">My games</p>
            <h2>Recent lobbies and active tables.</h2>
          </div>
          {user ? (
            <button
              className="button button-ghost"
              disabled={isPending}
              onClick={() => startTransition(() => void refreshSignedInDashboard())}
              type="button"
            >
              Refresh
            </button>
          ) : null}
        </div>

        {!user ? (
          <p className="muted-copy">
            Authentication is required before the dashboard can load games from the shared Supabase project.
          </p>
        ) : games.length === 0 ? (
          <div className="empty-state">
            <p>No games yet.</p>
            <span>Create a lobby or enter an invite code to start.</span>
          </div>
        ) : (
          <div className="game-list">
            {games.map((game) => (
              <Link className="game-card" href={`/games/${game.id}`} key={game.id}>
                <div className="meta-row">
                  <span className="pill">{game.status}</span>
                  <span className="pill subtle">Round {game.roundNumber}</span>
                </div>
                <strong>{game.inviteCode}</strong>
                <p>
                  Score {game.totalScore} · {game.ready ? "Ready" : "Not ready"}
                </p>
                <span>Open lobby</span>
              </Link>
            ))}
          </div>
        )}
      </article>
    </section>
  );
}
