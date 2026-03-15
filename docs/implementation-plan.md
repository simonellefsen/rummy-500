# Rummy 500 implementation plan

This repository now contains the first implementation slice for the game described in `README.md`.

## Current scope

- Next.js app shell with a presentable landing page.
- Authenticated dashboard for guest, Google, and email-link sign-in.
- Lobby route for ready-state changes, invite-code sharing, and starting the first round.
- Domain model for cards, deck setup, dealing, meld validation, and scoring.
- App-owned SQL migrations under `migrations/rummy500` with a custom runner and `rummy500_meta.migrations` ledger.
- A start-game Edge Function that can deal the opening round from a server-trusted deck.
- Reduced direct table writes for authenticated clients so lobby creation and joins flow through RPCs first.

## Recommended next milestones

1. Replace the polling-based lobby refresh with Supabase Realtime subscriptions.
2. Implement a `submit-turn-action` Edge Function to handle draw, meld, layoff, and discard atomically.
3. Add migration verification tests against a disposable Postgres or Supabase test database.
4. Split the current round UI into a proper table view with meld areas, discard stack history, and turn controls.
5. Add chat, host moderation, and configurable rule variants once the turn engine is in place.
