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

  /** Arm live trading at runtime. The key lives in process memory only —
   *  never on disk, never in state(), never echoed back. */
  arm({ privateKey, signatureType, funder }) {
    this._pk = privateKey;
    this._sigType = Number(signatureType ?? 0);
    this._funder = funder || undefined;
    this._client = null;      // rebuild with the new identity
    this.mode = 'live';
    this.disarmed = null;
  }
  disarm(reason = 'operator disarmed') { this.mode = 'paper'; this._pk = null; this._client = null; this.disarmed = null; this._record({ ts: Date.now(), action: 'DISARM', token: '—', side: '—', price: 0, shares: 0, usd: 0, status: 'manual', note: reason }); }
  setLimits({ sizeUsd, maxExposureUsd, maxLossUsd }) {
    if (isFinite(sizeUsd) && sizeUsd > 0) this.sizeUsd = sizeUsd;
    if (isFinite(maxExposureUsd) && maxExposureUsd > 0) this.maxExposureUsd = maxExposureUsd;
    if (isFinite(maxLossUsd) && maxLossUsd > 0) this.maxLossUsd = maxLossUsd;
  }

  async _liveClient() {
    if (this._client) return this._client;
    const pk = this._pk || process.env.POLY_PRIVATE_KEY;
    if (!pk) throw new Error('no key armed (settings or POLY_PRIVATE_KEY)');
    const { ClobClient } = await import('@polymarket/clob-client');
    const { Wallet } = await import('@ethersproject/wallet');
    const signer = new Wallet(pk);
    // Most Polymarket accounts are proxy wallets: email logins sign with
    // type 1, browser-wallet accounts with type 2, and the funder is the
    // deposit address shown on your Polymarket profile. Raw EOAs use type 0
    // and need no funder.
    const sigType = this._sigType ?? Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
    const funder = this._funder || process.env.POLY_FUNDER || undefined;
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
      keyArmed: !!(this._pk || process.env.POLY_PRIVATE_KEY), // boolean only — the key itself never leaves memory
      orders: this.orders.slice(-20),
      realizedUsd: this.realizedUsd
    };
  }
}

// ---------------------------------------------------------------------------
// MarketMaker: quote both sides of the book while the market is calm, and
// pull quotes the moment the panic detector fires — the fade engine doubles
// as the market maker's risk radar. MMs get run over by goals; we can see
// the goal in the price.
//
// Paper fills are approximated: a quote "fills" when the observed mid crosses
// it. Honest for demos, clearly labeled; live mode posts real GTC orders.
// ---------------------------------------------------------------------------

export class MarketMaker {
  constructor(market, source, executorRef, {
    spread = 0.02,        // total quote width in probability (2c)
    sizeUsd = 5,          // per quote side
    maxInventoryUsd = 20, // |position| cap; stop quoting the growing side
    pauseSec = 90,        // how long to stand down after a panic signal
    mode = 'paper'
  } = {}) {
    this.m = market; this.src = source; this.execRef = executorRef;
    this.spread = spread; this.sizeUsd = sizeUsd;
    this.maxInventoryUsd = maxInventoryUsd; this.pauseSec = pauseSec;
    this.mode = mode;
    this.running = false;
    this.pausedUntil = 0;
    this.quotes = { bid: null, ask: null };   // paper quotes (live: order ids too)
    this.pos = 0;                             // net YES shares (negative = net NO view)
    this.avg = 0;
    this.realizedUsd = 0;
    this.fills = [];
    this.events = [];
    this._liveOrders = [];
  }

  log(kind, note) {
    this.events.push({ ts: Date.now(), kind, note });
    if (this.events.length > 60) this.events.shift();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._onTick = t => this._tick(t);
    this.src.on('tick', this._onTick);
    this.log('start', `quoting ±${(this.spread * 50).toFixed(1)}c around mid · $${this.sizeUsd}/side · panic-pause ${this.pauseSec}s`);
  }
  async stop() {
    this.running = false;
    if (this._onTick) this.src.off('tick', this._onTick);
    await this._cancelLive();
    this.quotes = { bid: null, ask: null };
    this.log('stop', 'quotes pulled');
  }

