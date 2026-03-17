// relayer/test/integration.test.js
// T30 — Integration test: deposit on devnet, generate proof, submit through relayer
//
// Run: ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//      ANCHOR_WALLET=~/.config/solana/id.json \
//      npm test -- --grep "T30"

import { strict as assert } from "node:assert";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { createApp } from "../src/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");
const IDL_PATH = join(ROOT_DIR, "target/idl/solnadocash.json");
const WITHDRAW_WASM = join(ROOT_DIR, "circuits/build/withdraw_js/withdraw.wasm");
const WITHDRAW_ZKEY = join(ROOT_DIR, "circuits/build/withdraw_final.zkey");

const PROGRAM_ID = new PublicKey(
  "DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59"
);
const DENOMINATION = 1_000_000_000n; // 1 SOL
const TREE_DEPTH = 20;
const BN254_FIELD_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
// BN254 scalar field prime (Fr) — Poseidon operates over this field.
// Pubkeys (256 bits) can exceed Fr (~254 bits), must reduce mod Fr before hashing.
const BN254_Fr =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const RPC_URL =
  process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

// ── Poseidon ────────────────────────────────────────────────────────────────

let _poseidon, _F;

function poseidonHash(...inputs) {
  const result = _poseidon(inputs.map((x) => _F.e(x)));
  return BigInt(_F.toObject(result));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function bigIntToBytes32(n) {
  const hex = n.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

function pubkeyToField(pk) {
  const bytes = pk.toBytes();
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  // Reduce mod BN254_Fr — pubkeys are 256 bits, Fr is ~254 bits
  return v % BN254_Fr;
}

function randomFieldElem() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n % BN254_FIELD_ORDER;
}

function generateNote() {
  const nullifier = randomFieldElem();
  const secret = randomFieldElem();
  const commitment = poseidonHash(nullifier, secret, DENOMINATION);
  const nullifierHash = poseidonHash(nullifier);
  return { nullifier, secret, commitment, nullifierHash };
}

// ── Incremental Merkle tree (mirrors on-chain) ─────────────────────────────

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

    const leafIndex = this.nextIndex;
    this.nextIndex += 1n;
    return { pathElements, pathIndices, root: currentHash, leafIndex };
  }
}

// ── PDA helpers ─────────────────────────────────────────────────────────────

function findPoolPda(admin, denomination, version) {
  const denomBuf = Buffer.alloc(8);
  denomBuf.writeBigUInt64LE(denomination);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      admin.toBytes(),
      new PublicKey(Buffer.alloc(32, 0)).toBytes(),
      denomBuf,
      Buffer.from([version]),
    ],
    PROGRAM_ID
  );
}

function findVaultPda(poolPda) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBytes()],
    PROGRAM_ID
  );
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

