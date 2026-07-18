// FadeCast server: wires a data source (TxLINE live or replay) into the
// overshoot engine, publishes every signal to Solana devnet, and serves the
// dashboard over HTTP + SSE.
//
//   MODE=replay node server.js   (default; real WC2022 matches, modeled prices)
//   MODE=live   node server.js   (TxLINE SSE streams; needs npm run subscribe)
//   MODE=record node server.js   (live + append ticks to data/recording.jsonl)
//   MODE=follow FILE=x.jsonl     (generic adapter: tail ANY probability-market
//                                 tick stream — crypto, elections, esports.
//                                 One JSON object per line:
//                                 {"fixtureId","outcome","price","ts","meta"})

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OvershootEngine } from './lib/overshoot.js';
import { ReplaySource, listMatches } from './lib/replay.js';
import { TxLineClient } from './lib/txline.js';
import { SignalPublisher } from './lib/solana.js';
import { Pundit } from './lib/pundit.js';
import { SocialOutbox } from './lib/social.js';
import { Crowd } from './lib/crowd.js';
import { PolymarketSource, PolymarketExecutor, MarketMaker, findMarket, upcomingMatches } from './lib/polymarket.js';
import { fetchTapes, loadTapes } from './lib/tapes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODE = process.env.MODE || 'replay';
const PORT = Number(process.env.PORT || 4747);
const SPEED = Number(process.env.SPEED || 40); // replay: match-seconds per second
const PUBLISH = process.env.PUBLISH !== '0';   // PUBLISH=0 to disable on-chain writes

const publisher = new SignalPublisher({
  walletPath: path.join(__dirname, 'data/wallet.json'),
  enabled: PUBLISH
});
const pundit = new Pundit();
const outbox = new SocialOutbox({ file: path.join(__dirname, 'data/outbox.jsonl') });
const crowd = new Crowd();
crowd.on('take', t => broadcast('take', t));
crowd.on('scored', scored => {
  broadcast('crowd', { scored, leaderboard: crowd.leaderboard() });
  // the tweets go on-chain too: hash + verdict per scored take, so the
  // "Most Fadeable" leaderboard is provable, not just the bot's record
  for (const t of scored) publisher.publishTake(t);
});
const sseClients = new Set();
const punditLog = [];
let engine;          // recreated on every replay session
let currentSrc = null;
let strategy = {};   // user overrides of the engine's fade rules
let polyExec = null; // Polymarket executor, active only in poly mode
let polyMarket = null, polySrc = null;
let mm = null;       // market maker, optional, poly mode only
let upcomingCache = { ts: 0, data: null };
let replayIdx = -1;      // attract-mode rotation cursor
let rotationTimer = null; // only ever ONE pending rotation

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}

// a public product logs and survives; it doesn't die on a dropped socket
process.on('uncaughtException', e => console.error('[fadecast] uncaught:', e.message));
process.on('unhandledRejection', e => console.error('[fadecast] unhandled rejection:', e?.message || e));

async function commentate(promise) {
  const line = await promise;
  punditLog.push(line);
  if (punditLog.length > 60) punditLog.shift();
  broadcast('pundit', line);
}

function wireEngine() {
  engine = new OvershootEngine(strategy);
  engine.on('tick', t => broadcast('tick', t));
  engine.on('signal', async signal => {
    broadcast('signal', signal);
    commentate(pundit.signal(signal));
    if (mm) mm.panic(signal); // market maker stands down during panic
    const rec = await publisher.publish(signal);
    signal.chain = { sig: rec.sig, explorer: rec.explorer, hash: publisher.hash(signal) };
    broadcast('published', { id: signal.id, chain: signal.chain });
    broadcast('draft', outbox.call(signal));
  });
  engine.on('entered', s => {
    broadcast('entered', s);
    commentate(pundit.entered(s));
    if (polyExec) polyExec.onEntered(s).then(o => o && broadcast('trade', o)).catch(() => {});
  });
  engine.on('cancelled', s => broadcast('cancelled', s));
  engine.on('resolved', s => {
    broadcast('resolved', s);
    broadcast('pnl', engine.state().pnl);
    commentate(pundit.resolved(s));
    broadcast('draft', outbox.receipt(s));
    crowd.scoreResolved(s);
    if (polyExec) polyExec.onResolved(s).then(o => o && broadcast('trade', o)).catch(() => {});
  });
}
wireEngine();

