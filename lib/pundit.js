// The Pundit: FadeCast's voice. Turns engine events into live commentary.
//
// Two modes:
//   - templates (default): deterministic, zero-dependency, never fails a demo
//   - Claude API (set ANTHROPIC_API_KEY): live-generated one-liners via raw
//     fetch, template fallback on any error/timeout. Model override: PUNDIT_MODEL.
//
// The persona: a smug quant who trades the crowd, not the game. Gloats on
// wins, owns losses, and narrates panic like a nature documentary.

const T = {
  goal: [
    "GOAL! {scorer} for {team} at {min}'. And here comes the stampede — watch the market trip over itself.",
    "{scorer} scores for {team}. The market is about to price this like the game just ended. It didn't.",
    "{team} goal — {scorer}, {min}'. Somewhere out there, a thousand bettors just slammed the buy button at the top.",
    "{scorer} finds the net for {team}. Deep breaths, everyone. The market won't take its own advice."
  ],
  signal_high: [
    "Panic {panic}/100. {label} just repriced from {pre} to {det} — that's not analysis, that's adrenaline. Fading it. 🔒 on-chain before it resolves.",
    "This is textbook. {label} spiked {pre} → {det} and my model says the crowd overshot. Signal committed to Solana — no take-backs.",
    "The market is having a moment on {label}: {pre} → {det}. I've seen this movie. Fade published on-chain, timestamped, irreversible."
  ],
  signal_mid: [
    "Mild hysteria on {label} ({pre} → {det}, panic {panic}). Taking the other side — receipts on devnet.",
    "{label} jumped to {det}. Overreaction? My model thinks so. The call is on-chain either way — that's the deal.",
    "Some panic in the {label} market. Fading at {det}, and yes, you can verify I said this BEFORE it resolved."
  ],
  entered: [
    "Filled at {entry} on {label}. Now we wait for the crowd to sober up.",
    "Position on at {entry}. Gravity does the rest — usually.",
    "In at {entry}. The overshoot always looks obvious in hindsight. I just don't wait for hindsight."
  ],
  win: [
    "And there it is. {label} reverted, +{pnl} pts. The crowd panicked, I got paid. Check the chain — I called it.",
    "+{pnl} pts on {label}. Not luck. Mean reversion with a cryptographic paper trail.",
    "{label} settles my way, +{pnl}. Every winning call I show you is on-chain. So are the losers. That's the point."
  ],
  stopped: [
    "Stopped out on {label}, {pnl} pts. When the panic turns out to be a comeback, you cut and walk. On-chain, like everything.",
    "Cut the {label} fade at {pnl}. Second goal killed it — discipline over ego. The ledger saw it all.",
    "{label}: {pnl} pts, stopped. The crowd was right this time. It happens. That's why the stop exists."
  ],
  loss: [
    "Ouch. {label} kept running, {pnl} pts. That one's on-chain forever too — that's what honest looks like.",
    "{pnl} pts on {label}. Sometimes the panic is right. The ledger doesn't let me pretend otherwise.",
    "Took a hit on {label} ({pnl}). No deleted tweets here — the loss is timestamped on devnet like everything else."
  ]
};

const MOODS = { goal: '⚽', signal_high: '🚨', signal_mid: '📉', entered: '🎯', win: '💰', loss: '🩹', stopped: '✂️' };

export class Pundit {
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.PUNDIT_MODEL || 'claude-opus-4-8' } = {}) {
    this.apiKey = apiKey || null;
    this.model = model;
    this.counts = {};
  }

  _template(kind, vars) {
    const pool = T[kind];
    const i = (this.counts[kind] = (this.counts[kind] ?? -1) + 1) % pool.length;
    return pool[i].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  }

  async say(kind, vars) {
    const fallback = this._template(kind, vars);
    const text = this.apiKey ? await this._claude(kind, vars, fallback) : fallback;
    return { text, mood: MOODS[kind] || '🎙', kind, ts: vars.ts ?? null };
  }

  // Raw Messages API via fetch — no SDK, so a missing key or dead network
  // degrades to templates instead of failing the demo.
  async _claude(kind, vars, fallback) {
    try {
      const ctrl = AbortSignal.timeout(6000);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctrl,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 100,
          system: 'You are FadeCast, a smug but likable quant AI that trades against crowd panic in World Cup betting markets. Every call you make is committed on-chain before it resolves, so you never cherry-pick. Reply with ONE punchy line of commentary (max 25 words). No hashtags, no quotes around the reply.',
          messages: [{
            role: 'user',
            content: `Event: ${kind}. Data: ${JSON.stringify(vars)}. One line of live commentary.`
          }]
        })
      });
      if (!r.ok) return fallback;
      const body = await r.json();
      const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      return text || fallback;
    } catch {
      return fallback;
    }
  }

  goal({ team, minute, scorer, meta, ts }) {
    return this.say('goal', { team, min: minute, scorer: scorer || team, label: meta?.label, ts });
  }
  signal(s) {
    return this.say(s.panic >= 70 ? 'signal_high' : 'signal_mid',
      { label: s.meta?.label || s.fixtureId, pre: s.pre.toFixed(2), det: s.det.toFixed(2), panic: s.panic, ts: s.detT });
  }
  entered(s) { return this.say('entered', { label: s.meta?.label || s.fixtureId, entry: s.entry.toFixed(2), ts: s.detT }); }
  resolved(s) {
    const kind = s.pnl > 0 ? 'win' : s.stopped ? 'stopped' : 'loss';
    return this.say(kind,
      { label: s.meta?.label || s.fixtureId, pnl: (s.pnl * 100).toFixed(1), ts: s.detT });
  }
}
