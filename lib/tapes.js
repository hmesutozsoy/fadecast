// Real WC2026 knockout tapes: fetch actual Polymarket price history and store
// it as replayable tapes (data/tapes.json). Called at server boot when the
// file is missing/empty (works on hosts that can reach Polymarket), or via
// `node scripts/fetch-tapes.js` manually.

import fs from 'node:fs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const OUT = new URL('../data/tapes.json', import.meta.url);

export const KNOCKOUTS = [
  { slug: 'fifwc-fra-mar-2026-07-09', stage: 'Quarterfinal', result: 'France won' },
  { slug: 'fifwc-esp-bel-2026-07-10', stage: 'Quarterfinal', result: 'Spain won' },
  { slug: 'fifwc-nor-eng-2026-07-11', stage: 'Quarterfinal', result: 'England won' },
  { slug: 'fifwc-arg-che-2026-07-11', stage: 'Quarterfinal', result: 'Argentina won' },
  { slug: 'fifwc-fra-esp-2026-07-14', stage: 'Semifinal', result: 'Spain won' },
  { slug: 'fifwc-eng-arg-2026-07-15', stage: 'Semifinal', result: 'Argentina won' },
  // THE FINAL: its per-match market closed before kickoff, so the live price
  // action lived in the tournament-winner market. Tape = the Spain outcome of
  // that market through the match window, everything else overridden.
  {
    slug: 'world-cup-winner', question: 'Spain',
    fixtureId: 'fifwc-esp-arg-2026-07-19', home: 'Spain', away: 'Argentina',
    kickTs: 1784487600, // 2026-07-19T19:00Z per TxLINE's fixture feed
    stage: 'Final', result: 'Spain won 1-0 aet'
  }
];

export function loadTapes() {
  try {
    const d = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    return Array.isArray(d.tapes) ? d.tapes : [];
  } catch { return []; }
}

export async function fetchTapes({ force = false, log = console.log } = {}) {
  const existing = loadTapes();
  if (!force && existing.length >= KNOCKOUTS.length) return existing;
  const have = new Set(existing.map(t => t.fixtureId));
  const tapes = [...existing];
  for (const k of KNOCKOUTS) {
    const fixtureId = k.fixtureId || k.slug;
    if (!force && have.has(fixtureId)) continue;
    try {
      const evs = await fetch(`${GAMMA}/events?slug=${k.slug}`).then(r => r.json());
      if (!evs.length) { log(`tape skip ${k.slug}: event not found`); continue; }
      const ev = evs[0];
      const wants = k.question
        ? x => (x.question || '').includes(k.question) && x.clobTokenIds
        : x => /^Will .+ win/i.test(x.question || '') && x.clobTokenIds;
      const m = (ev.markets || []).find(wants);
      if (!m) { log(`tape skip ${k.slug}: no matching market`); continue; }
      const [yes] = JSON.parse(m.clobTokenIds);
      const kick = k.kickTs || Math.floor(new Date(ev.endDate) / 1000);
      const h = await fetch(`${CLOB}/prices-history?market=${yes}&startTs=${kick - 900}&endTs=${kick + 4 * 3600}&fidelity=1`)
        .then(r => r.json()).then(d => d.history || []);
      if (h.length < 30) { log(`tape skip ${k.slug}: no usable tape (${h.length} pts)`); continue; }
      const [home, away] = k.home ? [k.home, k.away] : (ev.title || '').split(/ vs\.? /i);
      const t0 = h[0].t;
      tapes.push({
        fixtureId, home, away,
        label: `${home} vs. ${away} — ${k.stage}`,
        stage: k.stage, result: k.result, question: m.question,
        ticks: h.map(p => [p.t - t0, +(+p.p).toFixed(4)])
      });
      log(`tape ✓ ${home} vs. ${away} (${k.stage}): ${h.length} points`);
    } catch (e) { log(`tape skip ${k.slug}: ${e.message}`); }
  }
  if (tapes.length > existing.length || force) {
    fs.writeFileSync(OUT, JSON.stringify({
      note: 'Real Polymarket price tapes of WC2026 knockout matches (1-min bars, YES token of the money-line market).',
      tapes
    }, null, 1));
  }
  return tapes;
}
