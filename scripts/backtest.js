// Tournament-wide backtest: run the FadeCast engine over the REAL Polymarket
// price history of every completed WC2026 match, both strategies (fade and
// ride), identical default rules. Reproduce with: npm run backtest
//
// Method notes (honesty matters more than the number):
//  - 1-minute bars (the finest historical fidelity Polymarket serves) vs the
//    3s polling a live session uses — timings are approximate.
//  - One market per match (the first "Will X win?" money-line), YES token.
//  - $5 per fade, engine defaults, entry/exit at mid ± 0.5c half-spread.

import { OvershootEngine } from '../lib/overshoot.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const SERIES = '11433'; // soccer-fifwc
const SIZE = 5;
const MATCH_SLUG = /^fifwc-[a-z]{2,4}-[a-z]{2,4}-\d{4}-\d{2}-\d{2}$/;

async function allClosedMatches() {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const page = await fetch(`${GAMMA}/events?series_id=${SERIES}&closed=true&limit=100&offset=${offset}`).then(r => r.json());
    out.push(...page);
    if (page.length < 100) break;
  }
  return out.filter(e => MATCH_SLUG.test(e.slug || ''));
}

function runEngine(history, side) {
  const eng = new OvershootEngine({ side });
  const t0 = history[0].t;
  for (const pt of history) eng.addTick({ fixtureId: 'm', outcome: 'yes', price: pt.p, ts: pt.t - t0 });
  let usd = 0, n = 0, w = 0, stops = 0;
  for (const s of eng.signals.filter(s => s.status === 'resolved')) {
    n++; if (s.pnl > 0) w++; if (s.stopped) stops++;
    usd += SIZE * s.pnl / s.entry;
  }
  return { n, w, stops, usd };
}

async function backtestMatch(ev) {
  const m = (ev.markets || []).find(x => /^Will .+ win/i.test(x.question || '') && x.clobTokenIds);
  if (!m) return null;
  const [yes] = JSON.parse(m.clobTokenIds);
  const kick = Math.floor(new Date(ev.endDate) / 1000);
  const h = await fetch(`${CLOB}/prices-history?market=${yes}&startTs=${kick - 1800}&endTs=${kick + 4 * 3600}&fidelity=1`)
    .then(r => r.json()).then(d => d.history || []).catch(() => []);
  if (h.length < 30) return null; // no usable in-play tape
  return { slug: ev.slug, title: ev.title, points: h.length, fade: runEngine(h, 'fade'), ride: runEngine(h, 'ride') };
}

const events = await allClosedMatches();
console.log(`completed WC2026 match events on Polymarket: ${events.length}`);
const rows = [];
for (let i = 0; i < events.length; i += 5) {
  const batch = await Promise.all(events.slice(i, i + 5).map(e => backtestMatch(e).catch(() => null)));
  rows.push(...batch.filter(Boolean));
  process.stderr.write(`\r${Math.min(i + 5, events.length)}/${events.length} fetched…`);
}
process.stderr.write('\n');

const agg = side => rows.reduce((a, r) => ({
  usd: a.usd + r[side].usd, n: a.n + r[side].n, w: a.w + r[side].w, stops: a.stops + r[side].stops
}), { usd: 0, n: 0, w: 0, stops: 0 });

const F = agg('fade'), R = agg('ride');
console.log(`\nmatches with usable in-play tape: ${rows.length}`);
console.log(`\n=== FADE (defaults, $${SIZE}/clip) ===`);
console.log(`trades ${F.n} | wins ${F.w} (${F.n ? (100 * F.w / F.n).toFixed(0) : 0}%) | stop-outs ${F.stops} | net ${F.usd >= 0 ? '+' : ''}$${F.usd.toFixed(2)}`);
console.log(`=== RIDE (same detector) ===`);
console.log(`trades ${R.n} | wins ${R.w} (${R.n ? (100 * R.w / R.n).toFixed(0) : 0}%) | stop-outs ${R.stops} | net ${R.usd >= 0 ? '+' : ''}$${R.usd.toFixed(2)}`);

rows.sort((a, b) => b.fade.usd - a.fade.usd);
console.log('\nbest fade matches:');
for (const r of rows.slice(0, 5)) console.log(`  ${r.slug} fade ${r.fade.usd >= 0 ? '+' : ''}$${r.fade.usd.toFixed(2)} (${r.fade.n}t) | ride ${r.ride.usd >= 0 ? '+' : ''}$${r.ride.usd.toFixed(2)}`);
console.log('worst fade matches:');
for (const r of rows.slice(-5)) console.log(`  ${r.slug} fade ${r.fade.usd >= 0 ? '+' : ''}$${r.fade.usd.toFixed(2)} (${r.fade.n}t) | ride ${r.ride.usd >= 0 ? '+' : ''}$${r.ride.usd.toFixed(2)}`);

const profF = rows.filter(r => r.fade.usd > 0).length, tradedF = rows.filter(r => r.fade.n > 0).length;
const profR = rows.filter(r => r.ride.usd > 0).length, tradedR = rows.filter(r => r.ride.n > 0).length;
console.log(`\nfade profitable in ${profF}/${tradedF} traded matches | ride profitable in ${profR}/${tradedR}`);
