# Supabase shared-database migration plan

This project assumes Supabase is shared with other applications, so migration safety matters more than speed.

## Rules

1. Keep all application tables, types, functions, and policies in the `rummy500` schema.
2. Keep migration tracking for this app in `rummy500_meta.migrations`, not in `supabase_migrations.schema_migrations`.
3. Treat the first rollout as additive only. No `drop table`, `drop schema`, `truncate`, or remote reset commands.
4. Prefer idempotent SQL: `create schema if not exists`, `create table if not exists`, `add column if not exists`.
5. Use expand, migrate, contract for every breaking schema change.
6. Do not run `supabase db reset` against a shared remote database. Restrict resets to disposable local stacks only.
7. Do not trust generated diffs blindly. Review them for destructive SQL before they are committed.

## Migration runner guidance

- Safe remote default: `npm run migrate:rummy500`
- Dry run / pending view: `npm run migrate:rummy500:plan`
- Local-only reset: `supabase db reset`
- Review before commit: inspect every file in `migrations/rummy500`

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

## Why this avoids shared-history collisions

This repository no longer depends on Supabase CLI’s global migration ledger for remote rollout.

Instead:

1. The runner reads `migrations/rummy500/*.sql`.
2. It acquires an advisory lock scoped to the `rummy500` app.
3. It wraps each migration in a transaction.
4. It records version + checksum in `rummy500_meta.migrations`.

That means another project can keep its own migration ledger, such as `otherapp_meta.migrations`, without either repo needing to mirror the other repo’s migration history.

## Why a dedicated schema matters

Using `rummy500.*` keeps this project's objects together, avoids naming collisions with sibling apps, and makes it much less likely that a future migration touches unrelated tables.
