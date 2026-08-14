#!/usr/bin/env node
"use strict";

/**
 * scripts/check_pools.js
 *
 * Verifies that every pool the frontend advertises is deployed AND pays its treasury
 * fee to the address you expect.
 *
 * Why this exists: the treasury is fixed at pool creation and CANNOT be changed — that
 * is a deliberate security property (the admin cannot redirect fees after users have
 * deposited). The consequence is that a mis-set treasury is unfixable: the pool must be
 * abandoned and recreated at a new address, and any fees already collected are gone.
 *
 * That happened on devnet. The 1 SOL pool advertised in app/src/config.ts was created
 * with an ephemeral keypair as its treasury — almost certainly by a test script that
 * generates one and discards it at exit. It collected 0.012 SOL of fees to an address
 * nobody holds the key for, and would have kept doing so. Four audit passes missed it
 * because every pass was reading code, and this is a deployment-procedure defect.
 *
 * Run this after any deployment, and before pointing a frontend at a pool.
 *
 * Usage:
 *   SOLANA_RPC_URL=https://api.devnet.solana.com \
 *   EXPECTED_TREASURY=<your pubkey> \
 *   node scripts/check_pools.js [poolAddress ...]
 *
 * With no pool arguments it reads the list from app/src/config.ts.
 * Exit code 0 = every pool is deployed and correctly configured.
 */

const { Connection, PublicKey } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59"
);

// Offsets including the 8-byte discriminator (see programs/solnadocash/src/state.rs).
const OFF_ADMIN = 8 + 0;
const OFF_DENOMINATION = 8 + 64;
const OFF_NEXT_INDEX = 8 + 80;
const OFF_TREASURY = 8 + 88;
const OFF_IS_PAUSED = 8 + 123;
const POOL_LEN = 8 + 8968;
const POOL_DISCRIMINATOR = Buffer.from([
  0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc,
]);

/** Scrape the pool list out of the frontend config so the two cannot drift. */
function poolsFromAppConfig() {
  const p = path.join(__dirname, "../app/src/config.ts");
  const src = fs.readFileSync(p, "utf8");
  const out = [];
  const re = /label:\s*'([^']+)'[\s\S]*?address:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push({ label: m[1], address: m[2] });
  return out;
}

async function main() {
  const expected = process.env.EXPECTED_TREASURY;
  if (!expected) {
    console.error(
      "ERROR: set EXPECTED_TREASURY to the pubkey that should receive protocol fees."
    );
    process.exit(1);
  }
  let expectedTreasury;
  try {
    expectedTreasury = new PublicKey(expected);
  } catch {
    console.error(`ERROR: EXPECTED_TREASURY is not a valid pubkey: ${expected}`);
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const pools = args.length
    ? args.map((a) => ({ label: a.slice(0, 8) + "…", address: a }))
    : poolsFromAppConfig();

  if (pools.length === 0) {
    console.error("ERROR: no pools to check.");
    process.exit(1);
  }

  const connection = new Connection(RPC_URL, "confirmed");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Pool configuration check");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("Cluster:           ", RPC_URL);
  console.log("Program:           ", PROGRAM_ID.toBase58());
  console.log("Expected treasury: ", expectedTreasury.toBase58());
  console.log("Pools to check:    ", pools.length, args.length ? "(from CLI)" : "(from app/src/config.ts)");
  console.log("");

  const problems = [];

  for (const { label, address } of pools) {
    let pubkey;
    try {
      pubkey = new PublicKey(address);
    } catch {
      problems.push(`${label}: '${address}' is not a valid address`);
      console.log(`  FAIL  ${label.padEnd(10)} invalid address`);
      continue;
    }

    const info = await connection.getAccountInfo(pubkey);
    if (!info) {
      problems.push(
        `${label}: NOT DEPLOYED at ${address} — advertised to users but does not exist`
      );
      console.log(`  FAIL  ${label.padEnd(10)} not deployed (${address})`);
      continue;
    }
    if (!info.owner.equals(PROGRAM_ID)) {
      problems.push(`${label}: owned by ${info.owner.toBase58()}, not the program`);
      console.log(`  FAIL  ${label.padEnd(10)} wrong owner`);
      continue;
    }
    if (info.data.length < POOL_LEN || !info.data.subarray(0, 8).equals(POOL_DISCRIMINATOR)) {
      problems.push(`${label}: not a Pool account (bad length or discriminator)`);
      console.log(`  FAIL  ${label.padEnd(10)} not a Pool account`);
      continue;
    }

    const admin = new PublicKey(info.data.subarray(OFF_ADMIN, OFF_ADMIN + 32));
    const treasury = new PublicKey(info.data.subarray(OFF_TREASURY, OFF_TREASURY + 32));
    const denomination = info.data.readBigUInt64LE(OFF_DENOMINATION);
    const nextIndex = info.data.readBigUInt64LE(OFF_NEXT_INDEX);
    const isPaused = info.data[OFF_IS_PAUSED] === 1;
    const feePerWithdrawal = denomination / 500n;

    const treasuryOk = treasury.equals(expectedTreasury);
    if (!treasuryOk) {
      problems.push(
        `${label}: treasury is ${treasury.toBase58()}, expected ${expectedTreasury.toBase58()}. ` +
          `The treasury is IMMUTABLE — this pool must be recreated at a new address, and ` +
          `${feePerWithdrawal} lamports per withdrawal are being paid to the wrong address.`
      );
    }

    console.log(
      `  ${treasuryOk ? "PASS" : "FAIL"}  ${label.padEnd(10)} ` +
        `denom ${(Number(denomination) / 1e9).toString().padEnd(6)} SOL  ` +
        `deposits ${String(nextIndex).padStart(4)}  ` +
        `fee/withdrawal ${(Number(feePerWithdrawal) / 1e9).toFixed(6)} SOL  ` +
        `${isPaused ? "PAUSED  " : ""}` +
        `${treasuryOk ? "treasury OK" : "TREASURY MISMATCH -> " + treasury.toBase58()}`
    );

    // Assert the admin, not just report it. EXPECTED_ADMIN is separate from
    // EXPECTED_TREASURY because splitting those roles is the recommended pre-mainnet
    // posture; if it is unset we fall back to expecting them equal and say so.
    const expectedAdminStr = process.env.EXPECTED_ADMIN || expectedTreasury.toBase58();
    if (admin.toBase58() !== expectedAdminStr) {
      problems.push(
        `${label}: admin is ${admin.toBase58()}, expected ${expectedAdminStr}. ` +
          `An unexpected admin can pause deposits on this pool.`
      );
      console.log(
        `        FAIL  admin is ${admin.toBase58()}, expected ${expectedAdminStr}`
      );
    } else if (!process.env.EXPECTED_ADMIN) {
      console.log(
        `        note: admin == treasury. Set EXPECTED_ADMIN to assert a split-role ` +
          `deployment (recommended before mainnet).`
      );
    }
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  if (problems.length === 0) {
    console.log(`  ${pools.length}/${pools.length} pools deployed with the correct treasury`);
  } else {
    console.log(`  ${problems.length} problem(s):`);
    for (const p of problems) console.log(`   - ${p}`);
  }
  console.log("═══════════════════════════════════════════════════════════");
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error("ERROR:", err.message || err);
  process.exit(1);
});
