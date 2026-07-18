// Replay data source: emits the same {fixtureId, outcome, price, ts, meta} ticks
// as the live TxLINE client, so the engine never knows the difference.
//
// Two modes:
//   - synthetic: seeded scripted matches (goals -> jump + decaying overshoot +
//     noise), deterministic so the demo video is repeatable
//   - recorded: data/*.jsonl files captured from the live stream by lib/txline.js
//
// Judging note: live World Cup activity may not be running during review, so
// this replay IS the demo path, at accelerated wall-clock speed.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { loadTapes } from './tapes.js';

// mulberry32: tiny seeded PRNG so replays are deterministic
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Real World Cup 2022 fixtures — actual goal minutes, scorers, and results
// (data/matches.json). The price path between events is modeled; the events
// themselves are history.
function loadMatches() {
  const p = new URL('../data/matches.json', import.meta.url);
  return JSON.parse(fs.readFileSync(p, 'utf8')).matches;
}

export function listMatches() {
  // real 2026 knockout tapes when available; 2022 modeled replays otherwise
  const tapes = loadTapes();
  if (tapes.length) {
    return tapes.map(t => ({ fixtureId: t.fixtureId, label: `${t.home} vs ${t.away} (${t.stage})`, result: t.result }));
  }
  return loadMatches().map(m => ({
    fixtureId: m.fixtureId, label: `${m.home} vs ${m.away}`, result: m.result
  }));
}

// Real match events (data/events.json): actual goals/cards/penalties at their
// real minutes + real post-match quotes, each with source + X-search links.
function loadEvents() {
  try {
    const p = new URL('../data/events.json', import.meta.url);
    return JSON.parse(fs.readFileSync(p, 'utf8')).events || {};
  } catch { return {}; }
}

// Real X posts calling these matches (data/posts.json) — verified accounts,
// actual status URLs. They drop in pre-match; the tape's end settles their
// verdicts, scores the leaderboard, and commits each on-chain.
function loadPosts() {
  try {
    const p = new URL('../data/posts.json', import.meta.url);
    return JSON.parse(fs.readFileSync(p, 'utf8')).posts || [];
  } catch { return []; }
}

// match minute → tape offset: tapes start ~15min before kickoff, and clock
// stops for halftime (~15min) and the extra-time break (~5min)
const minToTs = min => 900 + min * 60 + (min > 45 ? 900 : 0) + (min > 90 ? 300 : 0);

// real recorded Polymarket tape → replay ticks + real match events
export function* tapeTicks(only = null) {
  const tapes = loadTapes().filter(t => !only || t.fixtureId === only);
  const events = loadEvents();
  const all = [];
  for (const t of tapes) {
    const meta = { home: t.home, away: t.away, label: t.label, result: t.result, real: true, tape: true };
    const lastTs = t.ticks.length ? t.ticks[t.ticks.length - 1][0] : 0;
    for (const [ts, p] of t.ticks) {
      all.push({ fixtureId: t.fixtureId, outcome: 'yes', price: p, ts, meta });
    }
    loadPosts().filter(p => p.fixtureId === t.fixtureId).forEach((p, i) => {
      all.push({
        kind: 'post', fixtureId: t.fixtureId, ts: 60 + i * 150, meta,
        handle: p.handle, text: p.text, url: p.url, followers: p.followers,
        stance: 'call', preset: p.verdict
      });
    });
    for (const ev of events[t.fixtureId] || []) {
      const ts = Math.min(minToTs(ev.min), lastTs);
      if (ev.type === 'goal') {
        all.push({
          kind: 'goal', fixtureId: t.fixtureId, ts, meta,
          team: ev.team === 'home' ? t.home : t.away,
          minute: ev.min, scorer: ev.player
        });
      }
      all.push({
        kind: 'post', fixtureId: t.fixtureId, ts: ts + 5, meta,
        handle: ev.handle || '⚽ match feed', text: ev.text,
        source: ev.source, xq: ev.x
      });
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  yield* all;
}

export function* syntheticTicks(seed = 7, only = null) {
  // Fair-value + decaying-overshoot model, the shape the batch analyzer measured
  // on real in-play data: a goal reprices FAIR instantly, the market runs PAST
  // fair (the overshoot), then decays back to fair over ~3 minutes. Tick cadence
  // does not affect magnitudes.
  const all = [];
  let matchSeed = seed;
  const matches = loadMatches().filter(m => !only || m.fixtureId === only);
  for (const m of matches) {
    const rand = rng(matchSeed++);
    const meta = {
      home: m.home, away: m.away,
      label: `${m.home} vs ${m.away}`,
      result: m.result, real: true
    };
    let fair = m.p0;
    let over = 0;        // overshoot component, decays exponentially
    let noise = 0;       // mean-reverting micro-noise
    let smooth = m.p0;   // traded price chases fair value — real books take
                         // tens of seconds to reprice a goal, not one tick
    let prevSec = 0;
    const fired = new Set();
    for (let sec = 0; sec <= 95 * 60; sec += 4 + Math.floor(rand() * 5)) {
      const dt = sec - prevSec; prevSec = sec;
      over *= Math.exp(-dt / 150);
      noise += (rand() - 0.5) * 0.005 - noise * 0.05;

      for (const g of m.goals) {
        const gs = g.min * 60;
        if (sec >= gs && !fired.has(g)) {
          fired.add(g);
          const dir = g.team === 'home' ? 1 : -1;
          const late = 0.10 + 0.10 * (g.min / 90);          // late goals reprice harder
          fair = clamp(fair + dir * late);
          over += dir * (0.06 + rand() * 0.06);             // the market panics past fair
          all.push({
            kind: 'goal', fixtureId: m.fixtureId, ts: gs, meta,
            team: g.team === 'home' ? m.home : m.away,
            minute: g.min, scorer: g.scorer
          });
        }
      }
      const raw = clamp(fair + over + noise);
      smooth += (raw - smooth) * (1 - Math.exp(-dt / 18));
      all.push({
        fixtureId: m.fixtureId, outcome: 'home',
        price: clamp(smooth), ts: sec, meta
      });
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  yield* all;
}

const clamp = p => Math.max(0.02, Math.min(0.98, p));

export function* recordedTicks(path) {
  const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const ticks = lines.map(l => JSON.parse(l)).sort((a, b) => a.ts - b.ts);
  const t0 = ticks.length ? ticks[0].ts : 0;
  for (const t of ticks) yield { ...t, ts: t.ts - t0 };
}

export class ReplaySource extends EventEmitter {
  /** speed: match-seconds per wall-second (e.g. 60 = a half in ~23s) */
  constructor({ speed = 30, recording = null, seed = 7, only = null } = {}) {
    super();
    this.speed = speed;   // mutable at runtime: /api/replay/speed and /skip
    this.gen = recording ? recordedTicks(recording)
      : loadTapes().length ? tapeTicks(only)
      : syntheticTicks(seed, only);
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    let clock = null; // match-time of the previous tick
    const step = () => {
      if (this.stopped) return;
      const { value, done } = this.gen.next();
      if (done) { this.emit('end'); return; }
      const wait = clock === null ? 0 : Math.max(0, (value.ts - clock) / this.speed) * 1000;
      clock = value.ts;
      setTimeout(() => {
        if (this.stopped) return; // a restart may land between schedule and fire
        this.emit(value.kind === 'goal' ? 'score' : value.kind === 'post' ? 'post' : 'tick', value);
        step();
      }, Math.min(wait, 1000)); // cap: 1-min tape bars pace at ≤1s per point
    };
    step();
    return this;
  }

  stop() { this.stopped = true; }
}
