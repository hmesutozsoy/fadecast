// Social outbox: turns signal lifecycle events into ready-to-post drafts.
//
// Drafts-only by design — nothing auto-posts. Two consumers:
//   - humans: the dashboard drafts panel (copy button) or `cat data/outbox.jsonl`
//   - agents: GET /api/drafts, or tail the JSONL — one draft object per line:
//     { id, kind: "call"|"receipt", text, signalId, label, ts, explorer }
//
// Voice: fast, irreverent CT register. No hashtags (nothing reads more bot).
// Every claim ships with its receipt — the on-chain link IS the personality.

import fs from 'node:fs';
import path from 'node:path';

export class SocialOutbox {
  constructor({ file = 'data/outbox.jsonl' } = {}) {
    this.file = file;
    this.drafts = [];
    this.n = 0;
  }

  _push(kind, signal, text) {
    const draft = {
      id: `draft_${++this.n}_${signal.id}`,
      kind,
      text,
      signalId: signal.id,
      label: signal.meta?.label || signal.fixtureId,
      explorer: signal.chain?.explorer || null,
      ts: Date.now()
    };
    this.drafts.push(draft);
    if (this.drafts.length > 100) this.drafts.shift();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(draft) + '\n');
    return draft;
  }

  call(signal) {
    const dir = signal.direction === 1 ? 'spiked' : 'cratered';
    const proof = signal.chain?.explorer
      ? `receipt, timestamped before it resolves:\n${signal.chain.explorer}`
      : `call committed on-chain before it resolves (hash ${signal.chain?.hash || 'pending'})`;
    return this._push('call', signal,
      `market just ${dir} on ${signal.meta?.label || signal.fixtureId} ` +
      `(${signal.pre.toFixed(2)} → ${signal.det.toFixed(2)}, panic ${signal.panic}/100).\n\n` +
      `crowd's panicking. i'm fading it.\n\n${proof}`);
  }

  receipt(signal) {
    const pts = (signal.pnl * 100).toFixed(1);
    const link = signal.chain?.explorer ? `\n\nproof i called it first:\n${signal.chain.explorer}` : '';
    const text = signal.pnl > 0
      ? `${signal.meta?.label || signal.fixtureId}: +${pts} pts.\n\n` +
        `not a screenshot after the fact. the call was on-chain before the market moved back.${link}`
      : `took the L on ${signal.meta?.label || signal.fixtureId} (${pts} pts).\n\n` +
        `it stays on-chain forever, because that's the whole point. ` +
        `every guru shows you their wins. i can't hide my losses.${link}`;
    return this._push('receipt', signal, text);
  }
}
