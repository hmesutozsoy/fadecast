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
    this.queue = [];     // signals that failed to publish (e.g. faucet empty)
  }

  _loadWallet(p) {
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

  async publish(signal) {
    const memo = JSON.stringify({
      v: 1, app: 'fadecast', id: signal.id, fixtureId: signal.fixtureId,
      side: signal.side, pre: signal.pre, det: signal.det, panic: signal.panic,
      ts: Math.round(signal.detT), h: this.hash(signal)
    });
    if (!this.enabled) {
      return { id: signal.id, sig: null, explorer: null, memo, skipped: true };
    }
    try {
      const ix = new TransactionInstruction({
        keys: [{ pubkey: this.wallet.publicKey, isSigner: true, isWritable: false }],
        programId: MEMO_PROGRAM,
        data: Buffer.from(memo, 'utf8')
      });
      const sig = await sendAndConfirmTransaction(
        this.conn, new Transaction().add(ix), [this.wallet], { commitment: 'confirmed' }
      );
      const rec = {
        id: signal.id, sig, memo,
        explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
        ts: Date.now()
      };
      this.published.push(rec);
      return rec;
    } catch (e) {
      console.warn('[solana] publish failed, queued:', e.message);
      this.queue.push(signal);
      return { id: signal.id, sig: null, explorer: null, memo, error: e.message };
    }
  }

  async flushQueue() {
    const pending = this.queue.splice(0);
    const recs = [];
    for (const s of pending) {
      const rec = await this.publish(s);
      if (rec.sig) recs.push(rec);
    }
    return recs;
  }
}
