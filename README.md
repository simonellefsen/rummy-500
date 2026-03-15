Rummy 500 (also called 500 Rum or 500 Rummy) Rules Summary
Rummy 500 is a popular multi-round melding rummy game where players score points for laying down valid combinations and aim to reach a cumulative total of 500+ points first. It is played over multiple hands until someone hits the target score.
Setup

Players: 2–8 (best with 3–5).
Deck: Standard 52-card deck + 2 Jokers (54 cards total) for 2–4 players. For 5+, use 2 decks + 4 Jokers (or configurable). Jokers are wild and score 15 points.
Deal: Dealer gives 13 cards each to 2 players or 7 cards each to 3+ players. Remaining cards form the face-down stock pile. Flip the top stock card face-up to start the discard pile (often spread/fanned so all cards are visible).

Objective & Card Values

Form melds to empty your hand and score points. First player (or highest if tie) to reach 500 cumulative points wins.
Values:
Ace: 15 (or 1 if low in a run, per variant).
Jokers: 15 (wild).
Face cards (J/Q/K): 10 each.
Number cards (2–10): Face value.

Ace high/low in runs allowed (e.g., A-2-3 or Q-K-A), but no wrapping (no K-A-2).

Melds

Set/Group: 3 or 4 cards of the same rank (different suits if using multiple decks).
Run/Sequence: 3+ consecutive cards of the same suit.
Jokers substitute any card (declare what it represents when laid; cannot change later).

pagat.comcoololdgames.com

(Examples above: sets/runs with jokers and point values.)
Gameplay (Turns Clockwise from Dealer’s Left)

Draw:
Take the top card from stock, OR
Take any card from discard pile → you must take all cards above it too, and immediately use the target (bottom) card in a meld or layoff this turn.

Meld & Lay Off (optional but key):
Lay down new valid meld(s) from your hand (including just-drawn cards).
Lay off (add) cards to any existing melds already on the table (even opponents’ — you score the points).

Discard: End turn by placing one card face-up on discard pile (must be different from the one you took if only top discard was drawn).


Special: Some variants allow “calling Rummy!” to steal a useful discard/pile before the next player draws.
Going Out: Empty your hand completely (by melding everything + optional final discard). Play ends immediately. No one else can meld after.

Scoring (Per Hand)

Your score = (value of all your melded + laid-off cards) minus (value of remaining “deadwood” cards in your hand).
Add/subtract from your running total. Negative scores possible.
Hand ends if someone goes out or stock runs out (no further melding).

wikihow.comHow to Play Rummy 500: Easy Rule Guide
(Example scoring tally reaching 500.)
Winning & Common Variations

Continue hands until someone reaches 500+. Highest score wins if multiple cross the line in one hand.
Configurable: Number of jokers/decks, minimum initial meld (e.g., 30 pts), must-discard-to-go-out, floating, etc.

These rules are synthesized from standard sources (Bicycle, Pagat.com, wikiHow, etc.); house rules vary slightly — your app can include toggles for popular ones.
Plan for Multiplayer App: Vercel (Next.js) + Supabase (Fully Server-Authoritative, Anti-Cheat Focused)
Tech Stack

Frontend: Next.js 15 (App Router) on Vercel — React, TypeScript, Tailwind + shadcn/ui, React Query/TanStack, framer-motion for drag-and-drop cards, Zustand or Jotai for local UI state. Card UI library (e.g., custom SVG or react-playing-cards).
Backend/DB: Supabase (Auth + Postgres + Realtime + Edge Functions + RLS). No custom server needed beyond Supabase Edge Functions (Deno) for heavy logic. Vercel handles static + API routes for any non-Supabase calls.
Realtime: Supabase Broadcast + Postgres changes subscriptions (per game room channel).
Security/Validation: All game logic runs server-side. Clients only propose actions.

Core Flow (Host → Invite → Play)

User Auth: Supabase Auth (email/password + Google/OAuth + anonymous for quick play). Profiles table.
Create Game (Host):
Button → Supabase insert into games table (id = short code like "ABC123" or UUID, host_id, status="lobby", config JSONB: {decks: 1|2, jokers: 0|2|4|6, max_players: 8, variants: {min_meld:30, must_discard:true, ...}, current_turn: null}).
Host sees unique invite link/code.

Join/Invite:
Others enter code or click link → RPC join_game(code, user_id) → adds to game_players (position, ready=false). Max-player check + host approval optional.
Lobby UI: List players, chat (via Supabase), ready buttons. Host starts when ≥2 ready.

Start Game:
Host clicks “Start” → Edge Function start_game(game_id):
Generates full deck (array of {id, suit:'♥', rank:'A', isJoker:true} using configurable jokers + decks).
Crypto-random shuffle (crypto.getRandomValues or pg random).
Deals hands (insert private rows into player_hands: game_id, player_id, hand: jsonb[] — RLS policy: auth.uid() = player_id).
Sets public state: stock_count, discard_pile:[] (array of card objects), table_melds:[] (array of {player_id, meld_type, cards, owner_score_contrib}).
Broadcasts “game_started” via realtime.



