# Feedback on the TxLINE API

Honest notes from building FadeCast against TxLINE over the hackathon.

## What worked well

- **The free World Cup tier is the right call.** No TxL purchase, real-time
  service level, and historical replay access on the free tier meant we could
  design the whole product (including a replay/backtest mode) before spending
  anything.
- **SSE for streaming was a good choice.** Plain `fetch` + a 20-line SSE
  parser is all a consumer needs — no SDK lock-in. The docs' note that "an
  open connection doesn't guarantee a covered fixture is producing data" is
  honest and saved us debugging time.
- **Validation proofs are the differentiator.** Cryptographically verifiable
  *input* data is what makes an auditable *decision* trail meaningful — we
  designed our on-chain commitments to reference them. Lean into this in the
  positioning; it's what no conventional odds feed offers.
- **The network-matching warning in the quickstart** (RPC, program ID, JWT and
  API host must all be the same network) is exactly the kind of pitfall
  documentation that prevents support tickets.

## Friction we hit

1. **On-chain activation is the funnel's choke point.** Getting data requires
   devnet SOL → the public devnet faucet rate-limited us all day (429 /
   "faucet has run dry"), which blocked token activation entirely during the
   build. Suggestion: a hackathon/trial path that issues a short-lived API
   token *without* the on-chain subscribe (or a TxLINE-operated faucet /
   pre-funded devnet wallets for registered builders). You lose zero security
   on a free tier and gain every builder who currently bounces off this step.
2. **Response schemas are under-documented.** The API reference lists
   endpoints and parameters, but we could not find canonical example JSON
   payloads for odds/scores responses. We wrote a defensive normalizer that
   tolerates several plausible field spellings (`fixtureId`/`fixture_id`,
   `prices.home`/`1`/`h`) — publishing one canonical example response per
   endpoint would remove that guesswork.
3. **The devnet IDL isn't downloadable from the docs.** The quickstart code
   imports `./idl/txoracle.json`, but we had to find the actual IDL in other
   builders' public repos. Host the mainnet + devnet IDLs as direct downloads
   next to the quickstart.
4. **Docs are hard to consume programmatically.** The documentation site
   renders client-side, so deep links 404 for non-browser fetchers, and
   there's no `llms.txt`. Mintlify supports `llms.txt` — enabling it would
   make the docs legible to the AI coding tools most hackathon builders are
   using.
5. **Minor:** the two-header auth (`Authorization: Bearer <jwt>` +
   `X-Api-Token`) is unusual; a one-line "why two credentials" note in the
   quickstart would preempt confusion.

## Net

Solid, standards-based data plane with a genuinely novel on-chain trust story.
The single biggest improvement for hackathons is smoothing the devnet-SOL →
subscribe → activate onboarding: it's the only step where we lost hours, and
it's the step every new builder hits first.
