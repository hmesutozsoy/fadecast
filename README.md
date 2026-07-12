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
`verify ↗` explorer links, and the agent's cumulative record.

## Why on-chain commitment matters

Every "AI trading guru" screenshot you've ever seen is survivorship bias.
FadeCast's wallet is its reputation: each signal is timestamped on Solana
*before the market resolves it*, so anyone can reconstruct the exact track
record from the chain and integrity-check it against the off-chain data via the
memo hash. TxLINE's validation proofs anchor the *input* data on-chain;
FadeCast anchors the *decisions*.

## Running it

```bash
npm install
npm run replay     # deterministic demo: 3 synthetic matches at 40x speed
npm run live       # real TxLINE streams (requires activation, below)
```

Dashboard: http://localhost:4747

Env knobs: `PORT`, `SPEED` (replay acceleration), `PUBLISH=0` (skip on-chain
writes), `TXLINE_NETWORK=mainnet|devnet`.

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
  tracking, entry/exit pricing with spread crossing.
- `lib/txline.js` — auth, snapshots, SSE client, tick normalization (de-vig),
  recorder.
- `lib/replay.js` — deterministic fair-value + decaying-overshoot match
  simulator, or recorded-tick playback. Same event shape as live.
- `lib/solana.js` — Memo-program commitments with graceful faucet-failure
  queueing and periodic flush.
- `server.js` — wiring + dashboard host. No frameworks; Node stdlib + `@solana/web3.js`.

## Honest limitations

- Free-tier devnet odds coverage can be sparse outside match windows — the
  replay path exists precisely so judges can see the full loop anytime.
- Signal P&L is marked against TxLINE mid prices with an assumed half-spread;
  it is a strategy *telemetry* number, not an executed-fill number.
- One market per fixture (home win) in v0; the engine is series-keyed and
  extends to draw/away/props by adding outcomes.
