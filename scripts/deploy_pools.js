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

const VERSION = 0;

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
  const pools = args.length
    ? ALL_POOLS.filter((p) =>
        args.some((a) => p.label.includes(a))
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
  console.log("Treasury: ", admin.publicKey.toBase58(), "(same as admin)");
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
      console.log("  Already deployed, skipping.\n");
      results.push({ label: pool.label, address: poolPda.toBase58(), status: "exists" });
      continue;
    }

    try {
      const sig = await program.methods
        .initializePool(denomination, VERSION)
        .accountsPartial({
          admin: admin.publicKey,
          pool: poolPda,
          vault: vaultPda,
          treasury: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("  Tx:       ", sig);
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
}

main().catch((err) => {
  console.error("ERROR:", err.message || err);
  process.exit(1);
});
