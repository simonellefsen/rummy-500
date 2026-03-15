import { HomeConsole } from "../components/home-console";
import { buildSampleGameState } from "../lib/rummy/sample-state";

const sample = buildSampleGameState();

const migrationPrinciples = [
  "All Rummy tables live under a dedicated rummy500 schema.",
  "The first migration is additive and idempotent: no drops, no resets, no public schema rewrites.",
  "Game-changing work should follow expand, migrate, contract so shared projects are never surprised."
];

const nextSteps = [
  "Wire Supabase Auth and lobby creation to the create_game / join_game RPCs.",
  "Move turn execution into Edge Functions so draw, meld, and discard are verified server-side.",
  "Stream private hand rows plus public round state to the client over Supabase Realtime."
];

export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="hero-panel">
        <p className="eyebrow">Rummy 500 implementation baseline</p>
        <h1>Online multiplayer foundation with safe Supabase migrations.</h1>
        <p className="hero-copy">
          This first slice turns the README into code: a Next.js application shell, a shared rules
          engine, and a database plan that assumes Supabase is shared with other products.
        </p>
      </section>

      <HomeConsole />

      <section className="grid two-column">
        <article className="panel">
          <h2>What is implemented</h2>
          <ul>
            <li>Typed card, deck, and game configuration models.</li>
            <li>Deterministic deck generation, shuffling, and opening-hand dealing.</li>
            <li>Meld validation for sets and runs with joker support.</li>
            <li>Initial Supabase schema, RPC entry points, and row-level access boundaries.</li>
          </ul>
        </article>

        <article className="panel">
          <h2>Shared database guardrails</h2>
          <ul>
            {migrationPrinciples.map((principle) => (
              <li key={principle}>{principle}</li>
            ))}
          </ul>
        </article>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Sample opening state</p>
            <h2>Four-player deal preview</h2>
          </div>
          <p className="stat-pill">Stock {sample.stockCount}</p>
        </div>

        <div className="table-layout">
          {sample.players.map((player) => (
            <article className="hand-panel" key={player}>
              <div className="hand-header">
                <h3>{player}</h3>
                <span>{sample.hands[player].length} cards</span>
              </div>
              <div className="card-row">
                {sample.hands[player].map((card) => (
                  <span className="card-chip" key={`${player}-${card}`}>
                    {card}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>

        <div className="status-strip">
          <div>
            <p className="strip-label">Discard top</p>
            <strong>{sample.discardTop}</strong>
          </div>
          <div>
            <p className="strip-label">Valid set example</p>
            <strong>{sample.examples.set.kind}</strong>
          </div>
          <div>
            <p className="strip-label">Valid run example</p>
            <strong>{sample.examples.run.kind}</strong>
          </div>
        </div>
      </section>

      <section className="grid two-column">
        <article className="panel">
          <h2>Immediate next build steps</h2>
          <ul>
            {nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Key files</h2>
          <ul>
            <li><code>src/lib/rummy/*</code> for game rules and scoring.</li>
            <li><code>supabase/migrations/*</code> for additive schema changes only.</li>
            <li><code>supabase/functions/start-game</code> for server-authoritative round setup.</li>
          </ul>
        </article>
      </section>
    </main>
  );
}
