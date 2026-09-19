# Jeeva

An AI-assisted trading application that uses Jev (a TypeSafe "System One" decision model) to make buy/hold/sell calls on Hyperliquid perpetual futures, with a dashboard to control the trading engine.

## Language

**PERP**:
A perpetual futures market on Hyperliquid (e.g. BTC-PERP). Each PERP has two independent switches: **trading enabled** (whether the decision loop consults Jev and places/mock-places orders for it) and **sampling enabled** (whether the market-data loop records its price/OI/volume/spread history). A PERP can be sampled without trading, or (less usefully) traded without a sampling history.

**Jev**:
The TypeSafe System One model that answers structured questions (Choice/Score/Noul) against a text `state`, used here to decide buy/hold/sell. Not a chat/agent loop — a single evaluation call.
_Avoid_: "the AI", "the model" (ambiguous with other models in the system)

**JevDecisionSource**:
The interface for obtaining a trading decision from Jev. Has two implementations: `FakeJevAdapter` (synthetic decisions, for testing without Jev access) and `RealJevAdapter` (calls the real TypeSafe API).
_Avoid_: "mock Jev" (reserve "mock" for the execution axis, see ExecutionAdapter)

**ExecutionAdapter**:
The interface for placing/simulating orders against Hyperliquid. Has two implementations: `MockExecutionAdapter` (simulates fills locally, never touches the real orderbook) and `LiveExecutionAdapter` (places real orders via a Hyperliquid wallet).
_Avoid_: "fake execution" (reserve "fake" for the decision axis, see JevDecisionSource)

These two adapters are independent axes — decision source and execution path can be toggled separately, e.g. RealJev decisions against MockExecution for paper-trading with real intelligence.

**Target Direction**:
Jev's decision output for a PERP: one of `long`, `short`, or `flat`. Represents the position direction the engine should be in after this cycle, not a raw action.
_Avoid_: buy, sell, hold — these imply actions rather than target state, and are not used anywhere in this system.

**Position State**:
A PERP's current position, one of `flat | long | short`. Driven purely by the latest Target Direction: a change from `long`→`short` or `short`→`long` closes the existing position and opens the opposite one (no pyramiding — repeating the same direction is a no-op).

**Mock Wallet**:
A persistent virtual account used in mock mode, configured once with an initial balance when created. Shared across all trading-enabled PERPs (one margin pool), and simply accumulates decision/position/P&L history over time — there is no "session" start/stop concept; enabling trading on a PERP just adds it to the ongoing history.
_Avoid_: session, mock session — trading is enabled/disabled per PERP, not started/stopped as a session.
