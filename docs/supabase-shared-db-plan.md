# Supabase shared-database migration plan

This project assumes Supabase is shared with other applications, so migration safety matters more than speed.

## Rules

1. Keep all application tables, types, functions, and policies in the `rummy500` schema.
2. Treat the first rollout as additive only. No `drop table`, `drop schema`, `truncate`, or remote reset commands.
3. Prefer idempotent SQL: `create schema if not exists`, `create table if not exists`, `add column if not exists`.
4. Use expand, migrate, contract for every breaking schema change.
5. Do not run `supabase db reset` against a shared remote database. Restrict resets to disposable local stacks only.
6. Do not trust generated diffs blindly. Review them for destructive SQL before they are committed.

## Change process

### Expand

- Add new columns, tables, or functions without removing old ones.
- Deploy code that can read both the old and new shape.

### Migrate

- Backfill or dual-write until the new shape is populated and stable.
- Observe production traffic and other dependent projects before removing anything.

### Contract

- Only after confirming no active dependency remains, remove obsolete columns or functions in a later migration.
- For shared environments, keep destructive contract migrations manual and separately reviewed.

## Shared migration history bootstrap

When this repository starts using a Supabase project that already has migration history from other applications, do not run `supabase migration repair --status reverted ...` just to satisfy this repo.

Instead:

1. Keep the remote history intact.
2. Add local placeholder files for the pre-existing remote versions that this repository does not own.
3. Commit those placeholders so every checkout has the same migration history view.
4. Only then run `supabase db push` to apply the new `rummy500` migrations.

These placeholder files are no-op SQL files whose only purpose is to let Supabase CLI align local and remote histories safely in a shared database.

## Supabase CLI guidance

- Safe remote default: `supabase db push`
- Local-only reset: `supabase db reset`
- Review before commit: inspect every file in `supabase/migrations`

## Why a dedicated schema matters

Using `rummy500.*` keeps this project's objects together, avoids naming collisions with sibling apps, and makes it much less likely that a future migration touches unrelated tables.
