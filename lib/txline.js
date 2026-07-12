// TxLINE client: guest auth, REST snapshots, SSE streams, and a tick recorder.
//
// Endpoints (see README for the full list used):
//   POST {origin}/auth/guest/start                  -> guest JWT
//   GET  {origin}/api/fixtures/snapshot             -> fixture metadata
//   GET  {origin}/api/odds/snapshot/{fixtureId}     -> current odds
//   GET  {origin}/api/odds/stream                   -> SSE StablePrice odds
//   GET  {origin}/api/scores/stream                 -> SSE score events
//   GET  {origin}/api/scores/snapshot/{fixtureId}   -> current score
//
// Data requests need BOTH headers:
//   Authorization: Bearer {jwt}   and   X-Api-Token: {apiToken}
// The apiToken comes from the on-chain free-tier subscribe + activate flow
// (scripts/subscribe.js). Credentials are cached in data/credentials.json.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const ORIGINS = {
  mainnet: 'https://txline.txodds.com',
  devnet: 'https://txline-dev.txodds.com'
};

export class TxLineClient extends EventEmitter {
  constructor({ network = 'devnet', credentialsPath = 'data/credentials.json', recordTo = null } = {}) {
    super();
    this.origin = ORIGINS[network];
    this.network = network;
    this.credentialsPath = credentialsPath;
    this.creds = this._loadCreds();
    this.recordTo = recordTo;
    this.aborts = [];
  }

  _loadCreds() {
    try { return JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8')); }
    catch { return {}; }
  }

  async guestJwt() {
    if (this.creds.jwt) return this.creds.jwt;
    const r = await fetch(`${this.origin}/auth/guest/start`, { method: 'POST' });
    if (!r.ok) throw new Error(`guest/start ${r.status}`);
    const body = await r.json();
    this.creds.jwt = body.token || body;
    this._saveCreds();
    return this.creds.jwt;
  }

  _saveCreds() {
    fs.mkdirSync(path.dirname(this.credentialsPath), { recursive: true });
    fs.writeFileSync(this.credentialsPath, JSON.stringify(this.creds, null, 2));
  }

  async _headers() {
    const jwt = await this.guestJwt();
    if (!this.creds.apiToken) {
      throw new Error('No apiToken — run `npm run subscribe` (on-chain free tier activation) first.');
    }
    return { Authorization: `Bearer ${jwt}`, 'X-Api-Token': this.creds.apiToken };
  }

  async get(p) {
    const r = await fetch(`${this.origin}/api${p}`, { headers: await this._headers() });
    if (!r.ok) throw new Error(`GET ${p} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  fixtures(competitionId) {
    return this.get(`/fixtures/snapshot${competitionId ? `?competitionId=${competitionId}` : ''}`);
  }
  oddsSnapshot(fixtureId) { return this.get(`/odds/snapshot/${fixtureId}`); }
  scoresSnapshot(fixtureId) { return this.get(`/scores/snapshot/${fixtureId}`); }
  proof(kind, id) { return this.get(`/${kind}/proof/${id}`); } // validation proofs for on-chain checks

  // ---- SSE ------------------------------------------------------------------

  async stream(pathName, onEvent) {
    const ctrl = new AbortController();
    this.aborts.push(ctrl);
    const headers = { ...(await this._headers()), Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
    const r = await fetch(`${this.origin}/api${pathName}`, { headers, signal: ctrl.signal });
    if (!r.ok) throw new Error(`stream ${pathName} -> ${r.status}`);

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const evt = { event: 'message', data: '' };
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) evt.event = line.slice(6).trim();
              else if (line.startsWith('data:')) evt.data += line.slice(5).trim();
            }
            if (evt.data) {
              try { onEvent(evt.event, JSON.parse(evt.data)); }
              catch { onEvent(evt.event, evt.data); }
            }
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') this.emit('error', e);
      }
      this.emit('streamEnd', pathName);
    })();
    return () => ctrl.abort();
  }

  // ---- normalize into engine ticks -------------------------------------------
  // TxLINE odds events carry StablePrice decimal odds; the engine wants implied
  // probability of a single outcome. We track the HOME side of the 1X2 market.

  normalizeOdds(raw) {
    const rows = Array.isArray(raw) ? raw : [raw];
    const ticks = [];
    for (const o of rows) {
      const fixtureId = o.fixtureId ?? o.fixture_id ?? o.fixture;
      const prices = o.prices ?? o.odds ?? o;
      const home = num(prices.home ?? prices['1'] ?? prices.h);
      const draw = num(prices.draw ?? prices['x'] ?? prices.d);
      const away = num(prices.away ?? prices['2'] ?? prices.a);
      if (!fixtureId || !home) continue;
      // de-vig via inverse-odds normalization when all three sides are present
      const inv = [home, draw, away].filter(Boolean).map(x => 1 / x);
      const overround = inv.reduce((a, b) => a + b, 0) || 1;
      ticks.push({
        fixtureId: String(fixtureId),
        outcome: 'home',
        price: (1 / home) / overround,
        ts: (o.timestamp ?? o.ts ?? Date.now()) / (o.timestamp > 1e12 ? 1000 : 1),
        meta: { label: o.name ?? o.fixtureName ?? String(fixtureId), raw: undefined }
      });
    }
    return ticks;
  }

  record(tick) {
    if (!this.recordTo) return;
    fs.appendFileSync(this.recordTo, JSON.stringify(tick) + '\n');
  }

  stop() { for (const c of this.aborts) c.abort(); }
}

const num = v => { const n = Number(v); return Number.isFinite(n) && n > 1 ? n : null; };
