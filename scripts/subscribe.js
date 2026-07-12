// One-time TxLINE free-tier onboarding (devnet):
//   1. subscribe on-chain (free service level, no TxL payment — SOL fees only)
//   2. get a guest JWT
//   3. sign `${txSig}:${leagues}:${jwt}` with the same wallet
//   4. POST /api/token/activate -> apiToken
// Credentials land in data/credentials.json, which lib/txline.js reads.
//
// Prereqs: devnet SOL in the agent wallet (data/wallet.json — server.js prints
// the address; fund via https://faucet.solana.com) and the devnet txoracle IDL
// from TxLINE's runnable examples repo saved as scripts/idl/txoracle.json.

import anchor from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import nacl from 'tweetnacl';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NETWORK = process.env.TXLINE_NETWORK || 'devnet';

const CONFIG = {
  mainnet: {
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    apiOrigin: 'https://txline.txodds.com',
    programId: new PublicKey('9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA'),
    txlTokenMint: new PublicKey('Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL')
  },
  devnet: {
    rpcUrl: 'https://api.devnet.solana.com',
    apiOrigin: 'https://txline-dev.txodds.com',
    programId: new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J'),
    txlTokenMint: new PublicKey('4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG')
  }
}[NETWORK];

const SERVICE_LEVEL_ID = Number(process.env.SERVICE_LEVEL || 1); // free tier
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES = []; // standard free bundle

async function main() {
  const walletPath = path.join(__dirname, '../data/wallet.json');
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, 'utf8'))));
  const wallet = new anchor.Wallet(payer);
  const connection = new Connection(CONFIG.rpcUrl, 'confirmed');
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const bal = await connection.getBalance(payer.publicKey);
  console.log(`wallet ${payer.publicKey.toBase58()} balance ${bal / 1e9} SOL on ${NETWORK}`);
  if (bal === 0) throw new Error('Fund the wallet first (https://faucet.solana.com for devnet).');

  const perNetwork = path.join(__dirname, `idl/txoracle.${NETWORK}.json`);
  const idlPath = fs.existsSync(perNetwork) ? perNetwork : path.join(__dirname, 'idl/txoracle.json');
  if (!fs.existsSync(idlPath)) {
    throw new Error('Missing scripts/idl/txoracle.json — copy the matching IDL from TxLINE\'s runnable devnet examples (github.com/txodds).');
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  const program = new anchor.Program(idl, provider);
  if (!program.programId.equals(CONFIG.programId)) {
    throw new Error(`IDL program ${program.programId} does not match ${NETWORK} program ${CONFIG.programId}`);
  }

  // 1. on-chain subscribe
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from('token_treasury_v2')], program.programId);
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from('pricing_matrix')], program.programId);
  const tokenTreasuryVault = getAssociatedTokenAddressSync(CONFIG.txlTokenMint, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userTokenAccount = getAssociatedTokenAddressSync(CONFIG.txlTokenMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const txSig = await program.methods
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .accounts({
      user: payer.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: CONFIG.txlTokenMint,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId
    })
    .rpc();
  console.log('subscribe tx:', txSig);

  // 2. guest JWT
  const authResp = await fetch(`${CONFIG.apiOrigin}/auth/guest/start`, { method: 'POST' });
  const jwt = (await authResp.json()).token;

  // 3. sign activation message with the subscribing wallet
  const message = new TextEncoder().encode(`${txSig}:${SELECTED_LEAGUES.join(',')}:${jwt}`);
  const walletSignature = Buffer.from(nacl.sign.detached(message, payer.secretKey)).toString('base64');

  // 4. activate
  const actResp = await fetch(`${CONFIG.apiOrigin}/api/token/activate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ txSig, walletSignature, leagues: SELECTED_LEAGUES })
  });
  if (!actResp.ok) throw new Error(`activate ${actResp.status}: ${await actResp.text()}`);
  const body = await actResp.json();
  const apiToken = body.token || body;

  const credsPath = path.join(__dirname, '../data/credentials.json');
  fs.writeFileSync(credsPath, JSON.stringify({ jwt, apiToken, network: NETWORK, txSig }, null, 2));
  console.log(`activated — credentials saved to ${credsPath}. Run: npm run live`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
