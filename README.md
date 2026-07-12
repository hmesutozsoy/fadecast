# FadeCast ⚡

**The AI pundit that can't lie about its record.**

An autonomous agent that trades *market panic* during World Cup matches — and
commits every call to Solana **before** it resolves, so its track record is
cryptographically auditable. No cherry-picking, no deleted bad calls.

Built for the Superteam MY × TxOdds World Cup Hackathon (track: **trading tools
and agents**).

## The idea

When a goal goes in, in-play win probabilities don't just reprice — they
**overshoot** and then mean-revert over the next few minutes. We measured this
on real in-play World Cup data before building FadeCast (see
[the offline analyzer](https://github.com/) heritage in `lib/overshoot.js`).
The overreaction itself is the tradeable signal.

FadeCast:

1. **Streams TxLINE StablePrice odds + score events** (SSE) and converts them
   to de-vigged implied probabilities.
2. **Detects panic**: a jump ≥ 6 probability points inside 45 s. Each match gets
   a live *Panic Meter* (calm → stirring → overheating → PANIC).
3. **Fires a fade signal** — sell the spike / buy the crash — and immediately
   **publishes a commitment to Solana devnet** (Memo program): signal ID, side,
   prices, panic score, and a SHA-256 hash of the full signal object.
4. **Resolves the signal** 5 minutes later against the live price stream and
   marks its own P&L. Wins *and* losses are on-chain forever.

The dashboard shows the live odds, panic meters, signal feed with
`verify ↗` explorer links, the agent's cumulative record — and **The Pundit**,
FadeCast's live commentary voice. It reacts to goals, narrates each fade with
its reasoning, gloats on wins, and owns its losses (which are on-chain anyway,
so it has no choice). Commentary is template-driven by default so the demo
never depends on a network call; set `ANTHROPIC_API_KEY` and every line is
generated live by Claude (`PUNDIT_MODEL` to override, defaults to
`claude-opus-4-8`), falling back to templates on any error.

## Why on-chain commitment matters

Every "AI trading guru" screenshot you've ever seen is survivorship bias.
FadeCast's wallet is its reputation: each signal is timestamped on Solana
*before the market resolves it*, so anyone can reconstruct the exact track
record from the chain and integrity-check it against the off-chain data via the
memo hash. TxLINE's validation proofs anchor the *input* data on-chain;
FadeCast anchors the *decisions*.

## Swipe the panic — you vs the bot

Every signal also lands as a **swipeable card**: drag right to *Fade with the
bot*, left to *Ride the wave* with the crowd. When the signal resolves, the
**You vs the bot** scoreboard settles who read the market better. No wallet,
no stake, no onboarding — anyone watching a match can play against the agent
in one gesture. (Too slow to swipe? The market doesn't wait, and neither does
the card.)

## Real matches

Replay mode runs **real FIFA World Cup 2022 fixtures** from
[data/matches.json](data/matches.json) — actual goal minutes, scorers, and
results: Argentina 1–2 Saudi Arabia (the canonical market-panic event),
Germany 1–2 Japan, Japan 2–1 Spain, and the Argentina–France final. The goals
are history; the price path between them is modeled from those events, and is
replaced by genuine recorded TxLINE ticks the moment you run `MODE=record`
during a live match (replay auto-prefers a recording).

## Not just football

The detector is market-agnostic: it consumes any probability series and trades
the overreaction. The tick contract is one JSON object:

```json
{"fixtureId": "btc-100k-by-dec", "outcome": "yes", "price": 0.62, "ts": 1752300000, "meta": {"label": "BTC $100k by Dec"}}
```

`MODE=follow FILE=feed.jsonl` tails any file of those lines — a crypto
prediction market, an election market, esports win probability — and the whole
pipeline (panic meter, fade signals, on-chain commitments, the Pundit, swipe
cards) works unchanged. World Cup is the launch vertical, not the product.

## Running it

```bash
npm install
npm run replay     # real WC2022 matches at 25x speed (default)
npm run live       # real TxLINE streams (requires activation, below)
MODE=follow FILE=feed.jsonl npm start   # any market, via JSONL ticks
```

Dashboard: http://localhost:4747

Env knobs: `PORT`, `SPEED` (replay acceleration), `PUBLISH=0` (skip on-chain
writes), `TXLINE_NETWORK=mainnet|devnet`, `ANTHROPIC_API_KEY` (live Pundit).

### Live mode: TxLINE free-tier activation

TxLINE's World Cup free tier is subscribed **on-chain** (no TxL payment; SOL
fees only):

```bash
# 1. start the server once — it generates data/wallet.json and prints the address
npm start
# 2. fund that address with devnet SOL: https://faucet.solana.com
# 3. drop the devnet txoracle IDL (from TxLINE's runnable examples) at scripts/idl/txoracle.json
npm run subscribe   # on-chain subscribe -> guest JWT -> sign -> activate
npm run live
```

`MODE=record` runs live mode while appending every normalized tick to
`data/recording.jsonl`; replay mode automatically prefers a recording over the
synthetic matches — record a real match once, demo it forever.

## TxLINE endpoints used

| Endpoint | Use |
|---|---|
| `POST /auth/guest/start` | guest JWT |
| on-chain `subscribe` + `POST /api/token/activate` | free-tier API token |
| `GET /api/fixtures/snapshot` | fixture metadata |
| `GET /api/odds/stream` (SSE) | StablePrice odds → panic detection input |
| `GET /api/scores/stream` (SSE) | goal events annotating the timeline |
| `GET /api/odds/snapshot/{fixtureId}` | warm-up state on connect |

## Architecture

```
TxLINE SSE ──┐
             ├─> OvershootEngine ──signal──> SignalPublisher ──memo tx──> Solana devnet
Replay src ──┘        │                            │
                      └──ticks/signals──> HTTP+SSE server ──> dashboard
```

- `lib/overshoot.js` — online port of a batch overshoot analyzer validated on
  real in-play data: jump detection (lookback/threshold/debounce), overshoot
  tracking, entry/exit pricing with spread crossing. Three risk rules learned
  from replaying real comebacks: only fade inside the 0.08–0.92 band (no
  reversion room at the boundary), enter only after the cascade stops making
  new extremes (never catch the falling knife), and a stop-loss for when the
  "panic" turns out to be a comeback.
- `lib/txline.js` — auth, snapshots, SSE client, tick normalization (de-vig),
  recorder.
- `lib/replay.js` — deterministic fair-value + decaying-overshoot match
  simulator, or recorded-tick playback. Same event shape as live.
- `lib/solana.js` — Memo-program commitments with graceful faucet-failure
  queueing and periodic flush.
- `lib/pundit.js` — commentary engine: deterministic templates, optionally
  upgraded to live Claude-generated lines (raw fetch, no SDK, hard fallback).
- `server.js` — wiring + dashboard host. No frameworks; Node stdlib + `@solana/web3.js`.

## How it scales

- **Replay is the onboarding.** Any historical match is one JSON entry in
  `data/matches.json`; the header picker replays it on demand
  (`GET /api/replay?match=<id>&speed=N`). A library of history's great market
  panics — every famous collapse becomes shareable, replayable content.
- **The detector shards by series.** Each `(market, outcome)` series is
  independent state with bounded memory (ticks and signals are trimmed; the
  strategy only ever looks back `lookback + confirm + hold` seconds). N markets
  = N tiny state machines; shard them across workers by market id with no
  coordination needed.
- **One engine, many viewers.** The dashboard is a broadcast: a single
  detector fans out over SSE to any number of spectators (swap in Redis
  pub/sub for multi-instance fan-out). Everyone watches the same panic
  together — watch-party semantics by design.
- **On-chain commitments batch.** Per-signal memo transactions are perfect for
  the demo; at volume, batch a window of signals into one transaction carrying
  a Merkle root of their hashes — same auditability, 1/N the fees.
- **Any market, same pipeline.** TxLINE's paid tiers expose 1000+ leagues —
  every one of them is just more series keys. And the `MODE=follow` adapter
  means non-sports probability markets (elections, crypto, esports) plug in
  with zero engine changes.

## Honest limitations

- Free-tier devnet odds coverage can be sparse outside match windows — the
  replay path exists precisely so judges can see the full loop anytime.
- Signal P&L is marked against TxLINE mid prices with an assumed half-spread;
  it is a strategy *telemetry* number, not an executed-fill number.
- One market per fixture (home win) in v0; the engine is series-keyed and
  extends to draw/away/props by adding outcomes.