DB Schema Outline (Supabase Postgres)

games (id, host_id, status, config JSONB, winner_id, scores JSONB, stock_size, turn_player_id).
game_players (game_id, user_id, position, total_score, ready).
player_hands (game_id, user_id, hand jsonb) — RLS: SELECT/UPDATE only if auth.uid() = user_id; no one else sees.
public_game_state (game_id, discard_pile jsonb, table_melds jsonb, logs).
player_melds (for tracking who laid what — scored per player).

Anti-Cheat & Server Authority (Key Requirement)

Never trust client: Hands, full deck, validity checks 100% server-side.
All Actions via Supabase RPC/Edge Function calls (e.g., make_move(action_type, payload)):
Examples: "draw_stock", "draw_discard(target_index)", "meld_cards(selected_ids, type)", "layoff_to_meld(target_meld_id, card_ids)", "discard(card_id)".
Function:
Verifies: It is player’s turn (DB lock/row lock), owns the cards (in their private hand row), move is legal (validate_set/run/layoff functions in TS/JS — e.g., sort + check consecutive/same rank).
For discard pile draw: Enforces “take all above + immediate use”.
Atomically: Removes from hand, adds to melds/discard, updates scores, advances turn, broadcasts delta via realtime.
Logs every action for audit.


Private Visibility: Each client subscribes to own hand row (Supabase realtime) + public game_state. Others’ hands invisible. UI never receives full deck.
Jokers Configurable: Stored in games.config.jokers. During deck generation, add that many wild cards (marked as such).
Validation Library: Shared TS types + Zod schemas on both client (optimistic UI) & server (strict enforcement). Server uses same rules engine (isValidMeld(cardArray), canLayoff(...)).
Edge Cases Handled Server-Side: Going out detection (hand empty after meld/discard), stock empty, Rummy! calls (if variant enabled), floating variants.

UI & Game Loop (Next.js)

Screens: Auth → Dashboard (my games) → Lobby (players list + config editor for host) → Game Table (circular players, bottom: draggable hand cards with suit/rank emojis or images, center: discard pile + table meld areas grouped by player, top: scores/turn indicator).
Interactions: Tap/select cards → buttons “Meld Set/Run”, “Lay Off”, “Draw”. Drag-drop to meld areas (with server confirmation).
Realtime Sync: On any change, Supabase subscription updates UI instantly (e.g., supabase.channel('game:'+id).on(...)).
Mobile-Friendly: Responsive, touch drag, PWA installable via Vercel.

Development Roadmap & Extras

MVP: Auth + lobby + basic turn/draw/meld with server validation + scoring.
Polish: Card animations, undo protection (none), sound, chat, spectator mode.
Advanced: Host pause/kick, multiple variants toggles, AI bot filler, analytics (games played).
Deployment/Scaling: Vercel + Supabase free tier starts fine; scales with usage. Env vars for Supabase URL/key. Add rate limiting on actions.
Testing: Unit tests for validation functions; end-to-end with multiple browser tabs simulating players.

This architecture ensures zero cheating (server owns truth), smooth realtime play, easy invites, and full configurability (especially jokers). Total build feasible in 2–4 weeks for a solo dev with Supabase experience — start with a rules engine + card validator module.
You now have accurate rules + a production-ready blueprint! Let me know if you want DB SQL snippets, a specific component code outline, or rule variant expansions.

Implementation status

The first implementation slice is now in the repository:

- Next.js app scaffold under `src/app`
- Rummy rules engine under `src/lib/rummy`
- App-owned migration runner under `scripts/run-app-migrations.mjs`
- Rummy 500 SQL migrations under `migrations/rummy500`
- Start-game Edge Function under `supabase/functions/start-game`
- Authenticated dashboard on `/` and lobby route on `/games/[gameId]`

Important Supabase safety rule:

- This project uses a dedicated `rummy500` schema and additive migrations only.
- Do not run remote reset workflows against a shared Supabase database.
- Do not use `supabase db push` as the remote migration owner for this repo.
- Review `docs/supabase-shared-db-plan.md` before applying future migrations.

Getting started

1. Copy `.env.example` to `.env.local` or `.env` and fill in the Supabase values.
2. Install dependencies with `pnpm install`.
3. Start the app with `pnpm dev`.
4. Run checks with `pnpm test`, `pnpm typecheck`, and `pnpm build`.
5. Apply database changes with `npm run migrate:rummy500`.

Environment variables used by the app

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL`

`next.config.ts` maps the public Supabase values into browser-safe `NEXT_PUBLIC_*` values at build time, so the app works with the shared `.env` naming in this repository.

Initial shared-database migration

1. Load `.env` or `.env.local` with `SUPABASE_DB_URL`.
2. Run `npm run migrate:rummy500`.
3. Use `npm run migrate:rummy500:plan` to see pending or drifted migrations without applying them.
4. Keep using Supabase CLI for local helpers and Edge Function deploys, not as the remote migration owner.