async function httpRequest(portNum, method, urlPath, body) {
  const opts = { method };
  if (body) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${portNum}${urlPath}`, opts);
  const json = await res.json();
  return { status: res.status, body: json };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("T30 — Devnet integration test", function () {
  this.timeout(300_000); // 5 min — proof generation is slow

  const connection = new Connection(RPC_URL, "confirmed");
  let walletKeypair, provider, program;
  let poolPda, vaultPda;
  let server, port;

  before(async () => {
    _poseidon = await buildPoseidon();
    _F = _poseidon.F;

    const keyPath =
      process.env.ANCHOR_WALLET ||
      `${process.env.HOME}/.config/solana/id.json`;
    walletKeypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")))
    );

    const wallet = new anchor.Wallet(walletKeypair);
    provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);

    const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
    program = new anchor.Program(idl, provider);

    // Use version=3 (fresh pool for T30 integration test)
    [poolPda] = findPoolPda(walletKeypair.publicKey, DENOMINATION, 3);
    [vaultPda] = findVaultPda(poolPda);

    console.log("  Pool PDA:", poolPda.toBase58());
    console.log("  Vault PDA:", vaultPda.toBase58());

    // Start relayer server on random port
    const app = createApp({
      connection,
      relayerKeypair: walletKeypair,
      programId: PROGRAM_ID,
    });
    server = app.listen(0);
    port = server.address().port;
    console.log("  Relayer on port", port);
  });

  after(() => {
    if (server) server.close();
  });

  it("deposit → proof → relayer HTTP submit → recipient receives SOL", async () => {
    // ── 1. Read current pool state ────────────────────────────────────────
    const poolBefore = await program.account.pool.fetch(poolPda);
    const nextIndexBefore = BigInt(poolBefore.nextIndex.toString());
    console.log("  Pool next_index before deposit:", nextIndexBefore.toString());

    // ── 2. Generate a note and deposit ────────────────────────────────────
    const note = generateNote();
    console.log("  Commitment:", note.commitment.toString().slice(0, 20) + "...");

    const commitmentBytes = Array.from(bigIntToBytes32(note.commitment));
    const depositTx = await program.methods
      .deposit(commitmentBytes)
      .accountsPartial({
        pool: poolPda,
        vault: vaultPda,
        depositor: walletKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  Deposit tx:", depositTx);

    // ── 3. Rebuild JS Merkle tree to match on-chain state ─────────────────
    // We need to replay all deposits from index 0 to nextIndex.
    // For this test we require the pool was fresh (nextIndexBefore == 0).
    // If not, we'd need to read all deposit events — but for T30 a fresh
    // pool is the expected test scenario.
    assert.equal(
      nextIndexBefore,
      0n,
      "T30 expects a fresh pool with 0 deposits. Re-initialize if needed."
    );

    const jsTree = new IncrementalMerkleTree(TREE_DEPTH);
    const { pathElements, pathIndices, root } = jsTree.insert(note.commitment);
    console.log("  JS root:", root.toString().slice(0, 20) + "...");

    // ── 4. Choose recipient and relayer ──────────────────────────────────
    const recipient = Keypair.generate();

    const relayerBigInt = pubkeyToField(walletKeypair.publicKey);
    const recipientBigInt = pubkeyToField(recipient.publicKey);

    // ── 5. Get fee quote from relayer ────────────────────────────────────
    const feeRes = await httpRequest(
      port,
      "GET",
      `/fee_quote?pool=${poolPda.toBase58()}`
    );
    assert.equal(feeRes.status, 200, JSON.stringify(feeRes.body));
    const relayerFeeMax = BigInt(feeRes.body.relayerFeeMax);
    console.log("  Relayer fee max:", relayerFeeMax.toString(), "lamports");

    // ── 6. Compute withdrawalCommitment = Poseidon(relayer, feeMax, recipient)
    const withdrawalCommitment = poseidonHash(
      relayerBigInt,
      relayerFeeMax,
      recipientBigInt
    );

    // ── 7. Generate ZK proof ─────────────────────────────────────────────
    console.log("  Generating ZK proof (this takes ~30-60s)...");
    const circomInputs = {
      nullifierHash: note.nullifierHash.toString(),
      root: root.toString(),
      withdrawalCommitment: withdrawalCommitment.toString(),
      nullifier: note.nullifier.toString(),
      secret: note.secret.toString(),
      denomination: DENOMINATION.toString(),
      pathElements: pathElements.map((e) => e.toString()),
      pathIndices: pathIndices.map((i) => i.toString()),
      recipient: recipientBigInt.toString(),
      relayerAddress: relayerBigInt.toString(),
      relayerFeeMax: relayerFeeMax.toString(),
    };

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circomInputs,
      WITHDRAW_WASM,
      WITHDRAW_ZKEY
    );
    console.log("  Proof generated.");
    console.log(
      "  Public signals:",
      publicSignals.map((s) => s.slice(0, 15) + "...")
    );

    // ── 8. Submit proof through relayer HTTP endpoint ─────────────────────
    console.log("  Submitting proof to relayer...");
    const submitRes = await httpRequest(port, "POST", "/submit_proof", {
      proof,
      publicSignals,
      poolAddress: poolPda.toBase58(),
      recipient: recipient.publicKey.toBase58(),
      relayerFeeMax: relayerFeeMax.toString(),
    });

    console.log(
      "  Submit response:",
      submitRes.status,
      JSON.stringify(submitRes.body)
    );
    assert.equal(
      submitRes.status,
      200,
      `Submit failed: ${JSON.stringify(submitRes.body)}`
    );
    assert.ok(submitRes.body.txSignature, "Should return tx signature");

    // ── 9. Verify recipient received SOL ─────────────────────────────────
    const recipientBalance = await connection.getBalance(recipient.publicKey);
    console.log("  Recipient balance:", recipientBalance / 1e9, "SOL");

    // treasury_fee = 1_000_000_000 / 500 = 2_000_000
    // user receives = denomination - treasury_fee - relayer_fee
    // Should be > 0.99 SOL
    assert.ok(
      recipientBalance > 990_000_000,
      `Recipient should have > 0.99 SOL, got ${recipientBalance / 1e9}`
    );

    console.log("\n  T30 — PASSED: full deposit→proof→relayer→withdrawal on devnet");
  });
});
