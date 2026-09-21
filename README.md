<div align="center">
  <img src="./docs/assets/logo.svg" alt="Jeeva" height="72">

  <p><strong>AI-assisted trading for Hyperliquid perpetual futures.</strong></p>

  [![CI](https://github.com/SaratAngajalaoffl/jeeva/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SaratAngajalaoffl/jeeva/actions/workflows/ci.yml)
  [![Publish images](https://github.com/SaratAngajalaoffl/jeeva/actions/workflows/publish.yml/badge.svg?branch=main)](https://github.com/SaratAngajalaoffl/jeeva/actions/workflows/publish.yml)
  [![Node](https://img.shields.io/badge/node-20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
  [![Rust](https://img.shields.io/badge/rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
  [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
</div>

A modular trading engine, initially built to test trading with Jev. But turned out to be a pretty useful tool that can be extended with other algorithm's for Mid-Frequency trading.

A dashboard lets you turn markets on/off, tune how often and how aggressively each one trades, choose which decision engine drives it, and watch the resulting decisions, positions, and P&L in real time.

## What it does

- **Tracks markets.** For every Hyperliquid PERP you enable sampling on, Jeeva continuously records price, open interest, volume, and spread. Samples older than the market-data TTL (7 days by default, `MARKET_DATA_TTL_DAYS`) are pruned automatically, so history doesn't grow unbounded.
- **Makes trading decisions.** For every PERP you enable trading on, Jeeva periodically builds a summary of recent market conditions and asks a **DecisionMaker** for a target direction: `long`, `short`, or `flat`.
- **Executes the decision.** If the target direction differs from the current position, Jeeva closes/opens the position accordingly. Nothing happens if the target direction is unchanged (no re-buying, no pyramiding).
- **Trades safely by default.** New markets and a fresh deployment always start in **mock** mode against a simulated wallet. Real Hyperliquid orders only happen once you explicitly flip a market-wide switch to **live** *and* the engine has real wallet credentials configured.
- **Protects itself.** If a PERP's decision cycle fails five times in a row (bad data, a down decision API, a broken order, etc.), Jeeva force-flattens that PERP's position rather than leaving it in an unmanaged state.

## Architecture

```mermaid
flowchart LR
    subgraph Browser
        FE["Next.js Dashboard\n(frontend/)"]
    end

    subgraph API["Express API (api/)"]
        REST["REST endpoints\n/perps, /engine-mode,\n/decisions, /positions ..."]
    end

    subgraph Engine["Rust Trading Engine (engine/)"]
        SUP["Decision Supervisor\none task per trading-enabled PERP"]
        DM["DecisionMaker\n(Fake / TypeSafe Jev / OpenRouter Jev)"]
        EXEC["ExecutionAdapter\n(Mock or Live)"]
        SAMP["Market-Data Sampler"]
    end

    Mongo[("MongoDB\nperpConfigs, engineConfig\n(watched live via change streams)")]
    PG[("TimescaleDB / Postgres\nmarket data, decisions,\npositions, funding history")]
    HL["Hyperliquid\n(market data + order API)"]
    Jev["Jev\n(TypeSafe System One model,\ndirect or via OpenRouter)"]

    FE <--> REST
    REST -->|read/write PERP & mode config| Mongo
    REST -->|read history for charts| PG
    Mongo -->|change streams,\nno restart needed| SUP
    Mongo --> SAMP
    SUP --> DM
    DM -->|market state summary| Jev
    Jev -->|target direction| DM
    SUP --> EXEC
    EXEC -->|mock: simulate fill| PG
    EXEC -->|live: real order| HL
    SAMP -->|price / OI / volume / spread| HL
    SAMP --> PG
    SUP -->|decision log, health| PG
```

**frontend/** — the operator dashboard (Next.js). Lists markets, shows live price/positions/health, and is where you enable trading/sampling per PERP, pick a PERP's decision maker, and flip the engine between mock and live execution. Its API URL is resolved at runtime from the container's `API_URL` (served to the browser from `/runtime-config`), so one built image can be reused across instances pointing at different API backends.

**api/** — a small Express service that mediates between the dashboard and the shared state: PERP configuration and engine mode live in MongoDB; market data, decisions, positions, and funding history live in TimescaleDB (used as plain Postgres).

**engine/** — the always-running Rust process that actually trades. It watches MongoDB for configuration changes and, for every PERP with trading enabled, runs an independent loop on that PERP's configured frequency. Nothing here requires a restart to pick up a config change (enabling a market, changing its frequency/leverage/decision maker, flipping mock/live) — every loop iteration reads the latest config fresh.

## The decision cycle

Each tick of a trading-enabled PERP's loop does the following, in order:

1. **Read recent market history** for that PERP (up to the last 1000 samples) from TimescaleDB.
2. **Read the current position** (flat/long/short) from the configured `ExecutionAdapter`.
3. **Summarize state and ask the DecisionMaker** for a target direction (see [What Jev sees](#what-jev-sees) below).
4. **Diff target vs. current position**:
   | Current | Target | Action |
   |---|---|---|
   | flat | long/short | open |
   | long/short | flat | close |
   | long | short (or vice versa) | close, then open the opposite side |
   | long/short | same direction | no-op (no pyramiding) |
5. **Apply the action** through the `ExecutionAdapter` — a simulated fill in mock mode, a real signed Hyperliquid order in live mode.
6. **Log the cycle** (context, decision, action taken, any error) so every tick is auditable from the dashboard, even ticks that fail.

A run of 5 consecutive failures on any step (market data, decision maker, or execution) auto-flattens that PERP's position as a safety net.

## What Jev sees

Jev never sees raw database rows — the engine builds a compact text summary of everything relevant and asks a single structured **Choice** question (`long` / `short` / `flat`). For example, the `state` text sent looks like:

```
BTC: price=64213.50 (change over last 1000 samples: +1.84%, min=62900.10, max=64580.00, avg=63750.22),
open_interest=182340.00 (min=178000.00, max=185200.00, avg=181500.00),
volume=942310.00 (min=810000.00, max=1050000.00, avg=925000.00),
spread=0.0120 (min=0.0080, max=0.0210, avg=0.0130),
mid_price=64214.00;
position=long (opened_at=2026-09-19T18:02:11Z, held_for_minutes=42.0, entry_price=63800.00, notional_usd=1000.00, unrealized_pnl_usd=+6.48);
funding_rate=0.000031 (as_of=2026-09-19T18:00:00Z)
```

That's: the latest price plus min/max/average over the whole sampled window, the same stats for open interest/volume/spread, the current position (or `flat`) with how long it's been held and its unrealized P&L, and the most recent real funding rate. Jev responds with a choice (`long`/`short`/`flat`), a confidence, and a probability for each of the three outcomes — all of which get written to the decision log.

## DecisionMaker: three ways to reach Jev (or not)

Every PERP picks its own decision maker independently of every other PERP, and independently of the mock/live execution switch:

| DecisionMaker | What it does |
|---|---|
| **Fake** | No network calls — cycles through synthetic decisions. The default, safe for a fresh deployment or local development with no external credentials. |
| **TypeSafe Jev** | Calls TypeSafe's `systemOne` API directly, authenticated with `TYPESAFE_API_KEY`. |
| **OpenRouter Jev** | Reaches the same Jev model via OpenRouter instead of TypeSafe directly, authenticated with `OPENROUTER_API_KEY`. |

Because decision maker and execution mode are independent axes, you can, for example, run TypeSafe Jev's real decisions against the mock execution wallet — paper-trading with real intelligence, no funds at risk.

## Mock vs. live execution

Execution mode is engine-wide (not per PERP) and stored in MongoDB, so switching it from the dashboard takes effect on the very next decision cycle for every trading-enabled PERP — no restart.

- **Mock** (default): simulates fills against a shared virtual wallet in TimescaleDB. Never touches the real orderbook.
- **Live**: places real signed orders against Hyperliquid using a configured wallet private key. If no key is configured, switching to live fails loudly on every call instead of silently doing nothing.

## Safety mechanisms

- Fresh deployments and fresh PERPs default to mock execution and the Fake decision maker — nothing trades for real until you explicitly opt in.
- Opening a trading session for a market automatically enables sampling for it too (you can't trade blind); disabling sampling automatically disables trading.
- Deployments can enforce a floor on how fast markets may be sampled (`MIN_SAMPLING_FREQUENCY_SECONDS`) and a ceiling on how much history is kept (`MARKET_DATA_TTL_DAYS`).
- 5 consecutive decision-cycle failures auto-flattens that PERP's position.
- Every decision cycle — successful or failed — is written to an audit log visible in the dashboard.

## Getting started

```bash
cp .env.example .env   # set AUTH_USERNAME / AUTH_PASSWORD / JWT_SECRET
docker compose up --build
```

This starts MongoDB (as a single-node replica set, required for the config change streams), TimescaleDB, a one-off `migrate` service that applies the Postgres schema via [node-pg-migrate](https://github.com/salsita/node-pg-migrate) before anything else starts, the API on `:4000`, the engine, and the dashboard on `:3000`. With no further configuration, every PERP you enable defaults to mock execution and the Fake decision maker, so you can explore the whole flow with no external credentials.

Postgres schema is owned entirely by the migrations in `api/migrations/` — neither the API nor the engine create or alter tables at runtime. To change the schema, add a migration with `npm run migrate create <name> --workspace=api` and run it with `npm run migrate up --workspace=api` (reads `DATABASE_URL` from the environment).

To use real Jev decisions or real Hyperliquid execution, set the corresponding engine environment variables before enabling them from the dashboard:

| Variable | Needed for |
|---|---|
| `TYPESAFE_API_KEY` (+ optional `TYPESAFE_BASE_URL`) | TypeSafe Jev decision maker |
| `HYPERLIQUID_PRIVATE_KEY` (+ optional `HYPERLIQUID_TESTNET`) | Live execution |
| `API_URL` | Dashboard → API base URL, read at container start (multi-instance deploys) |
| `CORS_ORIGIN` | Origin(s) allowed to call the API, comma-separated for several dashboards |
| `MARKET_DATA_TTL_DAYS` | Sampled-data retention, in days (default `7`) |
| `MIN_SAMPLING_FREQUENCY_SECONDS` | Lowest sampling frequency the API will accept, in seconds (default `1`) |

See [`CONTEXT.md`](./CONTEXT.md) for the project's internal glossary and naming conventions.

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the dev workflow, lint/test commands, and PR guidelines.

## License

MIT — see [`LICENSE`](./LICENSE).