// ambient timeline chatter: a take every 10-20s (randomized) while a replay runs
(function ambientLoop() {
  setTimeout(() => {
    if (MODE === 'replay' && currentSrc && !currentSrc.stopped && engine.series.size) {
      const all = [...engine.series.values()];
      const s = all[Math.floor(Math.random() * all.length)];
      crowd.ambient({ fixtureId: s.fixtureId, meta: s.meta });
    }
    ambientLoop();
  }, 10_000 + Math.random() * 10_000);
})();

// devnet faucet rate-limits: retry funding + flush queued commitments
setInterval(async () => {
  if (!PUBLISH || publisher.queue.length === 0) return;
  await publisher.ensureFunds();
  const recs = await publisher.flushQueue();
  for (const rec of recs) {
    if (rec.kind === 'signal') {
      broadcast('published', { id: rec.id, chain: { sig: rec.sig, explorer: rec.explorer } });
    }
  }
}, 45_000);

// ---- data sources -----------------------------------------------------------

async function startReplay({ only = null, speed = SPEED } = {}) {
  clearTimeout(rotationTimer);
  if (currentSrc) currentSrc.stop();
  if (mm) { mm.stop(); mm = null; }
  polyExec = null;            // leaving the venue: replay is simulation again
  polyMarket = polySrc = null;
  wireEngine();               // fresh session: new engine, clean stats
  punditLog.length = 0;
  const recording = !only && fs.existsSync(path.join(__dirname, 'data/recording.jsonl'))
    ? path.join(__dirname, 'data/recording.jsonl') : null;
  const src = new ReplaySource({ speed, recording, only });
  currentSrc = src;
  src.on('tick', t => engine.addTick(t));
  src.on('score', g => {
    broadcast('score', g);
    commentate(pundit.goal(g));
    setTimeout(() => crowd.reactToGoal(g), 400); // the timeline piles in right after
  });
  let tickCount = 0;
  src.on('tick', () => tickCount++);
  src.on('end', () => {
    console.log(`[fadecast] ${new Date().toISOString().slice(11, 19)} replay ended (${only || 'all'}, ${tickCount} ticks)`);
    broadcast('status', { mode: MODE, note: 'replay finished — next match starting…' });
    // attract mode: the site never goes dead — rotate to the next real match
    clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      if (currentSrc !== src || MODE !== 'replay') return; // someone took over
      const ms = listMatches();
      replayIdx = (replayIdx + 1) % ms.length;
      startReplay({ only: ms[replayIdx].fixtureId, speed });
      broadcast('session', { note: 'new replay session' });
    }, 8000);
  });
  src.start();
  broadcast('session', { note: 'replay session' });
  console.log(`[fadecast] ${new Date().toISOString().slice(11, 19)} replay (${recording ? 'recorded ticks' : only || 'all matches'}, ${speed}x)`);
}

async function startLive() {
  const tx = new TxLineClient({
    network: process.env.TXLINE_NETWORK || 'devnet',
    credentialsPath: path.join(__dirname, 'data/credentials.json'),
    recordTo: MODE === 'record' ? path.join(__dirname, 'data/recording.jsonl') : null
  });
  const onOdds = (_evt, data) => {
    for (const tick of tx.normalizeOdds(data)) {
      tx.record(tick);
      engine.addTick(tick);
    }
  };
  await tx.stream('/odds/stream', onOdds);
  await tx.stream('/scores/stream', (_evt, data) =>
    broadcast('score', data)); // score events annotate the dashboard timeline
  console.log('[fadecast] live mode: TxLINE SSE connected');
}

// The real venue: live Polymarket order books in, fades out (paper by default;
// live only when the operator sets POLY_PRIVATE_KEY and POLY_TRADE=live)
async function startPoly({ slug, question }) {
  const market = await findMarket(slug, question);
  clearTimeout(rotationTimer);   // a live session outranks the attract loop
  if (currentSrc) currentSrc.stop();
  if (mm) { mm.stop(); mm = null; }
  wireEngine();
  punditLog.length = 0;
  const src = new PolymarketSource(market);
  currentSrc = src;
  polyMarket = market; polySrc = src;
  polyExec = new PolymarketExecutor(market, src, {
    mode: process.env.POLY_TRADE || 'paper',
    sizeUsd: Number(process.env.POLY_SIZE || 5),
    maxExposureUsd: Number(process.env.POLY_MAX_EXPOSURE || 15),
    maxLossUsd: Number(process.env.POLY_MAX_LOSS || 20)
  });
  src.on('tick', t => engine.addTick(t));
  src.on('error', e => console.warn('[poly]', e.message));
  src.start();
  console.log(`[fadecast] POLYMARKET LIVE: ${market.label} (trade mode: ${polyExec.mode})`);
  broadcast('status', { mode: 'polymarket', note: `live: ${market.label} · ${polyExec.mode}` });
  broadcast('session', { note: 'live session' });
  return market;
}

