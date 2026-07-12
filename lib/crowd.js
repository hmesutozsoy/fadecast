// The Timeline: hot takes about the match, and the receipts for them.
//
// A take is one post from one account with a stance:
//   'panic'  — riding the move (the goal changes everything, it's over, etc.)
//   'contra' — fading the move alongside the bot
//
// When a fade signal on that fixture resolves, nearby takes get scored:
// if the bot's fade WON, the panic takes were wrong (and fadeable). Per-handle
// records accumulate into the "Most Fadeable" leaderboard — the people you
// should always bet against.
//
// Demo mode synthesizes takes from CT-style personas reacting to real match
// events. Live mode ingests real posts via POST /api/takes (e.g. from a
// scout agent scanning accounts you follow):
//   { handle, text, fixtureId, stance?, ts? }   — stance defaults to 'panic'

import { EventEmitter } from 'node:events';

const PERSONAS = [
  { handle: '@degenCarlos', style: p => p.pick([
    `${p.team} GOAL. ${p.other} is COOKED. market still hasn't fully priced this in, getting in NOW`,
    `${p.scorer} just ended the game. max size on ${p.team}, thank me later 🫡`,
    `${p.other} fans real quiet rn 💀 adding to my ${p.team} bag`
  ]) },
  { handle: '@wagmi_aunty', style: p => p.pick([
    `omg ${p.scorer}!!! ${p.team} is SO back. this one's over, calling it ✅`,
    `${p.team} 🤝 destiny. ${p.other} never had it. locked in my bet 😤`,
    `me after that ${p.team} goal: portfolio goes brrr 📈📈`
  ]) },
  { handle: '@xG_enjoyer', style: p => p.pick([
    `xG says this was coming. ${p.team} deserved that. ${p.other} win prob should be single digits now tbh`,
    `${p.scorer} goal = massive swing. model has ${p.other} basically drawing dead here`,
    `market repricing ${p.other} hard and honestly? justified. the underlying numbers are brutal`
  ]) },
  { handle: '@fulltime_fader', style: p => p.pick([
    `everyone dumping ${p.other} after one goal?? free money the other way, this is an overreaction`,
    `timeline in full panic about ${p.other}. that's usually the exact moment to take the other side`,
    `one goal and the market moves THIS much? i'm fading you all, see you at full time`
  ]), contra: true },
  { handle: '@ct_oracle', style: p => p.pick([
    `${p.team} scores and the sheep stampede. sigh. bookmark this: it won't hold`,
    `respectfully, if you're market-buying ${p.team} at the top of this candle, you're exit liquidity`,
    `${p.scorer} goal is real, the REPRICING is not. patience.`
  ]), contra: true }
];

// ambient chatter: fills the timeline between goals. Never scored — it's the
// background hum of a live timeline, not a falsifiable call.
const AMBIENT = [
  '{home} vs {away} is pure chess right now. someone blink',
  'odds barely moving… the calm before someone ruins a parlay',
  'my {home} position is aging like milk and this game is still 0-0 energy',
  "keeper's touched the ball once in 20 minutes. bet builders in shambles",
  'refreshing the odds like it changes anything 📉',
  'whole timeline watching {home} vs {away} pretending they had it pregame',
  '{away} pressing high. degens pricing hopium again',
  'this market is asleep. wake me up at the next goal',
  'imagine fading {home} here. couldn\'t be me (it was me, once)',
  'line hasn\'t moved in ages — either nothing is happening or EVERYTHING is about to'
];

// deterministic-ish rotation so replays feel varied but stable
let takeCounter = 0;

export class Crowd extends EventEmitter {
  constructor() {
    super();
    this.takes = [];               // {id, handle, text, fixtureId, stance, ts, verdict}
    this.records = new Map();      // handle -> {takes, wrong}
  }

  // demo mode: the timeline reacts to a goal (1 contrarian for every 2-3 panickers)
  reactToGoal(goal) {
    const n = 2 + (takeCounter % 2);           // 2-3 takes per goal
    const start = takeCounter;
    const out = [];
    for (let i = 0; i < n; i++) {
      const persona = PERSONAS[(start + i * 2 + 1) % PERSONAS.length];
      const ctx = {
        team: goal.team,
        other: goal.team === goal.meta?.home ? goal.meta?.away : goal.meta?.home,
        scorer: (goal.scorer || goal.team).replace(/ \(pen\)/, ''),
        pick: arr => arr[(start + i) % arr.length]
      };
      takeCounter++;
      out.push(this.add({
        handle: persona.handle,
        text: persona.style(ctx),
        fixtureId: goal.fixtureId,
        stance: persona.contra ? 'contra' : 'panic',
        ts: goal.ts
      }));
    }
    return out;
  }

  // demo mode: background chatter between goals (never scored)
  ambient({ fixtureId, meta }) {
    const persona = PERSONAS[Math.floor(Math.random() * PERSONAS.length)];
    const text = AMBIENT[Math.floor(Math.random() * AMBIENT.length)]
      .replace('{home}', meta?.home || 'the favorite')
      .replace('{away}', meta?.away || 'the underdog');
    return this.add({ handle: persona.handle, text, fixtureId, stance: 'chatter' });
  }

  // live intake contract (scout agent / POST /api/takes)
  add({ handle, text, fixtureId, stance = 'panic', ts = null }) {
    const take = {
      id: `take_${++takeCounter}`,
      handle, text, fixtureId, stance, ts,
      verdict: null                     // null -> 'wrong' | 'right' once scored
    };
    this.takes.push(take);
    if (this.takes.length > 200) this.takes.shift();
    if (stance === 'panic' || stance === 'contra') {   // chatter doesn't count as a call
      const r = this.records.get(handle) || { takes: 0, wrong: 0 };
      r.takes++;
      this.records.set(handle, r);
    }
    this.emit('take', take);
    return take;
  }

  latestFor(fixtureId) {
    for (let i = this.takes.length - 1; i >= 0; i--) {
      const t = this.takes[i];
      if (t.fixtureId === fixtureId && t.stance === 'panic' && !t.verdict) return t;
    }
    return null;
  }

  // a fade resolved: score every unscored take on that fixture posted near it
  scoreResolved(signal) {
    const botWon = signal.pnl > 0;
    const scored = [];
    for (const t of this.takes) {
      if (t.verdict || t.fixtureId !== signal.fixtureId) continue;
      if (t.stance !== 'panic' && t.stance !== 'contra') continue; // chatter is never scored
      if (t.ts !== null && Math.abs(t.ts - signal.detT) > 300) continue;
      const wasWrong = t.stance === 'panic' ? botWon : !botWon;
      t.verdict = wasWrong ? 'wrong' : 'right';
      if (wasWrong) this.records.get(t.handle).wrong++;
      scored.push(t);
    }
    if (scored.length) this.emit('scored', scored);
    return scored;
  }

  leaderboard() {
    return [...this.records.entries()]
      .map(([handle, r]) => ({ handle, takes: r.takes, wrong: r.wrong, fadeRate: r.takes ? Math.round(100 * r.wrong / r.takes) : 0 }))
      .filter(x => x.takes > 0)
      .sort((a, b) => b.fadeRate - a.fadeRate || b.wrong - a.wrong)
      .slice(0, 8);
  }

  state() {
    return { takes: this.takes.slice(-25), leaderboard: this.leaderboard() };
  }
}
