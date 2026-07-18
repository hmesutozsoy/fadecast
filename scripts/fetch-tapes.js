// Fetch the REAL WC2026 knockout market tapes from Polymarket into
// data/tapes.json. Run: node scripts/fetch-tapes.js  (needs Polymarket access —
// some ISPs DNS-block it; use a VPN or run on the deployed host)
import { fetchTapes } from '../lib/tapes.js';
const tapes = await fetchTapes({ force: true });
console.log(`\ndata/tapes.json now holds ${tapes.length} tapes`);
