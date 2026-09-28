// relayer/test/integration.test.js
// T30 — Integration test: deposit on devnet, generate proof, submit through relayer
//
// Run: ANCHOR_PROVIDER_URL=<devnet RPC> \
//      ANCHOR_WALLET=~/.config/solana/id.json \
//      npx mocha --timeout 300000 test/integration.test.js
//
// ── The test pool ────────────────────────────────────────────────────────────────
//
// T30 runs against ONE dedicated pool that exists only for this test: admin = the test wallet,
// denomination 0.1 SOL, version 254. No other code, script or configuration uses that combination,
// and the app does not advertise it, so running T30 never touches a pool anyone deposits into.
// The first run creates it; every run after that reuses it. Pools cannot be closed, so it is
// permanent by design, which is also why it is shared across runs rather than created per run.
//
// The test wallet is the pool's admin, its treasury AND the relayer, and the recipient's payout is
// swept back at the end. So a run costs only the nullifier rent and the transaction fees, about
// 0.0015 SOL, instead of a whole deposit. It also exercises relayer == treasury, the aliasing case
// that once made withdrawals impossible on-chain.
//
// Why this rewrite (both were live failures):
//   - The previous version asserted a FRESH pool, AFTER depositing. Its pool had held deposits since
//     March and pools cannot be reset, so every run failed and stranded 1 SOL behind a note that
//     existed only in memory.
//   - It encoded addresses as `pubkey mod Fr`, the encoding replaced in H-2 (August) by
//     Poseidon(hi, lo), so even a fresh pool would have failed preflight's commitment check.
//
// The Merkle path is computed from the pool's own frontier (filled_subtrees + next_index) read just
// before the deposit, then checked against the root the program writes. No history scan needed.

import { strict as assert } from "node:assert";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { createApp } from "../src/api.js";
import { pubkeyToField } from "../src/preflight.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");
// Tracked copies, so a clean clone can run this. The IDL is identical to target/idl; the circuit
// artifacts are the ones the app ships, pinned to the deployed verifier by
// app/src/circuitArtifacts.test.ts.
const IDL_PATH = join(ROOT_DIR, "app/src/idl/solnadocash.json");
const WITHDRAW_WASM = join(ROOT_DIR, "app/public/circuits/withdraw.wasm");
const WITHDRAW_ZKEY = join(ROOT_DIR, "app/public/circuits/withdraw_final.zkey");

const PROGRAM_ID = new PublicKey(
  "DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59"
);
const DENOMINATION = 100_000_000n; // 0.1 SOL
const TEST_POOL_VERSION = 254;
const TREE_DEPTH = 20;
const BASE_FEE = 5_000n;
const BN254_FIELD_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Pool layout, including the 8-byte discriminator (pinned by scripts/check_layout.js).
const OFF_ADMIN = 8 + 0;
const OFF_DENOMINATION = 8 + 64;
const OFF_NEXT_INDEX = 8 + 80;
const OFF_TREASURY = 8 + 88;
const OFF_CURRENT_ROOT_INDEX = 8 + 128;
const OFF_ROOT_HISTORY = 8 + 136;
const OFF_FILLED_SUBTREES = 8 + 8328;

const RPC_URL =
  process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

// Anchor's ESM build exposes BN only on the default export.
const BN = anchor.BN ?? anchor.default?.BN;

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

function bytes32ToBigInt(buf) {
  return BigInt("0x" + Buffer.from(buf).toString("hex"));
}

function randomFieldElem() {
  // Rejection sampling, so the result is uniform below Fr.
  for (;;) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    if (n < BN254_FIELD_ORDER) return n;
  }
}

function generateNote() {
  const nullifier = randomFieldElem();
  const secret = randomFieldElem();
  const commitment = poseidonHash(nullifier, secret, DENOMINATION);
  const nullifierHash = poseidonHash(nullifier);
  return { nullifier, secret, commitment, nullifierHash };
}

/** The fields of the raw Pool account this test reads. */
function readPool(data) {
  const filledSubtrees = [];
  for (let i = 0; i < TREE_DEPTH; i++) {
    const at = OFF_FILLED_SUBTREES + i * 32;
    filledSubtrees.push(bytes32ToBigInt(data.subarray(at, at + 32)));
  }
  const currentRootIndex = Number(data.readBigUInt64LE(OFF_CURRENT_ROOT_INDEX));
  const rootAt = OFF_ROOT_HISTORY + currentRootIndex * 32;
  return {
    admin: new PublicKey(data.subarray(OFF_ADMIN, OFF_ADMIN + 32)),
    denomination: data.readBigUInt64LE(OFF_DENOMINATION),
    nextIndex: data.readBigUInt64LE(OFF_NEXT_INDEX),
    treasury: new PublicKey(data.subarray(OFF_TREASURY, OFF_TREASURY + 32)),
    currentRoot: bytes32ToBigInt(data.subarray(rootAt, rootAt + 32)),
    filledSubtrees,
  };
}

