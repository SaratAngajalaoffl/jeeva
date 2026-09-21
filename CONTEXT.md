# Jeeva

An AI-assisted trading application that uses a DecisionMaker backed by Jev (a TypeSafe "System One" decision model) to choose a target direction (long/short/flat) on Hyperliquid perpetual futures, with a dashboard to control the trading engine.

## Language

**PERP**:
A perpetual futures market on Hyperliquid (e.g. BTC-PERP). Each PERP has two independent switches: **trading enabled** (whether the decision loop consults its configured DecisionMaker and places/mock-places orders for it) and **sampling enabled** (whether the market-data loop records its price/OI/volume/spread history). Sampling runs independently of trading, so a PERP can be sampled without trading; the reverse is prevented — enabling trading for a market automatically enables sampling for it too, so no market is ever traded blind. A PERP's **decision maker** (see DecisionMaker) is a third, independent per-PERP setting, chosen when trading is enabled.

**Jev**:
The TypeSafe System One model that answers structured questions (Choice/Score/Noul) against a text `state`, used here to decide the target direction. Not a chat/agent loop — a single evaluation call. Reachable through more than one DecisionMaker backend (see DecisionMaker).
_Avoid_: "the AI", "the model" (ambiguous with other models in the system)

**DecisionMaker**:
The interface for obtaining a trading decision. Chosen per PERP (`PerpConfig.decisionMaker` / `perpConfigs.decisionMaker`), independent of the PERP's ExecutionAdapter/mock-live axis. Three implementations:
- `RandomDecisionMaker` — synthetic decisions, for testing without Jev access.
- `TypeSafeJevDecisionMaker` — calls TypeSafe's real Jev `systemOne` API directly.
- `OpenRouterJevDecisionMaker` — calls Jev via OpenRouter (`openrouter.ai/~typesafe/jev-latest`) instead of TypeSafe directly, using `OPENROUTER_API_KEY`.

_Avoid_: "mock Jev" or "mock decision maker" (reserve "mock" for the execution axis, see ExecutionAdapter); "JevDecisionSource" (old name, renamed to DecisionMaker since Jev is now reachable through more than one backend).

**ExecutionAdapter**:
The interface for placing/simulating orders against Hyperliquid. Has two implementations: `MockExecutionAdapter` (simulates fills locally, never touches the real orderbook) and `LiveExecutionAdapter` (places real orders via a Hyperliquid wallet).
_Avoid_: "fake execution" (reserve "fake" for the decision axis, see DecisionMaker)

DecisionMaker and ExecutionAdapter are independent axes — decision maker and execution path can be toggled separately, e.g. TypeSafeJevDecisionMaker decisions against MockExecution for paper-trading with real intelligence.

**Target Direction**:
Jev's decision output for a PERP: one of `long`, `short`, or `flat`. Represents the position direction the engine should be in after this cycle, not a raw action.
_Avoid_: buy, sell, hold — these imply actions rather than target state, and are not used anywhere in this system.

**Position State**:
A PERP's current position, one of `flat | long | short`. Driven purely by the latest Target Direction: a change from `long`→`short` or `short`→`long` closes the existing position and opens the opposite one (no pyramiding — repeating the same direction is a no-op).

**Mock Wallet**:
A persistent virtual account used in mock mode, configured once with an initial balance when created. Shared across all trading-enabled PERPs (one margin pool), and simply accumulates decision/position/P&L history over time — there is no "session" start/stop concept; enabling trading on a PERP just adds it to the ongoing history.
_Avoid_: session, mock session — trading is enabled/disabled per PERP, not started/stopped as a session.
