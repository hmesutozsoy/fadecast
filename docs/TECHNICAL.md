# FadeCast, Technical Documentation

## Core idea

In-play betting markets systematically **overreact to goals**: prices jump past
fair value on the news, then mean-revert over the next few minutes. FadeCast is
an autonomous agent that detects that overreaction in TxLINE's live odds,
trades against it ("fades" it), and, the novel part, **commits every call to
Solana before the market resolves it**. The agent's win rate is therefore
cryptographically auditable: it cannot cherry-pick wins or delete losses. The
losses are on-chain next to the wins.

## Pipeline

```
TxLINE SSE (odds + scores) ─┐
                            ├─► OvershootEngine ──signal──► Solana devnet memo
Replay / JSONL adapters ────┘         │                     (hash committed pre-resolution)
                                      ▼
                       HTTP + SSE server ──► dashboard (panic meters, swipe
                       cards, pundit commentary, timeline scoring, duel)
```

## Strategy (lib/overshoot.js)

Online port of an offline overshoot analyzer validated on real in-play data:

| Rule | Value | Why |
|---|---|---|
| Jump detection | ≥ 6 prob-points inside 45 s, 120 s debounce | a goal *is* the jump, no separate event feed needed |
| Tradeable band | 0.08 – 0.92 | at the probability boundary there is no room to revert; spread eats the edge |
| Confirmation entry | no new extreme for 45 s | never catch the falling knife mid-cascade |
| Hold | 240 s | the measured reversion horizon |
| Stop-loss | 7 prob-points | a second goal inside the hold (a real comeback) is the tail risk, cut it |
| Costs | 0.5 c half-spread crossed on both legs | the edge is spread-dependent; this is an explicit, tunable assumption |

Backtested on replays of six real 2022 World Cup matches (real goal minutes,
scorers, and results; modeled price paths): ~80 % win rate with small wins and
two honest stopped losses on the Saudi-Arabia and Japan–Spain comebacks.

## TxLINE endpoints used

| Endpoint | Use |
|---|---|
| `POST {origin}/auth/guest/start` | guest JWT (first auth factor) |
| on-chain `subscribe` (txoracle program) + `POST /api/token/activate` | free-tier API token (second auth factor), see `scripts/subscribe.js` |
| `GET /api/fixtures/snapshot` | fixture metadata on connect |
| `GET /api/odds/snapshot/{fixtureId}` | warm-up state |
| `GET /api/odds/stream` (SSE) | StablePrice odds → de-vigged implied probability → panic detection input |
| `GET /api/scores/stream` (SSE) | goal events → dashboard timeline + commentary |
| `GET /api/odds|scores/updates/...` (historical) | replay & backtesting path |
| Validation proofs | referenced in each on-chain commitment so input data and decisions share an audit trail |

Networks: devnet by default (`https://txline-dev.txodds.com`, program
`6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`), mainnet supported via
`TXLINE_NETWORK=mainnet`.

## Solana integration

- Every fade signal is published as a **Memo-program transaction on devnet**
  carrying the signal's compact JSON + a SHA-256 hash of the full signal
  object, timestamped *before* the signal resolves.
- Faucet failures degrade gracefully: commitments queue and flush on a 45 s
  retry loop; the dashboard links each signal to Solana Explorer.
- The free-tier data subscription itself is an on-chain transaction
  (TxLINE's txoracle program), see `scripts/subscribe.js` for the full
  subscribe → sign → activate flow.
- Scale path: batch a window of signals into one transaction carrying a Merkle
  root, same auditability at 1/N fees.

## Technical highlights

- **Zero-framework Node** (one runtime dependency: `@solana/web3.js`); SSE
  fan-out to any number of dashboard viewers from one engine.
- **Bounded memory**: tick and signal history trimmed to what the strategy
  actually needs, so live mode runs indefinitely.
- **Market-agnostic core**: any `(market, outcome, price, ts)` series works.
  `MODE=follow` tails a JSONL file, elections, crypto, esports plug in with
  zero engine changes. `POST /api/takes` ingests social posts for the
  fade-your-timeline layer.
- **Replay-on-demand**: any real match replays from one JSON entry
  (`GET /api/replay?match=<id>&speed=N`), deterministic, demo-safe, and the
  product's onboarding.
- **Human layer**: swipeable signal cards (you vs the bot), an AI pundit with
  template fallback (optional live Claude generation), and per-account
  "Most Fadeable" scoring of timeline takes.

## Business highlights

- **Verifiable track records are the product.** Every tipster, trading bot and
  AI agent has the same credibility problem; the commit-before-resolution rail
  generalizes into a "proof-of-call" standard any predictor can publish
  through. FadeCast is the first client and showcase.
- **Consumer surface without wallet friction**: spectators play against the
  bot in one gesture; the leaderboard of fadeable accounts is inherently
  shareable content.
- **Every market is the same pipeline**: TxLINE's 1000+ paid-tier leagues, and
  non-sports probability markets, are just more series keys.
