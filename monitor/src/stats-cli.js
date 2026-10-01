#!/usr/bin/env node
// monitor/src/stats-cli.js
//
// Beta numbers from the chain, for the weekly review and the "first 24 hours" / "one month" posts.
//
//   npm run stats                                   everything since the pools were created
//   npm run stats -- --since 2026-10-06             from a UTC date (or ISO time) on
//   npm run stats -- --since 2026-10-06 --until 2026-10-13
//   npm run stats -- --since 2026-10-06 --json      machine-readable
//
// Environment (the monitor's .env works): SOLANA_RPC_URL, PROGRAM_ID, POOLS (comma-separated pool
// addresses), STATS_EXCLUDE (comma-separated wallets to leave out: the project's own test wallets).
// Pool labels come from the pool accounts themselves (their denomination).

import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { actionsInTransaction, tally } from "./stats.js";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const toUnix = (s, name) => {
  if (!s) return undefined;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(t)) throw new Error(`--${name} must be a date (2026-10-06) or an ISO time, got "${s}"`);
  return Math.floor(t / 1000);
};
const list = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = process.env.PROGRAM_ID || "DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59";
const POOLS = list(process.env.POOLS);
const EXCLUDE = list(process.env.STATS_EXCLUDE);
let since, until;
try {
  since = toUnix(opt("since"), "since");
  until = toUnix(opt("until"), "until");
} catch (e) {
  console.error(`stats: ${e.message}`);
  process.exit(2);
}
const asJson = args.includes("--json");
if (!POOLS.length) {
  console.error("stats: set POOLS (comma-separated pool addresses), as for the monitor.");
  process.exit(2);
}

const connection = new Connection(RPC_URL, "confirmed");
const rpc = async (method, params) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await connection._rpcRequest(method, params);
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); // rate limits: back off and retry
    }
  }
};

/** Every signature that touched the pool, newest first, stopping once older than `since`. */
async function signatures(pool) {
  const out = [];
  let before;
  for (;;) {
    const page = await connection.getSignaturesForAddress(new PublicKey(pool), { before, limit: 1000 });
    for (const s of page) {
      if (since !== undefined && s.blockTime != null && s.blockTime < since) return out;
      if (!s.err && (until === undefined || s.blockTime == null || s.blockTime < until)) out.push(s.signature);
    }
    if (page.length < 1000) return out;
    before = page[page.length - 1].signature;
  }
}

const labels = {};
for (const pool of POOLS) {
  const info = await connection.getAccountInfo(new PublicKey(pool));
  const denom = info?.data?.length >= 80 ? info.data.readBigUInt64LE(8 + 64) : null;
  labels[pool] = denom === null ? pool.slice(0, 8) : `${Number(denom) / 1e9} SOL`;
}

const seen = new Set();
const txs = [];
for (const pool of POOLS) {
  const sigs = (await signatures(pool)).filter((s) => !seen.has(s) && seen.add(s));
  for (let i = 0; i < sigs.length; i += 8) {
    const batch = await Promise.all(
      sigs.slice(i, i + 8).map((s) => rpc("getTransaction", [s, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]))
    );
    for (const r of batch) {
      const tx = r?.result;
      if (tx) txs.push({ blockTime: tx.blockTime ?? 0, actions: actionsInTransaction(tx, PROGRAM_ID, (d) => bs58.decode(d)) });
    }
  }
}

const result = tally(txs, { pools: labels, since, until, exclude: EXCLUDE });
const window = `${since ? new Date(since * 1000).toISOString().slice(0, 16) + "Z" : "the start"} to ${until ? new Date(until * 1000).toISOString().slice(0, 16) + "Z" : "now"}`;
if (asJson) {
  console.log(JSON.stringify({ window: { since: since ?? null, until: until ?? null }, ...result }, null, 2));
} else {
  console.log(`Beta numbers, ${window} (${txs.length} transactions read)`);
  console.log("  pool        deposits  withdrawals  depositing wallets");
  for (const r of result.rows) {
    console.log(`  ${r.label.padEnd(10)} ${String(r.deposits).padStart(9)} ${String(r.withdrawals).padStart(12)} ${String(r.wallets).padStart(19)}`);
  }
  console.log(`  ${"total".padEnd(10)} ${String(result.total.deposits).padStart(9)} ${String(result.total.withdrawals).padStart(12)} ${String(result.total.wallets).padStart(19)}  (wallets counted once across pools)`);
  if (EXCLUDE.length) console.log(`  left out ${result.excludedDeposits} deposit(s) from ${EXCLUDE.length} excluded wallet(s) (STATS_EXCLUDE)`);
  console.log("  Wallets, not people: one person can use several. Withdrawals come from the relayer, so they");
  console.log("  identify nobody.");
}
