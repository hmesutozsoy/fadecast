// On-chain signal publisher: every fade signal is committed to Solana devnet
// BEFORE it resolves, via a Memo transaction. That makes the agent's track
// record auditable — it cannot cherry-pick winners after the fact.
//
// Memo payload (compact JSON, <566 bytes):
//   { v:1, app:"fadecast", id, fixtureId, side, pre, det, panic, ts, h }
// where h = first 16 hex chars of sha256 over the full signal object, so the
// off-chain record can be integrity-checked against the on-chain commitment.

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction
} from '@solana/web3.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export class SignalPublisher {
  constructor({ walletPath = 'data/wallet.json', rpcUrl = 'https://api.devnet.solana.com', enabled = true } = {}) {
    this.enabled = enabled;
    this.conn = new Connection(rpcUrl, 'confirmed');
    this.wallet = this._loadWallet(walletPath);
    this.published = []; // {id, sig, explorer, ts}
    this.queue = [];     // {kind: 'signal'|'take', data} that failed to publish
    this._chain = Promise.resolve(); // serialize sends — devnet RPC dislikes bursts
  }

  _serialize(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  _loadWallet(p) {
    // Persistent identity for ephemeral-disk hosts (Render), tried in order:
    // WALLET_SECRET env var → /etc/secrets/WALLET_SECRET (Render Secret File)
    // → local data/wallet.json → freshly generated. A malformed value logs
    // loudly and falls through instead of crash-looping the deploy.
    const sources = [
      ['WALLET_SECRET env', () => process.env.WALLET_SECRET],
      ['secret file', () => fs.existsSync('/etc/secrets/WALLET_SECRET') && fs.readFileSync('/etc/secrets/WALLET_SECRET', 'utf8')],
      [p, () => fs.existsSync(p) && fs.readFileSync(p, 'utf8')]
    ];
    for (const [name, get] of sources) {
      try {
        const raw = get();
        if (!raw || !String(raw).trim()) continue;
        const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(String(raw).trim())));
        console.log(`[solana] wallet loaded from ${name}: ${kp.publicKey.toBase58()}`);
        return kp;
      } catch (e) {
        console.warn(`[solana] ${name} present but unusable (${e.message.split('\n')[0]}) — trying next source`);
      }
    }
    const kp = Keypair.generate();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify([...kp.secretKey]));
    console.log(`[solana] generated a fresh wallet: ${kp.publicKey.toBase58()} (set WALLET_SECRET to keep one identity across deploys)`);
    return kp;
  }

  get address() { return this.wallet.publicKey.toBase58(); }

  async ensureFunds() {
    const bal = await this.conn.getBalance(this.wallet.publicKey);
    if (bal > 0.01 * LAMPORTS_PER_SOL) return bal;
    try {
      const sig = await this.conn.requestAirdrop(this.wallet.publicKey, LAMPORTS_PER_SOL);
      await this.conn.confirmTransaction(sig, 'confirmed');
      return this.conn.getBalance(this.wallet.publicKey);
    } catch (e) {
      // devnet faucet rate-limits aggressively; publishing degrades gracefully
      console.warn('[solana] airdrop failed:', e.message);
      return bal;
    }
  }

  hash(signal) {
    return createHash('sha256').update(JSON.stringify(signal)).digest('hex').slice(0, 16);
  }

  async _sendMemo(memo) {
    const ix = new TransactionInstruction({
      keys: [{ pubkey: this.wallet.publicKey, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM,
      data: Buffer.from(memo, 'utf8')
    });
    return sendAndConfirmTransaction(
      this.conn, new Transaction().add(ix), [this.wallet], { commitment: 'confirmed' }
    );
  }

  async _commit(kind, id, memo, data) {
    if (!this.enabled) return { id, sig: null, explorer: null, memo, skipped: true };
    try {
      const sig = await this._serialize(() => this._sendMemo(memo));
      const rec = {
        id, kind, sig, memo,
        explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
        ts: Date.now()
      };
      this.published.push(rec);
      return rec;
    } catch (e) {
      console.warn(`[solana] ${kind} commit failed, queued:`, e.message.split('\n')[0]);
      this.queue.push({ kind, data });
      return { id, sig: null, explorer: null, memo, error: e.message };
    }
  }

  // the bot's fade call, committed before resolution
  publish(signal) {
    const memo = JSON.stringify({
      v: 1, app: 'fadecast', id: signal.id, fixtureId: signal.fixtureId,
      side: signal.side, pre: signal.pre, det: signal.det, panic: signal.panic,
      ts: Math.round(signal.detT), h: this.hash(signal)
    });
    return this._commit('signal', signal.id, memo, signal);
  }

  // a scored timeline take: the tweet's hash + verdict, receipts for the
  // "Most Fadeable" leaderboard
  publishTake(take) {
    const memo = JSON.stringify({
      v: 1, app: 'fadecast', kind: 'take', id: take.id, handle: take.handle,
      fixtureId: take.fixtureId, stance: take.stance, verdict: take.verdict,
      h: this.hash({ handle: take.handle, text: take.text, fixtureId: take.fixtureId })
    });
    return this._commit('take', take.id, memo, take);
  }

  async flushQueue() {
    const pending = this.queue.splice(0);
    const recs = [];
    for (const item of pending) {
      const rec = item.kind === 'take'
        ? await this.publishTake(item.data)
        : await this.publish(item.data);
      if (rec.sig) recs.push(rec);
    }
    return recs;
  }
}
