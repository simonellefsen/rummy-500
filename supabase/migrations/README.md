Supabase CLI migrations are not the remote source of truth in this repository.

Remote schema changes for Rummy 500 live in `migrations/rummy500/*.sql` and are applied with:

- `npm run migrate:rummy500`
- `npm run migrate:rummy500:plan`

The `supabase/` directory remains for local Supabase tooling and Edge Functions only.
