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
  }

  _loadWallet(p) {
    // WALLET_SECRET (the JSON array from data/wallet.json) lets ephemeral-disk
    // hosts like Render keep one persistent identity across deploys
    if (process.env.WALLET_SECRET) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.WALLET_SECRET)));
    }
    if (fs.existsSync(p)) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
    }
    const kp = Keypair.generate();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify([...kp.secretKey]));
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
      const sig = await this._sendMemo(memo);
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
