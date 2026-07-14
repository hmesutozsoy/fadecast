// Polymarket: the venue where the fade actually trades.
//
// PolymarketSource — polls the CLOB order book for a market's YES token and
// feeds mid-prices into the engine as ticks. Public endpoints, no auth.
//
// PolymarketExecutor — turns engine signals into orders. Binary CLOBs have no
// shorting: fading a spike (sell YES) is expressed as BUY NO, fading a crash
// as BUY YES; the exit sells the token you hold.
//   mode 'paper' (default): fills simulated at the real book's touch, logged.
//   mode 'live': real orders via @polymarket/clob-client — requires
//     POLY_PRIVATE_KEY (your Polygon key, from env only) and POLY_TRADE=live.
//     Never enabled by default; the code path exists, the human flips it.

import { EventEmitter } from 'node:events';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

export async function findMarket(slug, questionLike) {
  const events = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`).then(r => r.json());
  if (!events.length) throw new Error(`no Polymarket event for slug ${slug}`);
  const ev = events[0];
  const q = (questionLike || '').toLowerCase();
  const m = ev.markets.find(x => x.question.toLowerCase().includes(q)) || ev.markets[0];
  const [yes, no] = JSON.parse(m.clobTokenIds);
  const [home, away] = ev.title.split(/ vs\.? /i);
  return {
    eventTitle: ev.title, question: m.question, marketId: m.id,
    yes, no, fixtureId: `poly-${m.id}`, home, away,
    label: `${ev.title} — ${m.question.replace(/ on \d{4}-\d{2}-\d{2}\?/, '?')}`
  };
}

async function book(tokenId) {
  const b = await fetch(`${CLOB}/book?token_id=${tokenId}`).then(r => r.json());
  const bid = b.bids?.length ? Number(b.bids[b.bids.length - 1].price) : null;
  const ask = b.asks?.length ? Number(b.asks[b.asks.length - 1].price) : null;
  return { bid, ask, mid: bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask) };
}

export class PolymarketSource extends EventEmitter {
  constructor(market, { intervalMs = 3000 } = {}) {
    super();
    this.m = market;
    this.intervalMs = intervalMs;
    this.stopped = false;
    this.lastBook = { yes: null, no: null };
  }
  start() {
    const loop = async () => {
      if (this.stopped) return;
      try {
        const [y, n] = await Promise.all([book(this.m.yes), book(this.m.no)]);
        this.lastBook = { yes: y, no: n };
        if (y.mid !== null) {
          this.emit('tick', {
            fixtureId: this.m.fixtureId, outcome: 'yes', price: y.mid,
            ts: Date.now() / 1000,
            meta: {
              label: this.m.label, venue: 'polymarket',
              home: this.m.home, away: this.m.away,
              spread: y.ask !== null && y.bid !== null ? y.ask - y.bid : null
            }
          });
        }
      } catch (e) { this.emit('error', e); }
      setTimeout(loop, this.intervalMs);
    };
    loop();
    return this;
  }
  stop() { this.stopped = true; }
}

export class PolymarketExecutor {
  /**
   * mode: 'off' | 'paper' | 'live'; sizeUsd: notional per fade.
   * Allocation controls (the difference between a demo and a bot you can
   * leave running):
   *   maxExposureUsd — refuse new entries past this much concurrently open
   *   maxLossUsd     — kill switch: if realized P&L drops below -maxLossUsd,
   *                    the executor disarms itself (mode -> off) and says so
   */
  constructor(market, source, { mode = 'paper', sizeUsd = 5, maxExposureUsd = 15, maxLossUsd = 20 } = {}) {
    this.m = market;
    this.src = source;
    this.mode = mode;
    this.sizeUsd = sizeUsd;
    this.maxExposureUsd = maxExposureUsd;
    this.maxLossUsd = maxLossUsd;
    this.disarmed = null;    // reason string once the kill switch fires
    this.orders = [];        // {ts, action, token, side, price, shares, usd, status, note}
    this.open = new Map();   // signalId -> {token, tokenName, shares, entryPrice}
    this._client = null;
  }

  get exposureUsd() {
    return [...this.open.values()].reduce((a, p) => a + p.entryPrice * p.shares, 0);
  }
  get realizedUsd() {
    return +this.orders.filter(o => o.pnlUsd != null).reduce((a, o) => a + o.pnlUsd, 0).toFixed(2);
  }

  _record(o) { this.orders.push(o); if (this.orders.length > 100) this.orders.shift(); return o; }

  async _liveClient() {
    if (this._client) return this._client;
    if (!process.env.POLY_PRIVATE_KEY) throw new Error('POLY_PRIVATE_KEY not set');
    const { ClobClient } = await import('@polymarket/clob-client');
    const { Wallet } = await import('@ethersproject/wallet');
    const signer = new Wallet(process.env.POLY_PRIVATE_KEY);
    // Most Polymarket accounts are proxy wallets: email logins sign with
    // type 1, browser-wallet accounts with type 2, and the funder is the
    // deposit address shown on your Polymarket profile. Raw EOAs use type 0
    // and need no funder.
    const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
    const funder = process.env.POLY_FUNDER || undefined;
    const boot = new ClobClient(CLOB, 137, signer, undefined, sigType, funder);
    const creds = await boot.createOrDeriveApiKey();
    this._client = new ClobClient(CLOB, 137, signer, creds, sigType, funder);
    return this._client;
  }

  async _order(action, tokenName, side, price, shares, signalId) {
    const token = tokenName === 'YES' ? this.m.yes : this.m.no;
    const usd = +(price * shares).toFixed(2);
    const base = { ts: Date.now(), action, token: tokenName, side, price: +price.toFixed(4), shares: +shares.toFixed(2), usd, signalId };
    if (this.mode === 'paper') {
      return this._record({ ...base, status: 'paper-filled', note: 'simulated at the live book touch' });
    }
    // live: a real order, placed with the operator's own key and explicit opt-in
    try {
      const client = await this._liveClient();
      const { Side, OrderType } = await import('@polymarket/clob-client');
      const resp = await client.createAndPostOrder(
        { tokenID: token, price: +price.toFixed(3), side: side === 'BUY' ? Side.BUY : Side.SELL, size: +shares.toFixed(2) },
        { tickSize: '0.001', negRisk: false },
        OrderType.FAK
      );
      return this._record({ ...base, status: resp?.success ? 'live-submitted' : 'live-rejected', note: resp?.orderID || resp?.errorMsg || '' });
    } catch (e) {
      return this._record({ ...base, status: 'live-error', note: e.message.slice(0, 120) });
    }
  }

  // fade the spike = buy NO; fade the crash = buy YES
  async onEntered(sig) {
    if (this.mode === 'off') return;
    if (this.disarmed) return;
    if (this.exposureUsd + this.sizeUsd > this.maxExposureUsd) {
      return this._record({
        ts: Date.now(), action: 'SKIP', token: '—', side: '—', price: 0, shares: 0, usd: 0,
        signalId: sig.id, status: 'exposure-capped',
        note: `open $${this.exposureUsd.toFixed(2)} + $${this.sizeUsd} would exceed cap $${this.maxExposureUsd}`
      });
    }
    const wantNo = sig.direction === 1;
    const b = wantNo ? this.src.lastBook.no : this.src.lastBook.yes;
    if (!b || b.ask === null) return;
    const shares = this.sizeUsd / b.ask;
    const o = await this._order('ENTER', wantNo ? 'NO' : 'YES', 'BUY', b.ask, shares, sig.id);
    this.open.set(sig.id, { tokenName: wantNo ? 'NO' : 'YES', shares, entryPrice: b.ask });
    return o;
  }

  async onResolved(sig) {
    if (this.mode === 'off') return;
    const pos = this.open.get(sig.id);
    if (!pos) return;
    this.open.delete(sig.id);
    const b = pos.tokenName === 'NO' ? this.src.lastBook.no : this.src.lastBook.yes;
    if (!b || b.bid === null) return;
    const o = await this._order(sig.stopped ? 'STOP-EXIT' : 'EXIT', pos.tokenName, 'SELL', b.bid, pos.shares, sig.id);
    o.pnlUsd = +((b.bid - pos.entryPrice) * pos.shares).toFixed(2);
    // kill switch: past the allocated loss, the bot stands itself down
    if (this.realizedUsd <= -this.maxLossUsd && !this.disarmed) {
      this.disarmed = `session loss $${(-this.realizedUsd).toFixed(2)} hit the $${this.maxLossUsd} kill switch — no new entries`;
      this._record({
        ts: Date.now(), action: 'DISARM', token: '—', side: '—', price: 0, shares: 0, usd: 0,
        signalId: sig.id, status: 'kill-switch', note: this.disarmed
      });
    }
    return o;
  }

  state() {
    return {
      mode: this.mode, sizeUsd: this.sizeUsd, market: this.m.label,
      maxExposureUsd: this.maxExposureUsd, maxLossUsd: this.maxLossUsd,
      exposureUsd: +this.exposureUsd.toFixed(2), disarmed: this.disarmed,
      orders: this.orders.slice(-20),
      realizedUsd: this.realizedUsd
    };
  }
}
