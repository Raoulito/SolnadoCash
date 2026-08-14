#!/usr/bin/env node
// scripts/deploy_pools.js
// Deploy SolnadoCash privacy pools on devnet.
// Uses the local wallet (~/.config/solana/id.json) as admin and treasury.
//
// Usage:
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=~/.config/solana/id.json \
//   node scripts/deploy_pools.js [denominations...]
//
// Examples:
//   node scripts/deploy_pools.js              # Deploy all (0.1, 1, 10 SOL)
//   node scripts/deploy_pools.js 0.1          # Deploy only 0.1 SOL pool
//   node scripts/deploy_pools.js 0.1 1        # Deploy 0.1 and 1 SOL pools

const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram } = require("@solana/web3.js");
const fs = require("fs");

// Pool PDA seeds include a version byte, so bumping VERSION yields a fresh pool at the
// same denomination — the only way to recover from a mis-set (immutable) treasury.
const VERSION = parseInt(process.env.VERSION || "0", 10);

// The treasury receives the 0.2% protocol fee and is FIXED AT POOL CREATION — it can
// never be changed. A mistake here is unfixable: the pool must be abandoned and
// recreated, and any fees already collected are unrecoverable. Set TREASURY explicitly
// rather than letting it default silently.
const TREASURY_OVERRIDE = process.env.TREASURY || null;

const ALL_POOLS = [
  { label: "0.1 SOL", lamports: 100_000_000 },
  { label: "1 SOL", lamports: 1_000_000_000 },
  { label: "10 SOL", lamports: 10_000_000_000 },
];

function findPoolPda(admin, denomination, version, programId) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(denomination));
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      admin.toBytes(),
      new PublicKey(Buffer.alloc(32, 0)).toBytes(),
      buf,
      Buffer.from([version]),
    ],
    programId
  );
}

