// Online (streaming) port of polymarket-wc/overshoot.py.
//
// The batch analyzer proved the premise offline: in-play prices overshoot on
// goals and mean-revert. This module runs the same detection live, one tick at
// a time, and emits fade signals the moment a jump clears the threshold.
//
// Series key = `${fixtureId}:${outcome}`. Prices are implied probabilities in [0,1].

import { EventEmitter } from 'node:events';

export const DEFAULTS = {
  lookback: 45,    // s window a jump is measured over
  threshold: 0.06, // min probability jump to call it an event
  settle: 90,      // s after detection to track the overshoot extreme
  debounce: 120,   // s between events on the same series
  entryLag: 10,    // s after detection the fade entry is priced
  hold: 300,       // s until the fade exit is priced (signal resolution)
  halfSpread: 0.01 // assumed half-spread crossed on each leg
};

export class OvershootEngine extends EventEmitter {
  constructor(params = {}) {
    super();
    this.p = { ...DEFAULTS, ...params };
    this.series = new Map(); // key -> {ticks:[{t,p}], lastEventT, meta}
    this.signals = [];       // all emitted signals, open + resolved
  }

  // ---- tick ingestion -----------------------------------------------------

  addTick({ fixtureId, outcome, price, ts, meta }) {
    const key = `${fixtureId}:${outcome}`;
    let s = this.series.get(key);
    if (!s) {
      s = { key, fixtureId, outcome, ticks: [], lastEventT: null, meta: meta || {} };
      this.series.set(key, s);
    }
    if (meta) Object.assign(s.meta, meta);
    s.ticks.push({ t: ts, p: price });
    this.emit('tick', { key, fixtureId, outcome, price, ts, label: s.meta.label });

    this._detect(s);
    this._resolveOpenSignals(ts);
    return s;
  }

  priceAt(s, t) {
    // last price at or before t (step function), null before series start
    const ticks = s.ticks;
    let lo = 0, hi = ticks.length - 1, ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ticks[mid].t <= t) { ans = ticks[mid].p; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // ---- jump detection (same rules as measure_events in overshoot.py) ------

  _detect(s) {
    const { lookback, threshold, debounce } = this.p;
    const last = s.ticks[s.ticks.length - 1];
    const ref = this.priceAt(s, last.t - lookback);
    if (ref === null || Math.abs(last.p - ref) < threshold) return;
    if (s.lastEventT !== null && last.t - s.lastEventT < debounce) return;

    s.lastEventT = last.t;
    const direction = last.p > ref ? 1 : -1;
    const jump = Math.abs(last.p - ref);

    // Panic score: how far past the threshold the market ran; 100 ≈ a 30pt move.
    const panic = Math.min(100, Math.round(25 + 300 * (jump - threshold)));

    const signal = {
      id: `sig_${s.fixtureId}_${s.outcome}_${Math.round(last.t)}`.replace(/\W+/g, '_'),
      fixtureId: s.fixtureId,
      outcome: s.outcome,
      meta: { ...s.meta },
      detT: last.t,
      direction,                       // +1 market spiked up, -1 crashed
      side: direction === 1 ? 'FADE_UP (sell)' : 'FADE_DOWN (buy)',
      pre: round4(ref),
      det: round4(last.p),
      jump: round4(jump),
      panic,
      status: 'open',                  // open -> entered -> resolved
      entry: null, exit: null, pnl: null
    };
    this.signals.push(signal);
    this.emit('signal', signal);
  }

  // ---- signal lifecycle: price the entry, then the exit --------------------

  _resolveOpenSignals(now) {
    const { entryLag, hold, halfSpread } = this.p;
    for (const sig of this.signals) {
      if (sig.status === 'resolved') continue;
      const s = this.series.get(`${sig.fixtureId}:${sig.outcome}`);
      if (!s) continue;

      if (sig.status === 'open' && now >= sig.detT + entryLag) {
        const mid = this.priceAt(s, sig.detT + entryLag);
        if (mid !== null) {
          // fading up = sell at bid, fading down = buy at ask
          sig.entry = round4(sig.direction === 1 ? mid - halfSpread : mid + halfSpread);
          sig.status = 'entered';
          this.emit('entered', sig);
        }
      }
      if (sig.status === 'entered' && now >= sig.detT + entryLag + hold) {
        const mid = this.priceAt(s, sig.detT + entryLag + hold);
        if (mid !== null) {
          sig.exit = round4(sig.direction === 1 ? mid + halfSpread : mid - halfSpread);
          sig.pnl = round4(sig.direction === 1 ? sig.entry - sig.exit : sig.exit - sig.entry);
          sig.status = 'resolved';
          this.emit('resolved', sig);
        }
      }
    }
  }

  // ---- dashboard state ------------------------------------------------------

  state() {
    const matches = {};
    for (const s of this.series.values()) {
      const m = (matches[s.fixtureId] ??= { fixtureId: s.fixtureId, meta: s.meta, outcomes: {} });
      Object.assign(m.meta, s.meta);
      m.outcomes[s.outcome] = s.ticks.slice(-240).map(({ t, p }) => [round1(t), round4(p)]);
    }
    const resolved = this.signals.filter(x => x.status === 'resolved');
    return {
      matches,
      signals: this.signals.slice(-50),
      pnl: {
        n: resolved.length,
        wins: resolved.filter(x => x.pnl > 0).length,
        total: round4(resolved.reduce((a, x) => a + x.pnl, 0))
      }
    };
  }
}

const round4 = x => Math.round(x * 1e4) / 1e4;
const round1 = x => Math.round(x * 10) / 10;
