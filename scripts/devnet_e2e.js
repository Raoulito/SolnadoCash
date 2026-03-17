#!/usr/bin/env node
// scripts/devnet_e2e.js
// Real end-to-end test on Solana devnet: deposit → ZK proof → withdraw
// Prints sender, receiver, pool, and all tx signatures for Solscan verification.
//
// Run: ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//      ANCHOR_WALLET=~/.config/solana/id.json \
//      node scripts/devnet_e2e.js

const anchor = require("@coral-xyz/anchor");
const {
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
  SystemInstruction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");

// ── Constants ────────────────────────────────────────────────────────────────

const DENOMINATION = new anchor.BN(100_000_000); // 0.1 SOL
const DENOMINATION_BI = 100_000_000n;
const VERSION = 0;
const TREE_DEPTH = 20;

const BN254_FIELD_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BN254_Fq =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

// Realistic relayer fee: covers nullifier rent + base fee + 50% margin
const RELAYER_FEE_MAX = 3_066_420n;
const RELAYER_FEE_TAKEN = 3_066_420n;
const TREASURY_FEE = DENOMINATION_BI / 500n; // 200_000 lamports

const BUILD_DIR = path.join(__dirname, "../circuits/build");
const WITHDRAW_WASM = path.join(BUILD_DIR, "withdraw_js/withdraw.wasm");
const WITHDRAW_ZKEY = path.join(BUILD_DIR, "withdraw_final.zkey");

// ── Poseidon ─────────────────────────────────────────────────────────────────

let _poseidon, _F;

async function initPoseidon() {
  const { buildPoseidon } = require("circomlibjs");
  _poseidon = await buildPoseidon();
  _F = _poseidon.F;
}

function poseidonHash(...inputs) {
  const result = _poseidon(inputs.map((x) => _F.e(x)));
  return BigInt(_F.toObject(result));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function randomFieldElem() {
  const bytes = require("crypto").randomBytes(32);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value % BN254_FIELD_ORDER;
}

function bigIntToBytes32(n) {
  const hex = n.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

function pubkeyToBigInt(pk) {
  const bytes = pk.toBytes();
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function pubkeyToField(pk) {
  return pubkeyToBigInt(pk) % BN254_FIELD_ORDER;
}

// ── Incremental Merkle Tree ──────────────────────────────────────────────────

function buildZeros(depth) {
  const zeros = new Array(depth);
  zeros[0] = 0n;
  for (let i = 1; i < depth; i++) {
    zeros[i] = poseidonHash(zeros[i - 1], zeros[i - 1]);
  }
  return zeros;
}

class IncrementalMerkleTree {
  constructor(depth) {
    this.depth = depth;
    this.zeros = buildZeros(depth);
    this.filledSubtrees = [...this.zeros];
    this.nextIndex = 0n;
  }

  insert(leaf) {
    let currentHash = leaf;
    let currentIndex = this.nextIndex;
    const pathElements = [];
    const pathIndices = [];

    for (let i = 0; i < this.depth; i++) {
      pathIndices.push(Number(currentIndex % 2n));
      if (currentIndex % 2n === 0n) {
        pathElements.push(this.zeros[i]);
        this.filledSubtrees[i] = currentHash;
        currentHash = poseidonHash(currentHash, this.zeros[i]);
      } else {
        pathElements.push(this.filledSubtrees[i]);
        currentHash = poseidonHash(this.filledSubtrees[i], currentHash);
      }
      currentIndex = currentIndex / 2n;
    }

    this.nextIndex += 1n;
    return { pathElements, pathIndices, root: currentHash };
  }
}

// ── Proof conversion ─────────────────────────────────────────────────────────

function snarkjsProofToBytes(proof) {
  const proofA = Buffer.concat([
    bigIntToBytes32(BigInt(proof.pi_a[0])),
    bigIntToBytes32(BN254_Fq - BigInt(proof.pi_a[1])),
  ]);
  const proofB = Buffer.concat([
    bigIntToBytes32(BigInt(proof.pi_b[0][1])),
    bigIntToBytes32(BigInt(proof.pi_b[0][0])),
    bigIntToBytes32(BigInt(proof.pi_b[1][1])),
    bigIntToBytes32(BigInt(proof.pi_b[1][0])),
  ]);
  const proofC = Buffer.concat([
    bigIntToBytes32(BigInt(proof.pi_c[0])),
    bigIntToBytes32(BigInt(proof.pi_c[1])),
  ]);
  return { proofA, proofB, proofC };
}

// ── PDA derivation ───────────────────────────────────────────────────────────

function findPoolPda(admin, denomination, version, programId) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      admin.toBytes(),
      new PublicKey(Buffer.alloc(32, 0)).toBytes(), // SOL = Pubkey::default()
      denomination.toArrayLike(Buffer, "le", 8),
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

function findNullifierPda(poolPda, nullifierHash, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), poolPda.toBytes(), nullifierHash],
    programId
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Check circuit files
  if (!fs.existsSync(WITHDRAW_WASM) || !fs.existsSync(WITHDRAW_ZKEY)) {
    console.error("ERROR: Circuit build files not found. Run trusted setup first.");
    process.exit(1);
  }

  // Setup provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync("target/idl/solnadocash.json", "utf8"));
  const program = new anchor.Program(idl, provider);
  const connection = provider.connection;
  const funder = provider.wallet; // main wallet = fee payer

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  SolnadoCash — Devnet End-to-End Test");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("Program:    ", program.programId.toBase58());
  console.log("Fee payer:  ", funder.publicKey.toBase58());
  console.log("Cluster:    ", connection.rpcEndpoint);
  console.log("Denomination:", Number(DENOMINATION_BI) / LAMPORTS_PER_SOL, "SOL");

  const funderBal = await connection.getBalance(funder.publicKey);
  console.log("Fee payer balance:", funderBal / LAMPORTS_PER_SOL, "SOL\n");

  if (funderBal < 0.3 * LAMPORTS_PER_SOL) {
    console.error("ERROR: Need at least 0.3 SOL in fee payer wallet");
    process.exit(1);
  }

  // ── Step 1: Generate keypairs ────────────────────────────────────────────

  console.log("Step 1 — Generating fresh keypairs...");
  const admin = Keypair.generate();
  const treasury = Keypair.generate();

  // Relayer and recipient pubkeys must be < BN254_FIELD_ORDER because the on-chain
  // reduce_mod_fr only does a single subtraction (fails for values >= 2*Fr).
  // Same approach as tests/withdraw.ts.
  let recipient, relayer;
  do { recipient = Keypair.generate(); } while (pubkeyToBigInt(recipient.publicKey) >= BN254_FIELD_ORDER);
  do { relayer = Keypair.generate(); } while (pubkeyToBigInt(relayer.publicKey) >= BN254_FIELD_ORDER);

  console.log("  Admin (depositor):", admin.publicKey.toBase58());
  console.log("  Treasury:         ", treasury.publicKey.toBase58());
  console.log("  Relayer:          ", relayer.publicKey.toBase58());
  console.log("  Recipient:        ", recipient.publicKey.toBase58());

  // ── Step 2: Fund admin + relayer ─────────────────────────────────────────

  console.log("\nStep 2 — Funding admin and relayer from fee payer...");

  const fundAdminAmount = 200_000_000; // 0.2 SOL
  const fundRelayerAmount = 5_000_000; // 0.005 SOL
  const fundTreasuryAmount = 1_000_000; // 0.001 SOL — treasury must be rent-exempt before receiving fees

  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: admin.publicKey,
      lamports: fundAdminAmount,
    }),
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: relayer.publicKey,
      lamports: fundRelayerAmount,
    }),
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: treasury.publicKey,
      lamports: fundTreasuryAmount,
    })
  );
  const fundSig = await provider.sendAndConfirm(fundTx);
  console.log("  Fund tx:", fundSig);

  // ── Step 3: Initialize pool ──────────────────────────────────────────────

  console.log("\nStep 3 — Initializing pool (0.1 SOL, v0)...");

  const [poolPda] = findPoolPda(admin.publicKey, DENOMINATION, VERSION, program.programId);
  const [vaultPda] = findVaultPda(poolPda, program.programId);

  console.log("  Pool PDA: ", poolPda.toBase58());
  console.log("  Vault PDA:", vaultPda.toBase58());

  const initSig = await program.methods
    .initializePool(DENOMINATION, VERSION)
    .accountsPartial({
      admin: admin.publicKey,
      pool: poolPda,
      vault: vaultPda,
      treasury: treasury.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([admin])
    .rpc();
  console.log("  Init tx:  ", initSig);

  // ── Step 4: Generate note + deposit ──────────────────────────────────────

  console.log("\nStep 4 — Generating secret note and depositing...");
  await initPoseidon();

  const nullifier = randomFieldElem();
  const secret = randomFieldElem();
  const commitment = poseidonHash(nullifier, secret, DENOMINATION_BI);
  const nullifierHash = poseidonHash(nullifier);

  console.log("  Commitment:", commitment.toString(16).slice(0, 16) + "...");

  const commitmentBytes = Array.from(bigIntToBytes32(commitment));
  const depositSig = await program.methods
    .deposit(commitmentBytes)
    .accountsPartial({
      pool: poolPda,
      vault: vaultPda,
      depositor: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([admin])
    .rpc();
  console.log("  Deposit tx:", depositSig);

  // Verify deposit
  const vaultBal = await connection.getBalance(vaultPda);
  console.log("  Vault balance after deposit:", vaultBal / LAMPORTS_PER_SOL, "SOL");

  // ── Step 5: Build Merkle tree + generate ZK proof ────────────────────────

  console.log("\nStep 5 — Building Merkle tree and generating ZK proof...");
  console.log("  (this takes 30-60 seconds)");

  const tree = new IncrementalMerkleTree(TREE_DEPTH);
  const { pathElements, pathIndices, root } = tree.insert(commitment);

  // Use raw bigint (no mod Fr) since we ensured pubkeys are < Fr in Step 1
  const relayerField = pubkeyToBigInt(relayer.publicKey);
  const recipientField = pubkeyToBigInt(recipient.publicKey);
  const withdrawalCommitment = poseidonHash(
    relayerField,
    RELAYER_FEE_MAX,
    recipientField
  );

  const circomInputs = {
    nullifierHash: nullifierHash.toString(),
    root: root.toString(),
    withdrawalCommitment: withdrawalCommitment.toString(),
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    denomination: DENOMINATION_BI.toString(),
    pathElements: pathElements.map((x) => x.toString()),
    pathIndices: pathIndices.map((x) => x.toString()),
    recipient: recipientField.toString(),
    relayerAddress: relayerField.toString(),
    relayerFeeMax: RELAYER_FEE_MAX.toString(),
  };

  const startTime = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circomInputs,
    WITHDRAW_WASM,
    WITHDRAW_ZKEY
  );
  const proofTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Proof generated in ${proofTime}s`);
  console.log("  Public signals:");
  console.log("    [0] nullifierHash:        ", publicSignals[0].slice(0, 20) + "...");
  console.log("    [1] root:                 ", publicSignals[1].slice(0, 20) + "...");
  console.log("    [2] withdrawalCommitment: ", publicSignals[2].slice(0, 20) + "...");

  // ── Step 6: Submit withdraw on-chain ─────────────────────────────────────

  console.log("\nStep 6 — Submitting withdrawal on-chain...");

  const nullifierHashBytes = bigIntToBytes32(nullifierHash);
  const [nullifierPda, nullifierBump] = findNullifierPda(
    poolPda,
    nullifierHashBytes,
    program.programId
  );

  const { proofA, proofB, proofC } = snarkjsProofToBytes(proof);

  const withdrawArgs = {
    proofA: Array.from(proofA),
    proofB: Array.from(proofB),
    proofC: Array.from(proofC),
    nullifierHash: Array.from(nullifierHashBytes),
    root: Array.from(bigIntToBytes32(BigInt(publicSignals[1]))),
    withdrawalCommitment: Array.from(bigIntToBytes32(BigInt(publicSignals[2]))),
    relayerFeeMax: new anchor.BN(RELAYER_FEE_MAX.toString()),
    relayerFeeTaken: new anchor.BN(RELAYER_FEE_TAKEN.toString()),
    nullifierBump,
  };

  const recipientBefore = await connection.getBalance(recipient.publicKey);
  const treasuryBefore = await connection.getBalance(treasury.publicKey);

  const withdrawSig = await program.methods
    .withdraw(withdrawArgs)
    .accountsPartial({
      pool: poolPda,
      vault: vaultPda,
      nullifierPda: nullifierPda,
      recipient: recipient.publicKey,
      treasury: treasury.publicKey,
      relayer: relayer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([relayer])
    .rpc();
  console.log("  Withdraw tx:", withdrawSig);

  // ── Step 7: Verify results ───────────────────────────────────────────────

  console.log("\nStep 7 — Verifying results...");

  const recipientAfter = await connection.getBalance(recipient.publicKey);
  const treasuryAfter = await connection.getBalance(treasury.publicKey);
  const vaultAfter = await connection.getBalance(vaultPda);

  const treasuryReceived = treasuryAfter - treasuryBefore;
  const recipientReceived = recipientAfter - recipientBefore;
  const userAmount = Number(DENOMINATION_BI) - Number(TREASURY_FEE) - Number(RELAYER_FEE_TAKEN);

  console.log("  Treasury received: ", treasuryReceived, "lamports", `(${treasuryReceived / LAMPORTS_PER_SOL} SOL)`);
  console.log("  Recipient received:", recipientReceived, "lamports", `(${recipientReceived / LAMPORTS_PER_SOL} SOL)`);
  console.log("  Vault balance:     ", vaultAfter, "lamports");

  // Verify nullifier PDA was created (prevents double-spend)
  const nullifierInfo = await connection.getAccountInfo(nullifierPda);
  console.log("  Nullifier PDA created:", nullifierInfo !== null);

  // Assertions
  const ok =
    treasuryReceived === Number(TREASURY_FEE) &&
    recipientReceived === userAmount &&
    nullifierInfo !== null;

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RESULTS — verify on https://solscan.io/?cluster=devnet");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Depositor (sender):   ", admin.publicKey.toBase58());
  console.log("  Recipient (receiver): ", recipient.publicKey.toBase58());
  console.log("  Pool:                 ", poolPda.toBase58());
  console.log("  Vault:                ", vaultPda.toBase58());
  console.log("  Treasury:             ", treasury.publicKey.toBase58());
  console.log("  Relayer:              ", relayer.publicKey.toBase58());
  console.log("");
  console.log("  Amount deposited:      0.1 SOL");
  console.log("  Treasury fee (0.2%):  ", Number(TREASURY_FEE) / LAMPORTS_PER_SOL, "SOL");
  console.log("  Relayer fee:          ", Number(RELAYER_FEE_TAKEN) / LAMPORTS_PER_SOL, "SOL");
  console.log("  Recipient received:   ", recipientReceived / LAMPORTS_PER_SOL, "SOL");
  console.log("");
  console.log("  Deposit tx:  ", depositSig);
  console.log("  Withdraw tx: ", withdrawSig);
  console.log("");
  console.log("  Solscan (deposit):  https://solscan.io/tx/" + depositSig + "?cluster=devnet");
  console.log("  Solscan (withdraw): https://solscan.io/tx/" + withdrawSig + "?cluster=devnet");
  console.log("");
  console.log("  All checks:", ok ? "PASSED" : "FAILED");
  console.log("═══════════════════════════════════════════════════════════");

  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error("\nERROR:", err.message || err);
  if (err.logs) {
    console.error("\nProgram logs:");
    err.logs.forEach((l) => console.error("  ", l));
  }
  process.exit(1);
});