// ── Incremental Merkle tree (mirrors on-chain Pool::insert) ────────────────

function buildZeros(depth) {
  const zeros = new Array(depth);
  zeros[0] = 0n;
  for (let i = 1; i < depth; i++) {
    zeros[i] = poseidonHash(zeros[i - 1], zeros[i - 1]);
  }
  return zeros;
}

class IncrementalMerkleTree {
  /**
   * Start from a frontier read off the chain. `filledSubtrees` and `nextIndex` are exactly the state
   * Pool::insert keeps, so inserting here reproduces the program's next root and gives the path of
   * the inserted leaf against it.
   */
  constructor(depth, filledSubtrees, nextIndex) {
    this.depth = depth;
    this.zeros = buildZeros(depth);
    this.filledSubtrees = [...filledSubtrees];
    this.nextIndex = nextIndex;
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

function findNullifierPda(poolPda, nullifierHash) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), poolPda.toBytes(), bigIntToBytes32(nullifierHash)],
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
  this.timeout(300_000);

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

    [poolPda] = findPoolPda(walletKeypair.publicKey, DENOMINATION, TEST_POOL_VERSION);
    [vaultPda] = findVaultPda(poolPda);
    console.log("  Test pool PDA:", poolPda.toBase58());

    // Refuse to start rather than fail halfway with funds in flight. A run needs one deposit plus
    // fees; the first run also pays the pool and vault rent (~0.047 SOL).
    const balance = BigInt(await connection.getBalance(walletKeypair.publicKey));
    const needed = DENOMINATION + 100_000_000n;
    assert.ok(
      balance >= needed,
      `Test wallet ${walletKeypair.publicKey.toBase58()} holds ${balance} lamports; ` +
        `T30 needs at least ${needed}. Fund it with devnet SOL first.`
    );

    let info = await connection.getAccountInfo(poolPda);
    if (!info) {
      console.log("  Test pool does not exist yet; creating it (one time).");
      await program.methods
        .initializePool(new BN(DENOMINATION.toString()), TEST_POOL_VERSION)
        .accountsPartial({
          admin: walletKeypair.publicKey,
          pool: poolPda,
          vault: vaultPda,
          treasury: walletKeypair.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      info = await connection.getAccountInfo(poolPda);
    }

    // Everything below assumes this is the dedicated pool. Check it, so a wrong address or a
    // redeployed layout fails here with nothing spent.
    assert.ok(info && info.owner.equals(PROGRAM_ID), "test pool is not owned by the program");
    const p = readPool(info.data);
    assert.ok(p.admin.equals(walletKeypair.publicKey), "test pool admin is not the test wallet");
    assert.ok(p.treasury.equals(walletKeypair.publicKey), "test pool treasury is not the test wallet");
    assert.equal(p.denomination, DENOMINATION, "test pool denomination");

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

  after(async () => {
    if (server) server.close();
    // snarkjs keeps a worker pool alive on this global; without this mocha never exits.
    if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
  });

  it("deposit → proof → relayer HTTP submit → recipient receives SOL", async () => {
    const walletBefore = BigInt(await connection.getBalance(walletKeypair.publicKey));

    // ── 1. The pool's frontier, just before depositing ────────────────────
    const before = readPool((await connection.getAccountInfo(poolPda)).data);
    console.log("  Pool next_index before deposit:", before.nextIndex.toString());

    // ── 2. Generate a note and deposit ────────────────────────────────────
    const note = generateNote();
    const depositTx = await program.methods
      .deposit(Array.from(bigIntToBytes32(note.commitment)))
      .accountsPartial({
        pool: poolPda,
        vault: vaultPda,
        depositor: walletKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  Deposit tx:", depositTx);

    // ── 3. Path from the frontier, checked against the root the program wrote ──
    const jsTree = new IncrementalMerkleTree(TREE_DEPTH, before.filledSubtrees, before.nextIndex);
    const { pathElements, pathIndices, root, leafIndex } = jsTree.insert(note.commitment);
    const after = readPool((await connection.getAccountInfo(poolPda)).data);
    assert.equal(leafIndex, before.nextIndex);
    assert.equal(after.nextIndex, before.nextIndex + 1n, "exactly one deposit landed");
    assert.equal(after.currentRoot, root, "the program's new root matches the JS insert");

    // ── 4. Recipient and relayer ─────────────────────────────────────────
    const recipient = Keypair.generate();
    const relayerField = await pubkeyToField(walletKeypair.publicKey);
    const recipientField = await pubkeyToField(recipient.publicKey);

    // ── 5. Fee quote from the relayer ────────────────────────────────────
    const feeRes = await httpRequest(port, "GET", `/fee_quote?pool=${poolPda.toBase58()}`);
    assert.equal(feeRes.status, 200, JSON.stringify(feeRes.body));
    const relayerFeeMax = BigInt(feeRes.body.relayerFeeMax);
    console.log("  Relayer fee max:", relayerFeeMax.toString(), "lamports");

    // ── 6. withdrawalCommitment = Poseidon(relayer, feeMax, recipient) ───
    const withdrawalCommitment = poseidonHash(relayerField, relayerFeeMax, recipientField);

    // ── 7. Proof ─────────────────────────────────────────────────────────
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      {
        nullifierHash: note.nullifierHash.toString(),
        root: root.toString(),
        withdrawalCommitment: withdrawalCommitment.toString(),
        nullifier: note.nullifier.toString(),
        secret: note.secret.toString(),
        denomination: DENOMINATION.toString(),
        pathElements: pathElements.map((e) => e.toString()),
        pathIndices: pathIndices.map((i) => i.toString()),
        recipient: recipientField.toString(),
        relayerAddress: relayerField.toString(),
        relayerFeeMax: relayerFeeMax.toString(),
      },
      WITHDRAW_WASM,
      WITHDRAW_ZKEY
    );
    console.log("  Proof generated.");

    // ── 8. Submit through the relayer's HTTP endpoint ────────────────────
    const submitRes = await httpRequest(port, "POST", "/submit_proof", {
      proof,
      publicSignals,
      poolAddress: poolPda.toBase58(),
      recipient: recipient.publicKey.toBase58(),
      relayerFeeMax: relayerFeeMax.toString(),
    });
    console.log("  Submit response:", submitRes.status, JSON.stringify(submitRes.body));
    assert.equal(submitRes.status, 200, `Submit failed: ${JSON.stringify(submitRes.body)}`);
    assert.ok(submitRes.body.txSignature, "Should return tx signature");
    const feeTaken = BigInt(submitRes.body.feeTaken);
    assert.ok(feeTaken <= relayerFeeMax, "relayer took no more than the ceiling");

    // ── 9. Exact payout, and the note is spent ───────────────────────────
    const treasuryFee = DENOMINATION / 500n;
    const recipientBalance = BigInt(await connection.getBalance(recipient.publicKey));
    console.log("  Recipient balance:", recipientBalance.toString(), "lamports");
    assert.equal(
      recipientBalance,
      DENOMINATION - treasuryFee - feeTaken,
      "recipient receives exactly denomination - treasury fee - relayer fee"
    );
    const [nullifierPda] = findNullifierPda(poolPda, note.nullifierHash);
    const nullifier = await connection.getAccountInfo(nullifierPda);
    assert.ok(nullifier && nullifier.owner.equals(PROGRAM_ID) && nullifier.data.length > 0,
      "nullifier account exists, so the note cannot be spent again");

    // ── 10. Sweep the payout back, so a run costs only rent and fees ─────
    await sendAndConfirmTransaction(
      connection,
      new Transaction({ feePayer: walletKeypair.publicKey }).add(
        SystemProgram.transfer({
          fromPubkey: recipient.publicKey,
          toPubkey: walletKeypair.publicKey,
          lamports: recipientBalance,
        })
      ),
      [walletKeypair, recipient],
      { commitment: "confirmed" }
    );

    // The wallet is depositor, treasury and relayer. It gets back the treasury fee, the relayer
    // fee (which is exactly the relayer's own cost, H-3) and the swept payout. What remains is the
    // deposit's signature fee and the sweep's two: an honest relayer breaks even to the lamport.
    const walletAfter = BigInt(await connection.getBalance(walletKeypair.publicKey));
    const spent = walletBefore - walletAfter;
    console.log("  Net cost of this run:", spent.toString(), "lamports");
    assert.equal(
      spent,
      feeTaken + 3n * BASE_FEE,
      "net cost = relayer's cost (nullifier rent + its fees) + deposit fee + sweep fees"
    );

    console.log("\n  T30 — PASSED: full deposit→proof→relayer→withdrawal on devnet");
  });
});
