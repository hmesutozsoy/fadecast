# FadeCast, Technical Documentation

Live: https://fadecast.onrender.com · Repo: https://github.com/hmesutozsoy/fadecast

## Core idea

In-play betting markets systematically overreact to goals: prices jump past
fair value on the news, then mean-revert over the following minutes. FadeCast
is an autonomous agent that detects that panic in live odds, trades it on
Polymarket (against it or with it, the operator picks a side), and commits
every call to Solana **before the market resolves it**. The same notarization
is applied to real predictors' tweets: their calls are hashed on-chain
pre-match, settled at full time, and ranked on a leaderboard nobody can edit
after the fact. Wins and losses sit on-chain next to each other, for the bot
and for the humans.

## Architecture

```
data rails                     engine                       rails out
──────────                     ──────                       ─────────
TxLINE SSE (odds/scores) ──┐
Polymarket CLOB (3s book) ─┼─► OvershootEngine ──signals──► PolymarketExecutor
real 2026 tapes (replay) ──┘        │                       (paper | live orders)
                                    │
real X posts + match events ──► Crowd (takes, verdicts,     SignalPublisher
(data/posts.json, events.json)  leaderboard)           ──►  (Solana devnet memos,
                                    │                       commit cache)
                                    ▼
                     HTTP + SSE server ─► single-page dashboard
                     (charts, timeline, leaderboard, proof panel, trading)
```

One Node process, no framework, no database. Session state is in memory; the
chain is the durable record.

## Data sources (`MODE` env)

- **replay** (default): real Polymarket price tapes of all six WC2026
  quarterfinals and semifinals (1-minute bars, `data/tapes.json`, self-fetched
  at boot), overlaid with the real match events (`data/events.json`, sourced
  from ESPN/FIFA/CNN/Al Jazeera) and real predictors' posts
  (`data/posts.json`). Modeled 2022 fixtures remain as an offline fallback.
- **live / record**: TxLINE StablePrice SSE streams normalized to de-vigged
  implied probabilities; `record` also captures ticks to disk, and replay
  auto-prefers a recording.
- **poly**: Polymarket CLOB order-book polling (3 s, mid + spread) for any
  market by slug. The dashboard's Live mode uses this path.
- **follow**: tails a JSONL file of `{fixtureId, outcome, price, ts}` ticks.
  Any probability series works; the World Cup is the launch vertical, not the
  ceiling.

## Strategy (`lib/overshoot.js`)

| Rule | Default | Why |
|---|---|---|
| Jump detection | ≥ 6 prob-points inside 45 s, 120 s debounce | a goal is the jump; no separate event feed needed |
| Confirmation entry | no new extreme for 45 s | never catch the falling knife mid-cascade |
| Tradeable band | 0.08 to 0.92 | at the boundary there is no room to revert; spread eats the edge |
| Hold | 240 s | the measured reversion horizon |
| Stop-loss | 7 prob-points | a real comeback is the tail risk; cut it, log it, chain it |
| Side | `fade` or `ride` | see the backtest below |
| Costs | 0.5 c half-spread on both legs | the edge is spread-dependent; explicit and tunable |

Every parameter is operator-tunable from the UI. In replay it restarts the
session; in live mode `/api/strategy` retunes the running engine in place.

**The honest backtest** (`npm run backtest`): across all 101 completed WC2026
matches (1-minute bars, identical 179 signals), FADE lost $66.66 at a 22% win
rate while RIDE made $21.73 at 37%. The 2026 in-play market under-reacts at
minute scale; momentum beat mean-reversion. That finding is in the product:
you pick the side, the chain keeps your score either way.

## Execution (`lib/polymarket.js`)

Binary CLOBs have no shorting, so fading a spike = BUY NO and fading a crash =
BUY YES; exits sell the held token.

- **paper** (default): fills simulated at the real book's touch.
- **live**: real orders via `@polymarket/clob-client` (FAK for entries and
  exits, GTC for maker quotes). Tick size and neg-risk flags are read from the
  market metadata, never hardcoded. Arming requires the operator's own key,
  entered only on their own instance (`ALLOW_KEY_ENTRY=1` off-localhost); the
  key lives in process memory only and a restart reverts to paper.
- **Risk controls**: per-signal notional, max concurrent exposure, and a
  realized-loss kill switch that disarms the bot by itself.
- **Market maker**: quotes mid ± spread/2 with per-side inventory caps, and
  pulls both quotes the instant the fade engine fires a panic signal. The
  overshoot detector doubles as the market maker's risk radar.

## Notarization (`lib/solana.js`)

Every signal and every scored take becomes a Memo-program transaction on
Solana devnet carrying compact JSON plus a SHA-256 hash of the full object,
timestamped before resolution. A content-keyed commit cache
(`data/commits.json`, checked into the repo) guarantees one receipt per unique
call forever: replaying a match reuses the original transaction instead of
re-notarizing. Open calls (four real posts calling the final were committed
nine hours before kickoff) get a second receipt when their verdict settles;
the pre-match timestamp is the proof. Failed sends queue and flush on a retry
loop.

The dashboard's Proof panel reads `getSignaturesForAddress` directly from
Solana RPC in the browser: the audit trail comes from the chain, not from our
server.

## The timeline and leaderboard (`lib/crowd.js`)

Real X posts (each verified by loading the status page; follower counts read
from the profiles) enter as `stance: "call"` takes with the status URL as the
receipt. Tape replays drop them pre-match and settle them at full time; the
leaderboard counts only settled calls, so an open call never reads as "100%
right". Any X account can be added to the tracked watchlist;
`POST /api/takes` is the ingestion contract for a scout (X API, Apify, or
manual curl).

## TxLINE endpoints used

| Endpoint | Use |
|---|---|
| `POST {origin}/auth/guest/start` | guest JWT (first auth factor) |
| on-chain `subscribe` (txoracle program) + `POST /api/token/activate` | free-tier API token (second auth factor), see `scripts/subscribe.js` |
| `GET /api/fixtures/snapshot` | fixture metadata on connect |
| `GET /api/odds/snapshot/{fixtureId}` | warm-up state |
| `GET /api/odds/stream` (SSE) | StablePrice odds, de-vigged into the panic detector |
| `GET /api/scores/stream` (SSE) | goal events for the timeline |
| `GET /api/odds|scores/updates/...` (historical) | replay and backtesting path |
| Validation proofs | referenced in commitments so input data and decisions share an audit trail |

Networks: devnet by default (`https://txline-dev.txodds.com`, program
`6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`), mainnet via
`TXLINE_NETWORK=mainnet`.

## Scaling notes

Single-room watch-party semantics by design (every viewer sees the same
session). The scale path: shard by series, fan out SSE via Redis, and batch
commitments into Merkle roots (one transaction per window anchoring thousands
of calls, same auditability at 1/N fees).

## Security model

- The agent's Solana wallet signs memos only and holds devnet SOL.
- Trading keys are operator-supplied, memory-only, per-instance, and the input
  field clears after arming; `/api/state` exposes booleans and an abbreviated
  funder address, never key material.
- `data/wallet.json` and TxLINE credentials are gitignored; deploys use a
  `WALLET_SECRET` env var or a Render Secret File.

## Business case

Verifiable track records are the product. Every tipster, trading bot, and AI
agent has the same credibility problem; commit-before-resolution generalizes
into a proof-of-call rail any predictor can publish through. FadeCast is the
first client and the showcase: the bot trades it, the leaderboard socializes
it, and every market (TxLINE's 1000+ paid-tier leagues, elections, crypto) is
just another series key on the same pipeline.