function findVaultPda(poolPda, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBytes()],
    programId
  );
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync("target/idl/solnadocash.json", "utf8"));
  const program = new anchor.Program(idl, provider);
  const connection = provider.connection;
  const admin = provider.wallet;

  // Filter pools by CLI args
  const args = process.argv.slice(2);
  // Exact label match. Substring matching deployed pools nobody asked for: the filter
  // "1 SOL" also matches "0.1 SOL" and "10 SOL", so a targeted redeploy silently created
  // two extra pools (each costing non-refundable rent). Accept "0.1", "1", "10" or the
  // full label.
  const pools = args.length
    ? ALL_POOLS.filter((p) =>
        args.some(
          (a) => p.label === a || p.label === `${a} SOL` || p.label.replace(" SOL", "") === a
        )
      )
    : ALL_POOLS;

  if (pools.length === 0) {
    console.error("No matching pools. Available:", ALL_POOLS.map((p) => p.label).join(", "));
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  SolnadoCash — Pool Deployment");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("Program:  ", program.programId.toBase58());
  console.log("Admin:    ", admin.publicKey.toBase58());
  const treasuryPubkey = TREASURY_OVERRIDE
    ? new PublicKey(TREASURY_OVERRIDE)
    : admin.publicKey;
  console.log(
    "Treasury: ",
    treasuryPubkey.toBase58(),
    TREASURY_OVERRIDE ? "(from TREASURY env)" : "(defaulting to admin — set TREASURY to split roles)"
  );
  console.log("           ^ IMMUTABLE once the pool exists. Fees go here forever.");
  console.log("Cluster:  ", connection.rpcEndpoint);

  const balance = await connection.getBalance(admin.publicKey);
  console.log("Balance:  ", balance / 1e9, "SOL\n");

  const results = [];

  for (const pool of pools) {
    const denomination = new anchor.BN(pool.lamports);
    const [poolPda] = findPoolPda(admin.publicKey, pool.lamports, VERSION, program.programId);
    const [vaultPda] = findVaultPda(poolPda, program.programId);

    console.log(`Deploying ${pool.label} pool...`);
    console.log("  Pool PDA: ", poolPda.toBase58());
    console.log("  Vault PDA:", vaultPda.toBase58());

    // Check if already deployed
    const existing = await connection.getAccountInfo(poolPda);
    if (existing) {
      // Do not just skip: an existing pool may have the WRONG treasury, which is
      // unfixable and must be surfaced loudly rather than reported as "exists".
      const existingTreasury = new PublicKey(existing.data.subarray(8 + 88, 8 + 120));
      if (existingTreasury.equals(treasuryPubkey)) {
        console.log("  Already deployed, treasury correct, skipping.\n");
        results.push({ label: pool.label, address: poolPda.toBase58(), status: "exists" });
      } else {
        console.error(
          `  ERROR:     already deployed with treasury ${existingTreasury.toBase58()}, ` +
            `expected ${treasuryPubkey.toBase58()}.`
        );
        console.error(
          "             The treasury is immutable. Fees from this pool are going to the"
        );
        console.error(
          "             wrong address and cannot be redirected. Recreate under a"
        );
        console.error(
          "             different admin or version so the PDA differs, and stop"
        );
        console.error("             advertising this address.\n");
        results.push({ label: pool.label, address: poolPda.toBase58(), status: "BAD TREASURY" });
      }
      continue;
    }

    try {
      const sig = await program.methods
        .initializePool(denomination, VERSION)
        .accountsPartial({
          admin: admin.publicKey,
          pool: poolPda,
          vault: vaultPda,
          treasury: treasuryPubkey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("  Tx:       ", sig);

      // Read the pool back and confirm the treasury is what we intended. Skipping this
      // is how the devnet 1 SOL pool ended up paying fees to a discarded ephemeral
      // keypair for 6 withdrawals before anyone noticed.
      const created = await connection.getAccountInfo(poolPda);
      const writtenTreasury = new PublicKey(created.data.subarray(8 + 88, 8 + 120));
      if (!writtenTreasury.equals(treasuryPubkey)) {
        console.error(
          `  ERROR:     treasury readback MISMATCH — wrote ${writtenTreasury.toBase58()}, ` +
            `expected ${treasuryPubkey.toBase58()}. This pool is unusable: abandon it.`
        );
        results.push({ label: pool.label, address: poolPda.toBase58(), status: "BAD TREASURY" });
        continue;
      }
      console.log("  Treasury verified on-chain:", writtenTreasury.toBase58());
      console.log("  Done.\n");
      results.push({ label: pool.label, address: poolPda.toBase58(), status: "deployed" });
    } catch (err) {
      console.error("  FAILED:   ", err.message);
      if (err.logs) err.logs.forEach((l) => console.error("    ", l));
      console.log();
      results.push({ label: pool.label, address: poolPda.toBase58(), status: "failed" });
    }
  }

  // Summary
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Pool Addresses (paste into app/src/config.ts)");
  console.log("═══════════════════════════════════════════════════════════");
  for (const r of results) {
    console.log(`  ${r.label}: '${r.address}' (${r.status})`);
  }
  console.log("═══════════════════════════════════════════════════════════");

  const bad = results.filter((r) => r.status !== "deployed" && r.status !== "exists");
  if (bad.length) {
    console.error(
      `\n${bad.length} pool(s) are NOT safe to advertise. Do not add them to ` +
        `app/src/config.ts. Verify with:\n` +
        `  EXPECTED_TREASURY=${treasuryPubkey.toBase58()} node scripts/check_pools.js\n`
    );
    process.exit(1);
  }
  console.log(
    `\nVerify the frontend list at any time with:\n` +
      `  EXPECTED_TREASURY=${treasuryPubkey.toBase58()} node scripts/check_pools.js\n`
  );
}

main().catch((err) => {
  console.error("ERROR:", err.message || err);
  process.exit(1);
});
