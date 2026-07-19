# FadeCast ⚡

**Talk is cheap. Receipts are forever.**

**Live:** [fadecast.onrender.com](https://fadecast.onrender.com) · built for the
Superteam MY × TxODDS World Cup Hackathon

An autonomous agent that trades **market panic** in live World Cup betting
markets — and notarizes every call on Solana **before it resolves**. Not just
its own calls: real predictors' tweets get the same treatment. Their predictions
are hashed and committed pre-match, settled at full time, and ranked on a
leaderboard nobody can retroactively edit. No cherry-picking, no deleted bad
takes — for the bot *or* the humans.

## The receipts (click these)

Four real X posts calling tonight's **Spain–Argentina final**, committed to
devnet at 09:55 UTC — nine hours before kickoff:

- [@actuallyimthe's prophecy](https://x.com/actuallyimthe/status/1414366007888650241) —
  *"Argentina just beat Spain at the 2026 World Cup final, 3-2."* Posted
  **July 11, 2021**, five years early, 285K likes →
  [devnet commitment](https://explorer.solana.com/tx/2qpPuUHY7h5J9RPkEVBWEy7FCzEmQJsHExA3XNR18JzR4EY1REhtZZSLzwV4x29zaApcThqtS34EeZH83GbCdL1G?cluster=devnet)
- [Drake's $5.1M Argentina bet](https://x.com/Stake/status/2078348767976362426)
  (via @Stake, 8.4M views) →
  [devnet commitment](https://explorer.solana.com/tx/4QhY4BwBDtW3VRQt59kMWwdKxXBoWkZ51K2EHVxJpQGDMDddgyQwiHpTN87RTiysLs9BdV8ty7CnBuc9W5gns9ic?cluster=devnet)
- [@tosinmm_'s "nastiest 1-0"](https://x.com/tosinmm_/status/2078617403404034524)
  (359K views) →
  [devnet commitment](https://explorer.solana.com/tx/34kLhT2MZw2Px5SiBWexfAE8FEE1a5cc1XnnqCMqzqNh1yop9ksLsXxTY7e9DUBVczT3nBqxYE3QU88z4kYAhtZf?cluster=devnet)
- [The agent's full record](https://explorer.solana.com/address/9tPbEJMTEkXafyUyEFSpndEJJP36BTSGuSXyhurEp8z7?cluster=devnet)
  — hundreds of fade calls and tweet verdicts, every one timestamped before
  resolution

When the whistle blows, the chain settles them. The prophecy either completes
its five-year arc or dies on-chain.

## How it works

1. **Live prices in** — TxLINE StablePrice streams (SSE, de-vigged implied
   probabilities) and Polymarket order books.
2. **Panic detected** — a jump ≥ 6 probability points in 45 s trips the panic
   meter (calm → stirring → overheating → PANIC).
3. **Trade it** — fade the overshoot or ride the momentum (your choice — see
   [the backtest](#fade-or-ride--pick-a-side-the-chain-keeps-score)) with real
   orders on Polymarket, capped by your allocation and a kill switch.
4. **Notarize it** — every signal and every scored tweet is committed to
   Solana (Memo program) with a SHA-256 hash *before* the market resolves, and
   the dashboard's Proof panel reads the record straight from the chain, not
   from our server.

## Why on-chain commitment matters

Every "AI trading guru" screenshot you've ever seen is survivorship bias.
FadeCast's wallet is its reputation: each call is timestamped on Solana
*before the market resolves it*, so anyone can reconstruct the exact track
record from the chain and integrity-check it against the off-chain data via
the memo hash. TxLINE's validation proofs anchor the *input* data on-chain;
FadeCast anchors the *decisions*.

## Fade your timeline — real predictors, real scores

The Timeline shows **real X posts** calling real matches — found, verified,
and linked (the handle opens the actual post). During the six real 2026
knockout replays their calls appear pre-match as they did in reality; at full
time each verdict lands (💀 was wrong / 😤 was right), is committed on-chain,
and feeds the **Leaderboard**: who actually gets it right, and who to fade.
Current standings from the quarterfinals and semifinals: an astrologer is
2-for-2, a betting-media brand with 252K followers is 0-for-1, and the viral
"FIFA script got leaked" thread (5.9M views) went 3-for-5.

Add any X account to the **＋track** watchlist and its posts flow through the
same pipeline via `POST /api/takes` — the ingestion contract for any scout
(X API, Apify, or manual).

## Real matches — the actual 2026 knockouts

Replays are **real Polymarket price tapes** of all six WC2026 quarterfinals
and semifinals (1-minute bars, fetched at boot into
[data/tapes.json](data/tapes.json)), overlaid with the real match events —
goals, red cards, penalty saves at their actual minutes
([data/events.json](data/events.json), sourced from ESPN/FIFA/CNN/Al Jazeera)
— and the real posts above ([data/posts.json](data/posts.json)). The modeled
2022 fixtures remain only as an offline fallback.

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

### Deploying with on-chain commits

The agent wallet lives at `data/wallet.json` locally. On ephemeral-disk hosts
(Render free tier), set `WALLET_SECRET` to the JSON array from that file and
`PUBLISH=1` — one persistent identity across deploys, and the queued-commit
retry loop does the rest once the wallet holds devnet SOL.

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

## Trade it for real — Polymarket

**🔴 Go live** points the engine at a real Polymarket market: the CLOB order
book streams in as ticks, and every fade routes to the venue
(`GET /api/poly/start?slug=<event-slug>&question=France`). Binary markets
can't short, so the executor maps the fade correctly: fading a spike buys NO,
fading a crash buys YES; exits sell the held token at the bid.

Three trade modes (`POLY_TRADE` env):

- `paper` (default) — fills simulated at the *live book's actual touch*,
  logged in the Trading panel with realized P&L. No keys, no risk.
- `live` — real orders via `@polymarket/clob-client`. Requires
  `POLY_PRIVATE_KEY` (your Polygon key, env only — never committed) and an
  explicit `POLY_TRADE=live`. `POLY_SIZE` sets USD per fade (default $5).
- `off` — signals only.

The engine's assumptions got *better* on the real venue: the France–Spain
semifinal book showed a 0.25c spread with six-figure depth — tighter than the
0.5c the strategy budgets for.

### Arming the bot (operator only)

Two chains, two jobs: **Solana devnet** is the proof rail (test SOL, real
timestamps); **Polygon** is the money rail (Polymarket, real USDC). Only the
Polygon side ever touches funds.

1. Export the **private key** of your Polymarket account — *never the seed
   phrase*. Email login: Polymarket → settings → Export private key
   (`POLY_SIGNATURE_TYPE=1`, and set `POLY_FUNDER` to your Polymarket deposit
   address). MetaMask login: export that account's key
   (`POLY_SIGNATURE_TYPE=2`, `POLY_FUNDER` = deposit address). Raw EOA
   trading: `POLY_SIGNATURE_TYPE=0`, no funder.
2. Set the environment **in your own shell** (or the host's env dashboard) —
   never in a file that gets committed, never in a chat:

```bash
POLY_TRADE=live \
POLY_PRIVATE_KEY=0x... \
POLY_SIGNATURE_TYPE=1 \
POLY_FUNDER=0xYourPolymarketAddress \
POLY_SIZE=5 POLY_MAX_EXPOSURE=15 POLY_MAX_LOSS=20 \
MODE=poly POLY_SLUG=fifwc-fra-esp-2026-07-14 POLY_QUESTION=France \
node server.js
```

Allocation controls: `POLY_SIZE` is USD per fade, `POLY_MAX_EXPOSURE` caps
concurrently open exposure, and `POLY_MAX_LOSS` is a **kill switch** — if
session losses reach it, the bot disarms itself and stops entering. Omit
`POLY_TRADE=live` and the same command runs the full session in paper mode.

## Fade or Ride — pick a side, the chain keeps score

The detector is side-agnostic: **Fade** trades against the panic (mean
reversion), **Ride** trades with it (momentum) — same signals, opposite bet.
Pick your side in the ⚙ Fade rules panel.

We backtested both, defaults and $5 clips, over the **real Polymarket price
history of all 101 completed WC2026 matches** (`npm run backtest`,
reproducible):

| strategy | trades | win rate | net |
|---|---|---|---|
| Fade | 179 | 22% | **−$66.66** |
| Ride | 179 | 37% | **+$21.73** |

At minute-scale, the 2026 in-play market *under*-reacts to goals — momentum
collects what mean reversion pays. (Caveat: 1-minute bars are the finest
history Polymarket serves; sub-minute overshoots — where the fade edge lived
in our 2022 research — are invisible here. Live 3-second polling is the real
test.) We built a fader; the data said ride; so you choose — and every call
lands on-chain either way.

## Your rules, the bot's hands

The **⚙ Fade rules** panel exposes the strategy's five knobs — panic
threshold, confirmation wait, hold, stop-loss, and the tradeable band — apply
them and the replay reruns with *your* rules
(`GET /api/replay?match=<id>&threshold=4&confirm=30&hold=120&stop=5&bandLo=8&bandHi=92`,
probability points on the wire). Every custom-strategy call still goes
on-chain: you can tune *when* to fade, but you can't untell the chain what you
did.

## Sign in with your wallet

**Connect wallet** (Phantom, devnet) is a login: your duel record and virtual
bankroll follow your address. And when you swipe *Fade with the bot* while
connected, **your call is signed by your own wallet and committed to devnet**
— the audience gets the same proof-of-call treatment as the agent. No wallet?
Everything still works; picks just stay local.

## Fade your timeline

The most relatable market on earth is the people you follow. **The Timeline**
panel shows takes about the match as they land; when the bot's fade resolves,
every take gets a verdict (💀 was wrong / 😤 was right), and the **Most
Fadeable** leaderboard ranks who on your timeline you should always bet
against. Swipe cards quote the loudest take — *"@degenCarlos says Argentina is
cooked. Fade him?"*

The **"see real posts on 𝕏"** link opens the live X search for the current
match. Demo mode synthesizes a CT-style timeline from the real match events.
Live mode ingests **real posts** — point a scout agent (or anything) at:

```bash
curl -X POST localhost:4747/api/takes -d '{
  "handle": "@degenCarlos",
  "text": "Argentina is COOKED, max size on Saudi",
  "fixtureId": "wc2022-arg-ksa",
  "stance": "panic"
}'
```

Same scoring, same leaderboard — real handles, real receipts. And when a take
is scored, its **hash + verdict is committed on-chain** alongside the bot's
calls: the Most Fadeable leaderboard is provable, not just displayed.

## Social outbox — the agent feeds your feed

Every call and every resolution is composed into a **ready-to-post tweet
draft** in a fast, receipts-forward CT voice — the call *with its on-chain
timestamp link*, then the win gloat or the owned loss. Nothing auto-posts, by
design. Consume the drafts two ways:

- `GET /api/drafts` (JSON array),
- tail `data/outbox.jsonl` — one draft per line:
  `{id, kind: "call"|"receipt", text, signalId, label, explorer, ts}`.

The JSONL is a stable contract for downstream agents — point a
scout/writer-style social agent at it and FadeCast becomes a signal source for
an AI-managed (human-approved) trading persona with a cryptographically
auditable track record.

## How it scales

- **Replay is the onboarding.** Any historical match is one JSON entry in
  `data/matches.json`; the header picker replays it on demand
  (`GET /api/replay?match=<id>&speed=N`, `/api/replay/stop` to pause). Upcoming
  fixtures (`data/upcoming.json`) show what goes live next through TxLINE. A library of history's great market
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
