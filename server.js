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

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

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
    const rec = await publisher.publish(signal);
    signal.chain = { sig: rec.sig, explorer: rec.explorer, hash: publisher.hash(signal) };
    broadcast('published', { id: signal.id, chain: signal.chain });
    broadcast('draft', outbox.call(signal));
  });
  engine.on('entered', s => { broadcast('entered', s); commentate(pundit.entered(s)); });
  engine.on('cancelled', s => broadcast('cancelled', s));
  engine.on('resolved', s => {
    broadcast('resolved', s);
    broadcast('pnl', engine.state().pnl);
    commentate(pundit.resolved(s));
    broadcast('draft', outbox.receipt(s));
    crowd.scoreResolved(s);
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
  if (currentSrc) currentSrc.stop();
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
  src.on('end', () => broadcast('status', { mode: MODE, note: 'replay finished' }));
  src.start();
  console.log(`[fadecast] replay (${recording ? 'recorded ticks' : only || 'all matches'}, ${speed}x)`);
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
  if (url.pathname === '/api/upcoming') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(fs.readFileSync(path.join(__dirname, 'data/upcoming.json')));
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
  (MODE === 'live' || MODE === 'record' ? startLive()
    : MODE === 'follow' ? startFollow()
    : startReplay())
    .catch(e => {
      console.error('[fadecast] source failed:', e.message);
      if (MODE !== 'replay') { console.log('[fadecast] falling back to replay'); startReplay(); }
    });
});