  /** the fade engine saw panic: get out of the way */
  panic(sig) {
    if (!this.running) return;
    this.pausedUntil = Date.now() + this.pauseSec * 1000;
    this._cancelLive();
    this.quotes = { bid: null, ask: null };
    this.log('panic-pause', `signal ${sig.id} (panic ${sig.panic}) — quotes pulled for ${this.pauseSec}s`);
  }

  async _cancelLive() {
    if (this.mode !== 'live' || !this._liveOrders.length) return;
    try {
      const client = await this.execRef._liveClient();
      for (const id of this._liveOrders.splice(0)) await client.cancelOrder({ orderID: id }).catch(() => {});
    } catch {}
  }

  async _tick(t) {
    if (!this.running) return;
    const mid = t.price;
    // paper-fill check against existing quotes
    if (this.quotes.bid !== null && mid <= this.quotes.bid) this._fill('BUY', this.quotes.bid);
    if (this.quotes.ask !== null && mid >= this.quotes.ask) this._fill('SELL', this.quotes.ask);
    if (Date.now() < this.pausedUntil) return;   // standing down: no re-quote
    // re-quote around the new mid, one tick min width, inventory-capped sides
    const half = Math.max(this.spread / 2, 0.001);
    const invUsd = this.pos * mid;
    const bid = invUsd >= this.maxInventoryUsd ? null : +(mid - half).toFixed(3);
    const ask = invUsd <= -this.maxInventoryUsd ? null : +(mid + half).toFixed(3);
    const moved = bid !== this.quotes.bid || ask !== this.quotes.ask;
    if (!moved) return;
    this.quotes = { bid, ask };
    if (this.mode === 'live') await this._requoteLive(bid, ask);
  }

  async _requoteLive(bid, ask) {
    try {
      await this._cancelLive();
      const client = await this.execRef._liveClient();
      const { Side, OrderType } = await import('@polymarket/clob-client');
      for (const [price, side] of [[bid, Side.BUY], [ask, Side.SELL]]) {
        if (price === null) continue;
        const resp = await client.createAndPostOrder(
          { tokenID: this.m.yes, price, side, size: +(this.sizeUsd / price).toFixed(2) },
          { tickSize: '0.001', negRisk: false }, OrderType.GTC
        );
        if (resp?.orderID) this._liveOrders.push(resp.orderID);
      }
    } catch (e) { this.log('live-error', e.message.slice(0, 100)); }
  }

  _fill(side, price) {
    const shares = this.sizeUsd / price;
    const signed = side === 'BUY' ? shares : -shares;
    // realized P&L when reducing the position
    if (this.pos !== 0 && Math.sign(signed) !== Math.sign(this.pos)) {
      const closed = Math.min(Math.abs(signed), Math.abs(this.pos));
      this.realizedUsd += closed * (price - this.avg) * Math.sign(this.pos);
    }
    const newPos = this.pos + signed;
    if (Math.sign(newPos) !== Math.sign(this.pos) || this.pos === 0) this.avg = price;
    this.pos = newPos;
    this.quotes[side === 'BUY' ? 'bid' : 'ask'] = null;   // one-shot until re-quote
    this.fills.push({ ts: Date.now(), side, price, shares: +shares.toFixed(2) });
    if (this.fills.length > 50) this.fills.shift();
    this.log('fill', `${side} ${shares.toFixed(2)} @ ${price} · pos ${this.pos.toFixed(2)} · realized $${this.realizedUsd.toFixed(2)}`);
  }

  state(mid = null) {
    const m = mid ?? this.src.lastBook.yes?.mid ?? null;
    return {
      running: this.running, mode: this.mode,
      spread: this.spread, sizeUsd: this.sizeUsd,
      maxInventoryUsd: this.maxInventoryUsd, pauseSec: this.pauseSec,
      paused: Date.now() < this.pausedUntil,
      quotes: this.quotes,
      posShares: +this.pos.toFixed(2),
      inventoryUsd: m !== null ? +(this.pos * m).toFixed(2) : null,
      realizedUsd: +this.realizedUsd.toFixed(2),
      unrealizedUsd: m !== null && this.pos !== 0 ? +((m - this.avg) * this.pos).toFixed(2) : 0,
      fills: this.fills.slice(-10),
      events: this.events.slice(-10)
    };
  }
}
