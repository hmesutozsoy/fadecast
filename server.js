// FadeCast server: wires a data source (TxLINE live or replay) into the
// overshoot engine, publishes every signal to Solana devnet, and serves the
// dashboard over HTTP + SSE.
//
//   MODE=replay node server.js   (default; deterministic demo)
//   MODE=live   node server.js   (TxLINE SSE streams; needs npm run subscribe)
//   MODE=record node server.js   (live + append ticks to data/recording.jsonl)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OvershootEngine } from './lib/overshoot.js';
import { ReplaySource } from './lib/replay.js';
import { TxLineClient } from './lib/txline.js';
import { SignalPublisher } from './lib/solana.js';
import { Pundit } from './lib/pundit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODE = process.env.MODE || 'replay';
const PORT = Number(process.env.PORT || 4747);
const SPEED = Number(process.env.SPEED || 40); // replay: match-seconds per second
const PUBLISH = process.env.PUBLISH !== '0';   // PUBLISH=0 to disable on-chain writes

const engine = new OvershootEngine();
const publisher = new SignalPublisher({
  walletPath: path.join(__dirname, 'data/wallet.json'),
  enabled: PUBLISH
});
const pundit = new Pundit();
const sseClients = new Set();
const punditLog = [];

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

engine.on('tick', t => broadcast('tick', t));
engine.on('signal', async signal => {
  broadcast('signal', signal);
  commentate(pundit.signal(signal));
  const rec = await publisher.publish(signal);
  signal.chain = { sig: rec.sig, explorer: rec.explorer, hash: publisher.hash(signal) };
  broadcast('published', { id: signal.id, chain: signal.chain });
});
engine.on('entered', s => { broadcast('entered', s); commentate(pundit.entered(s)); });
engine.on('resolved', s => {
  broadcast('resolved', s);
  broadcast('pnl', engine.state().pnl);
  commentate(pundit.resolved(s));
});

// devnet faucet rate-limits: retry funding + flush queued commitments
setInterval(async () => {
  if (!PUBLISH || publisher.queue.length === 0) return;
  await publisher.ensureFunds();
  const recs = await publisher.flushQueue();
  for (const rec of recs) {
    broadcast('published', { id: rec.id, chain: { sig: rec.sig, explorer: rec.explorer } });
  }
}, 45_000);

// ---- data sources -----------------------------------------------------------

async function startReplay() {
  const recording = fs.existsSync(path.join(__dirname, 'data/recording.jsonl'))
    ? path.join(__dirname, 'data/recording.jsonl') : null;
  const src = new ReplaySource({ speed: SPEED, recording });
  src.on('tick', t => engine.addTick(t));
  src.on('score', g => { broadcast('score', g); commentate(pundit.goal(g)); });
  src.on('end', () => broadcast('status', { mode: MODE, note: 'replay finished' }));
  src.start();
  console.log(`[fadecast] replay mode (${recording ? 'recorded ticks' : 'synthetic matches'}, ${SPEED}x)`);
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
      pundit: punditLog.slice(-20),
      ...engine.state()
    }));
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
  (MODE === 'live' || MODE === 'record' ? startLive() : startReplay())
    .catch(e => {
      console.error('[fadecast] source failed:', e.message);
      if (MODE !== 'replay') { console.log('[fadecast] falling back to replay'); startReplay(); }
    });
});