// Generic source: follow a JSONL file of ticks. Anything that can write a line
// of JSON can feed the engine — the detector doesn't care what the market is.
async function startFollow() {
  const file = process.env.FILE || path.join(__dirname, 'data/feed.jsonl');
  fs.appendFileSync(file, ''); // ensure it exists
  let offset = fs.statSync(file).size;
  console.log(`[fadecast] follow mode: tailing ${file}`);
  setInterval(() => {
    const size = fs.statSync(file).size;
    if (size <= offset) return;
    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line);
        engine.addTick({ ...t, ts: t.ts ?? Date.now() / 1000 });
      } catch (e) { console.warn('[follow] bad line skipped:', e.message); }
    }
  }, 500);
}

// ---- http -------------------------------------------------------------------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      mode: MODE,
      wallet: publisher.address,
      published: publisher.published.length,
      strategy: engine.p,
      trading: polyExec ? polyExec.state() : null,
      mm: mm ? mm.state() : null,
      pundit: punditLog.slice(-20),
      drafts: outbox.drafts.slice(-12),
      crowd: crowd.state(),
      ...engine.state()
    }));
  }
  // live intake: a scout agent (or curl) posts real takes from accounts you follow
  if (url.pathname === '/api/takes' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const t = JSON.parse(body);
        if (!t.handle || !t.text || !t.fixtureId) throw new Error('need handle, text, fixtureId');
        const take = crowd.add({ ...t, ts: t.ts ?? null });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: take.id }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === '/api/drafts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(outbox.drafts));
  }
  if (url.pathname === '/api/matches') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(listMatches()));
  }
  if (url.pathname === '/api/poly/start') {
    const slug = url.searchParams.get('slug');
    const question = url.searchParams.get('question') || '';
    if (!slug) { res.writeHead(400); return res.end('{"ok":false,"error":"slug required"}'); }
    startPoly({ slug, question })
      .then(m => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, market: m.label, mode: polyExec.mode })); })
      .catch(e => {
        const msg = /fetch failed/i.test(e.message)
          ? 'Polymarket is unreachable from this server\'s network (some ISPs DNS-block it — try a VPN, or use the hosted instance)'
          : e.message;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: msg }));
      });
    return;
  }
  // runtime trading config. Limits are open; the PRIVATE KEY is accepted only
  // from localhost or when the operator self-hosts with ALLOW_KEY_ENTRY=1 —
  // never collect other people's keys on a shared deployment.
  if (url.pathname === '/api/trading/config' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      try {
        const cfg = JSON.parse(body || '{}');
        if (!polyExec) return json(400, { ok: false, error: 'go live on a Polymarket market first' });
        polyExec.setLimits(cfg);
        if (cfg.disarm) polyExec.disarm();
        if (cfg.privateKey) {
          const ip = req.socket.remoteAddress || '';
          const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
          if (!local && process.env.ALLOW_KEY_ENTRY !== '1') {
            return json(403, { ok: false, error: 'key entry is disabled on shared deployments — run your own instance (see README: Arming the bot)' });
          }
          polyExec.arm({ privateKey: cfg.privateKey, signatureType: cfg.signatureType, funder: cfg.funder });
        }
        json(200, { ok: true, trading: polyExec.state() });
      } catch (e) { json(400, { ok: false, error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/mm/start') {
    if (!polyMarket || !polySrc || !polyExec) { res.writeHead(400); return res.end('{"ok":false,"error":"go live on a Polymarket market first"}'); }
    const n = (k, d) => { const v = Number(url.searchParams.get(k)); return isFinite(v) && v > 0 ? v : d; };
    if (mm) mm.stop();
    mm = new MarketMaker(polyMarket, polySrc, polyExec, {
      spread: n('spread', 2) / 100,       // cents on the wire
      sizeUsd: n('size', 5),
      maxInventoryUsd: n('maxInv', 20),
      pauseSec: n('pause', 90),
      mode: polyExec.mode === 'live' ? 'live' : 'paper'
    });
    mm.start();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, mm: mm.state() }));
  }
  if (url.pathname === '/api/mm/stop') {
    if (mm) { mm.stop(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, mm: mm ? mm.state() : null }));
  }
  if (url.pathname === '/api/upcoming') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const now = Date.now();
    if (upcomingCache.data && now - upcomingCache.ts < 300_000) {
      return res.end(JSON.stringify(upcomingCache.data));
    }
    upcomingMatches()
      .then(matches => {
        upcomingCache = { ts: now, data: { source: 'polymarket', matches } };
        res.end(JSON.stringify(upcomingCache.data));
      })
      .catch(() => {
        // schedule fetch failed: fall back to the checked-in snapshot
        res.end(fs.readFileSync(path.join(__dirname, 'data/upcoming.json')));
      });
    return;
  }
  if (url.pathname === '/api/replay/speed' && MODE === 'replay') {
    if (currentSrc && typeof currentSrc.speed === 'number') {
      currentSrc.speed = Math.min(currentSrc.speed * Number(url.searchParams.get('mult') || 2), 2000);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, speed: currentSrc?.speed ?? null }));
  }
  if (url.pathname === '/api/replay/skip' && MODE === 'replay') {
    if (currentSrc && typeof currentSrc.speed === 'number') currentSrc.speed = 1e9; // drain to the end
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, skipping: !!currentSrc }));
  }
  if (url.pathname === '/api/replay/stop' && MODE === 'replay') {
    if (currentSrc) currentSrc.stop();
    broadcast('status', { mode: MODE, note: 'replay stopped' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, stopped: true }));
  }
  if (url.pathname === '/api/replay' && MODE === 'replay') {
    const only = url.searchParams.get('match') || null;
    const speed = Number(url.searchParams.get('speed')) || SPEED;
    // custom fade rules: probability points on the wire, decimals in the engine
    const q = k => url.searchParams.get(k);
    const num = (k, div = 1) => (q(k) !== null && q(k) !== '' && isFinite(Number(q(k)))) ? Number(q(k)) / div : undefined;
    const next = {
      threshold: num('threshold', 100),   // pts -> prob
      confirm: num('confirm'),            // seconds
      hold: num('hold'),                  // seconds
      stopLoss: num('stop', 100),         // pts -> prob
      side: ['fade', 'ride'].includes(q('side')) ? q('side') : undefined,
      band: (num('bandLo', 100) !== undefined && num('bandHi', 100) !== undefined)
        ? [num('bandLo', 100), num('bandHi', 100)] : undefined
    };
    strategy = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
    startReplay({ only: only === 'all' ? null : only, speed });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, only, speed, strategy }));
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ mode: MODE, wallet: publisher.address })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    res.on('error', () => sseClients.delete(res));   // mass reloads drop sockets mid-write
    req.on('error', () => sseClients.delete(res));
    return;
  }
  // static
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const fp = path.join(__dirname, 'public', path.normalize(file));
  if (fp.startsWith(path.join(__dirname, 'public')) && fs.existsSync(fp)) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(fp));
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, async () => {
  console.log(`[fadecast] http://localhost:${PORT}  mode=${MODE} publish=${PUBLISH}`);
  console.log(`[fadecast] agent wallet: ${publisher.address}`);
  if (PUBLISH) await publisher.ensureFunds().then(b => console.log(`[fadecast] devnet balance: ${b / 1e9} SOL`));
  // self-populate real 2026 knockout tapes when the host can reach Polymarket
  // (fire-and-forget: replays fall back to 2022 modeled matches until then)
  if (loadTapes().length < 6) {
    fetchTapes({ log: m => console.log(`[fadecast] ${m}`) })
      .then(t => { if (t.length) console.log(`[fadecast] ${t.length} real 2026 tapes ready — next replay uses them`); })
      .catch(e => console.log(`[fadecast] tape fetch failed: ${e.message}`));
  }
  (MODE === 'live' || MODE === 'record' ? startLive()
    : MODE === 'follow' ? startFollow()
    : MODE === 'poly' ? startPoly({ slug: process.env.POLY_SLUG, question: process.env.POLY_QUESTION || '' })
    : startReplay())
    .catch(e => {
      console.error('[fadecast] source failed:', e.message);
      if (MODE !== 'replay') { console.log('[fadecast] falling back to replay'); startReplay(); }
    });
});
