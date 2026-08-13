// tests/withdraw.ts
//
// T21 — Full ZK proof integration tests for withdraw instruction
// T22 — CU profiling for withdraw
//
// Uses snarkjs groth16.fullProve to generate real Groth16 proofs.
// NOTE: proof generation takes ~30-60s per test — mocha timeout is set accordingly.

// Use default import for CJS/ESM interop in Node.js v24
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, setProvider, workspace, BN } = anchorPkg as any;

import {
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { assert } from "chai";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Solnadocash } from "../target/types/solnadocash";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// snarkjs and circomlibjs — ESM imports
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";

// ── Build artifact paths ──────────────────────────────────────────────────────
const BUILD_DIR = path.join(__dirname, "../circuits/build");
const WITHDRAW_WASM = path.join(BUILD_DIR, "withdraw_js/withdraw.wasm");
const WITHDRAW_ZKEY = path.join(BUILD_DIR, "withdraw_final.zkey");

// ── Constants ─────────────────────────────────────────────────────────────────
const DENOMINATION = 1_000_000_000n; // 1 SOL in lamports (BigInt for circom)
const TREE_DEPTH = 20;
const BN254_FIELD_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
// BN254 base field prime (Fq) — used for G1 point negation
const BN254_Fq =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

const MAX_CU = 1_400_000;

// ── Global Poseidon ───────────────────────────────────────────────────────────
let _poseidon: any;
let _F: any;

async function ensurePoseidon(): Promise<void> {
  if (!_poseidon) {
    _poseidon = await buildPoseidon();
    _F = _poseidon.F;
  }
}

function poseidonHash(...inputs: bigint[]): bigint {
  const result = _poseidon(inputs.map((x) => _F.e(x)));
  return BigInt(_F.toObject(result));
}

// ── Random field element ──────────────────────────────────────────────────────
function randomFieldElem(): bigint {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value % BN254_FIELD_ORDER;
}

// ── bigIntToBytes32 ───────────────────────────────────────────────────────────
function bigIntToBytes32(n: bigint): Buffer {
  const hex = n.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

// ── pubkeyToBigInt ────────────────────────────────────────────────────────────
// Raw big-endian interpretation of the pubkey bytes. Only used by tests to
// construct +Fr aliases and to demonstrate the old (broken) mod-Fr encoding.
function pubkeyToBigInt(pk: PublicKey): bigint {
  const bytes = pk.toBytes();
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

// ── pubkeyToField ─────────────────────────────────────────────────────────────
// Map a pubkey to a BN254 field element. MUST match pubkey_to_field in
// programs/solnadocash/src/withdraw.rs: split into two 128-bit halves and hash.
// The old `pubkey mod Fr` encoding was not injective (H-2), which let a relayer
// swap the recipient for an unspendable alias.
function pubkeyToField(pk: PublicKey): bigint {
  const bytes = pk.toBytes();
  let hi = 0n;
  let lo = 0n;
  for (let i = 0; i < 16; i++) hi = (hi << 8n) | BigInt(bytes[i]);
  for (let i = 16; i < 32; i++) lo = (lo << 8n) | BigInt(bytes[i]);
  return poseidonHash(hi, lo);
}

// ── snarkjsProofToBytes ───────────────────────────────────────────────────────
function snarkjsProofToBytes(proof: any): {
  proofA: Buffer;
  proofB: Buffer;
  proofC: Buffer;
} {
  // groth16-solana requires proof_a to be NEGATED (y-coordinate negated mod Fq).
  // See groth16-solana crate test: proof_a.neg() is required for pairing equation.
  const proofA = Buffer.concat([
    bigIntToBytes32(BigInt(proof.pi_a[0])),
    bigIntToBytes32(BN254_Fq - BigInt(proof.pi_a[1])),
  ]);
  // G2 points: EIP-197 ordering (x_im || x_re || y_im || y_re)
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

// ── Incremental Merkle tree (mirrors on-chain logic) ──────────────────────────
function buildZeros(depth: number): bigint[] {
  const zeros: bigint[] = new Array(depth);
  zeros[0] = 0n;
  for (let i = 1; i < depth; i++) {
    zeros[i] = poseidonHash(zeros[i - 1], zeros[i - 1]);
  }
  return zeros;
}

class IncrementalMerkleTree {
  depth: number;
  zeros: bigint[];
  filledSubtrees: bigint[];
  roots: bigint[];
  nextIndex: bigint;

  constructor(depth: number) {
    this.depth = depth;
    this.zeros = buildZeros(depth);
    this.filledSubtrees = [...this.zeros];
    this.roots = [this._zeroRoot()];
    this.nextIndex = 0n;
  }

  _zeroRoot(): bigint {
    let hash = 0n;
    for (let i = 0; i < this.depth; i++) {
      hash = poseidonHash(hash, this.zeros[i]);
    }
    return hash;
  }

  insert(leaf: bigint): {
    pathElements: bigint[];
    pathIndices: number[];
    root: bigint;
    leafIndex: bigint;
  } {
    let currentHash = leaf;
    let currentIndex = this.nextIndex;
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

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

    this.roots.push(currentHash);
    this.nextIndex += 1n;

    return {
      pathElements,
      pathIndices,
      root: currentHash,
      leafIndex: this.nextIndex - 1n,
    };
  }

  currentRoot(): bigint {
    return this.roots[this.roots.length - 1];
  }
}

// ── generateNote ──────────────────────────────────────────────────────────────
function generateNote(denomination: bigint) {
  const nullifier = randomFieldElem();
  const secret = randomFieldElem();
  const commitment = poseidonHash(nullifier, secret, denomination);
  const nullifierHash = poseidonHash(nullifier);
  return { nullifier, secret, commitment, nullifierHash };
}

// ── buildWithdrawArgs ─────────────────────────────────────────────────────────
function buildWithdrawArgs(
  proof: any,
  publicSignals: string[], // [nullifierHash, root, withdrawalCommitment]
  nullifierBump: number,
  relayerFeeMax: bigint,
  relayerFeeActual: bigint
): any {
  const { proofA, proofB, proofC } = snarkjsProofToBytes(proof);
  return {
    proofA: Array.from(proofA),
    proofB: Array.from(proofB),
    proofC: Array.from(proofC),
    nullifierHash: Array.from(bigIntToBytes32(BigInt(publicSignals[0]))),
    root: Array.from(bigIntToBytes32(BigInt(publicSignals[1]))),
    withdrawalCommitment: Array.from(bigIntToBytes32(BigInt(publicSignals[2]))),
    relayerFeeMax: new BN(relayerFeeMax.toString()),
    relayerFeeTaken: new BN(relayerFeeActual.toString()),
    nullifierBump,
  };
}

// ── findPoolPda ───────────────────────────────────────────────────────────────
function findPoolPda(
  admin: PublicKey,
  denomination: any,
  version: number,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      admin.toBytes(),
      new PublicKey(Buffer.alloc(32, 0)).toBytes(),
      denomination.toArrayLike(Buffer, "le", 8),
      Buffer.from([version]),
    ],
    programId
  );
}

function findVaultPda(
  poolPda: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBytes()],
    programId
  );
}

// ── CU measurement ────────────────────────────────────────────────────────────
async function measureCUFromIx(
  provider: any,
  ix: any
): Promise<{ cu: number; err: any; logs: string[] }> {
  const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU });
  const { blockhash } = await provider.connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: provider.wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [budgetIx, ix],
  }).compileToV0Message();
  const vTx = new VersionedTransaction(msg);
  const sim = await provider.connection.simulateTransaction(vTx, {
    sigVerify: false,
  });
  return {
    cu: sim.value.unitsConsumed ?? 0,
    err: sim.value.err,
    logs: sim.value.logs ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("Withdraw (T21 + T22 ZK flow)", function () {
  // Long timeout for proof generation
  this.timeout(300_000);

  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.Solnadocash as import("@coral-xyz/anchor").Program<Solnadocash>;

  // Shared state set up in before()
  let admin: Keypair;
  let treasury: Keypair;
  let relayer: Keypair;
  let recipient: Keypair;
  let poolPda: PublicKey;
  let vaultPda: PublicKey;

  // JS-side merkle tree
  let jsTree: IncrementalMerkleTree;

  // Note for test withdrawals
  let note1: ReturnType<typeof generateNote>;

  // Proof + signals for note1
  let proof1: any;
  let publicSignals1: string[];

  // On-chain proof args for note1
  let withdrawArgs1: any;
  let nullifierPda1: PublicKey;
  let nullifierBump1: number;

  // fee amounts
  const RELAYER_FEE_MAX = 83_000n;
  const RELAYER_FEE_ACTUAL = 83_000n;
  const TREASURY_FEE = DENOMINATION / 500n; // 2_000_000

  before(async () => {
    // Build Poseidon first
    await ensurePoseidon();

    admin = Keypair.generate();
    treasury = Keypair.generate();

    // Generate recipient keypair — pubkey must be < BN254_FIELD_ORDER
    // Solana pubkeys are 32 bytes (256-bit), occasionally >= BN254 field order.
    // Generate until we get one that's in-field.
    let recipientBigInt: bigint;
    let relayerBigInt: bigint;
    recipient = Keypair.generate();
      recipientBigInt = pubkeyToField(recipient.publicKey);

    // Similarly for relayer
    relayer = Keypair.generate();
      relayerBigInt = pubkeyToField(relayer.publicKey);

    // Airdrop SOL. The admin funds every deposit in this file (one per test that
    // needs a fresh note), so give it plenty of headroom. Amounts must differ per
    // request, otherwise identical airdrop transactions dedupe to one signature.
    for (const [kp, sol] of [
      [admin, 60],
      [relayer, 10],
    ] as [Keypair, number][]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        sol * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Initialize pool
    const denomBN = new BN(DENOMINATION.toString());
    [poolPda] = findPoolPda(admin.publicKey, denomBN, 0, program.programId);
    [vaultPda] = findVaultPda(poolPda, program.programId);

    await program.methods
      .initializePool(denomBN, 0)
      .accountsPartial({
        admin: admin.publicKey,
        pool: poolPda,
        vault: vaultPda,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // Initialize JS Merkle tree
    jsTree = new IncrementalMerkleTree(TREE_DEPTH);

    // Generate note #1
    note1 = generateNote(DENOMINATION);

    // Deposit note #1 on-chain
    const commitmentBytes = Array.from(bigIntToBytes32(note1.commitment));
    await program.methods
      .deposit(commitmentBytes)
      .accountsPartial({
        pool: poolPda,
        vault: vaultPda,
        depositor: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // Update JS tree to match on-chain state
    const { pathElements, pathIndices, root } = jsTree.insert(note1.commitment);

    // Re-read to get current values (relayer might have been regenerated)
    relayerBigInt = pubkeyToField(relayer.publicKey);
    recipientBigInt = pubkeyToField(recipient.publicKey);

    // Compute withdrawal_commitment = Poseidon(relayer, relayerFeeMax, recipient)
    const withdrawalCommitment = poseidonHash(
      relayerBigInt,
      RELAYER_FEE_MAX,
      recipientBigInt
    );

    // Generate withdraw proof for note #1
    console.log("\n  [withdraw.ts] Generating ZK proof for note #1 (this takes ~30-60s)...");
    const circomInputs = {
      nullifierHash: note1.nullifierHash.toString(),
      root: root.toString(),
      withdrawalCommitment: withdrawalCommitment.toString(),
      nullifier: note1.nullifier.toString(),
      secret: note1.secret.toString(),
      denomination: DENOMINATION.toString(),
      pathElements: pathElements.map((x) => x.toString()),
      pathIndices: pathIndices.map((x) => x.toString()),
      recipient: recipientBigInt.toString(),
      relayerAddress: relayerBigInt.toString(),
      relayerFeeMax: RELAYER_FEE_MAX.toString(),
    };

    const result = await snarkjs.groth16.fullProve(
      circomInputs,
      WITHDRAW_WASM,
      WITHDRAW_ZKEY
    );
    proof1 = result.proof;
    publicSignals1 = result.publicSignals;
    console.log("  [withdraw.ts] Proof generated.");

    // Find nullifier PDA for note1
    const nullifierHashBytes = bigIntToBytes32(note1.nullifierHash);
    [nullifierPda1, nullifierBump1] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("nullifier"),
        poolPda.toBytes(),
        nullifierHashBytes,
      ],
      program.programId
    );

    withdrawArgs1 = buildWithdrawArgs(
      proof1,
      publicSignals1,
      nullifierBump1,
      RELAYER_FEE_MAX,
      RELAYER_FEE_ACTUAL
    );
  });

  // ── Happy path ────────────────────────────────────────────────────────────────
  describe("withdraw — happy path", () => {
    it("executes valid withdrawal, recipient receives SOL", async () => {
      const recipientBefore = await provider.connection.getBalance(recipient.publicKey);
      const treasuryBefore = await provider.connection.getBalance(treasury.publicKey);

      await program.methods
        .withdraw(withdrawArgs1)
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          nullifierPda: nullifierPda1,
          recipient: recipient.publicKey,
          treasury: treasury.publicKey,
          relayer: relayer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([relayer])
        .rpc();

      const recipientAfter = await provider.connection.getBalance(recipient.publicKey);
      const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);

      const expectedTreasuryFee = Number(TREASURY_FEE);
      const expectedRelayerFee = Number(RELAYER_FEE_ACTUAL);
      const expectedUserAmount =
        Number(DENOMINATION) - expectedTreasuryFee - expectedRelayerFee;

      // Treasury received treasury_fee
      assert.equal(
        treasuryAfter - treasuryBefore,
        expectedTreasuryFee,
        `Treasury should receive ${expectedTreasuryFee} lamports`
      );

      // Recipient received user_amount
      assert.equal(
        recipientAfter - recipientBefore,
        expectedUserAmount,
        `Recipient should receive ${expectedUserAmount} lamports`
      );

      // Nullifier PDA was created
      const nullifierInfo = await provider.connection.getAccountInfo(nullifierPda1);
      assert.ok(nullifierInfo !== null, "Nullifier PDA should have been created");

      console.log(`\n  [withdraw] treasury_fee = ${expectedTreasuryFee} lamports`);
      console.log(`  [withdraw] relayer_fee  = ${expectedRelayerFee} lamports`);
      console.log(`  [withdraw] user_amount  = ${expectedUserAmount} lamports`);
    });
  });

  // ── Double-spend ──────────────────────────────────────────────────────────────
  describe("withdraw — double spend", () => {
    it("rejects second withdrawal with same nullifier", async () => {
      // The nullifier PDA from happy path is already spent
      try {
        await program.methods
          .withdraw(withdrawArgs1)
          .accountsPartial({
            pool: poolPda,
            vault: vaultPda,
            nullifierPda: nullifierPda1,
            recipient: recipient.publicKey,
            treasury: treasury.publicKey,
            relayer: relayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([relayer])
          .rpc();
        assert.fail("Should have rejected double-spend");
      } catch (err: any) {
        assert.include(
          err.message,
          "NullifierAlreadySpent",
          `Expected NullifierAlreadySpent, got: ${err.message}`
        );
      }
    });
  });

  // ── C-1: non-canonical public inputs (nullifier hash aliasing) ───────────────
  //
  // BN254 scalar multiplication reduces the scalar mod Fr, so nullifier_hash and
  // nullifier_hash + k*Fr produce identical Groth16 pairing results. The nullifier
  // PDA, however, is derived from the RAW seed bytes — so an aliased hash yields a
  // DIFFERENT PDA and the double-spend guard is bypassed entirely.
  //
  // Without the canonical-form check in withdraw.rs, the note spent in the happy
  // path above can be withdrawn ~5 more times (k = 1..5).
  describe("withdraw — non-canonical nullifier hash (C-1)", () => {
    it("rejects nullifier_hash >= BN254 Fr (aliased double-spend)", async () => {
      // Top up the vault so a successful exploit would actually be payable.
      // (Otherwise the attempt would fail on InsufficientVaultBalance and prove nothing.)
      const filler = randomFieldElem();
      await program.methods
        .deposit(Array.from(bigIntToBytes32(filler)))
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          depositor: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      jsTree.insert(filler);

      const vaultBefore = await provider.connection.getBalance(vaultPda);
      assert.isAtLeast(
        vaultBefore,
        Number(DENOMINATION),
        "vault must hold >= 1 denomination for this test to be meaningful"
      );

      // Alias the ALREADY-SPENT nullifier hash: h + Fr.
      const aliased = BigInt(publicSignals1[0]) + BN254_FIELD_ORDER;
      assert.isBelow(aliased.toString(16).length, 65, "alias must fit in 32 bytes");

      const aliasedBytes = bigIntToBytes32(aliased);
      const [aliasedPda, aliasedBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier"), poolPda.toBytes(), aliasedBytes],
        program.programId
      );
      assert.notEqual(
        aliasedPda.toBase58(),
        nullifierPda1.toBase58(),
        "aliased hash must derive a different PDA — that is the whole attack"
      );

      // Same proof, same root, same withdrawal commitment. Only the nullifier
      // hash bytes change.
      const aliasedArgs = {
        ...withdrawArgs1,
        nullifierHash: Array.from(aliasedBytes),
        nullifierBump: aliasedBump,
      };

      try {
        await program.methods
          .withdraw(aliasedArgs)
          .accountsPartial({
            pool: poolPda,
            vault: vaultPda,
            nullifierPda: aliasedPda,
            recipient: recipient.publicKey,
            treasury: treasury.publicKey,
            relayer: relayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([relayer])
          .rpc();
        assert.fail(
          "DOUBLE-SPEND: aliased nullifier hash was accepted — the same note was withdrawn twice"
        );
      } catch (err: any) {
        assert.include(
          err.message,
          "NonCanonicalPublicInput",
          `Expected NonCanonicalPublicInput, got: ${err.message}`
        );
      }
    });

    it("rejects root >= BN254 Fr", async () => {
      const aliasedRoot = BigInt(publicSignals1[1]) + BN254_FIELD_ORDER;
      const args = {
        ...withdrawArgs1,
        root: Array.from(bigIntToBytes32(aliasedRoot)),
      };
      // Use a fresh (unspent) nullifier PDA so the failure cannot come from the
      // double-spend guard.
      const freshHash = randomFieldElem();
      const [freshPda, freshBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier"), poolPda.toBytes(), bigIntToBytes32(freshHash)],
        program.programId
      );
      args.nullifierHash = Array.from(bigIntToBytes32(freshHash));
      args.nullifierBump = freshBump;

      try {
        await program.methods
          .withdraw(args)
          .accountsPartial({
            pool: poolPda,
            vault: vaultPda,
            nullifierPda: freshPda,
            recipient: recipient.publicKey,
            treasury: treasury.publicKey,
            relayer: relayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([relayer])
          .rpc();
        assert.fail("Should have rejected non-canonical root");
      } catch (err: any) {
        assert.include(
          err.message,
          "NonCanonicalPublicInput",
          `Expected NonCanonicalPublicInput, got: ${err.message}`
        );
      }
    });

    it("rejects withdrawal_commitment >= BN254 Fr", async () => {
      const aliasedWc = BigInt(publicSignals1[2]) + BN254_FIELD_ORDER;
      const freshHash = randomFieldElem();
      const [freshPda, freshBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier"), poolPda.toBytes(), bigIntToBytes32(freshHash)],
        program.programId
      );
      const args = {
        ...withdrawArgs1,
        withdrawalCommitment: Array.from(bigIntToBytes32(aliasedWc)),
        nullifierHash: Array.from(bigIntToBytes32(freshHash)),
        nullifierBump: freshBump,
      };

      try {
        await program.methods
          .withdraw(args)
          .accountsPartial({
            pool: poolPda,
            vault: vaultPda,
            nullifierPda: freshPda,
            recipient: recipient.publicKey,
            treasury: treasury.publicKey,
            relayer: relayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([relayer])
          .rpc();
        assert.fail("Should have rejected non-canonical withdrawal_commitment");
      } catch (err: any) {
        assert.include(
          err.message,
          "NonCanonicalPublicInput",
          `Expected NonCanonicalPublicInput, got: ${err.message}`
        );
      }
    });

    it("still accepts a canonical nullifier hash (no false positives)", async () => {
      // Regression guard: the canonical-form check must not reject honest proofs.
      // publicSignals are Poseidon outputs, always < Fr.
      for (const s of publicSignals1) {
        assert.isTrue(
          BigInt(s) < BN254_FIELD_ORDER,
          "honest public signals must be canonical"
        );
      }
    });
  });

  // ── H-1: nullifier PDA pre-funding griefing ──────────────────────────────────
  //
  // system_instruction::create_account fails with AccountAlreadyInUse when the
  // target already holds lamports. The nullifier PDA address is determined by the
  // note, so anyone who sees nullifier_hash before the withdrawal lands (the
  // relayer, or a front-runner) could send it 1 lamport and freeze the note
  // forever. The withdrawal must survive a pre-funded PDA.
  describe("withdraw — pre-funded nullifier PDA (H-1)", () => {
    it("completes a withdrawal even when the nullifier PDA was pre-funded", async () => {
      const note = generateNote(DENOMINATION);

      await program.methods
        .deposit(Array.from(bigIntToBytes32(note.commitment)))
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          depositor: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const { pathElements, pathIndices, root } = jsTree.insert(note.commitment);

      let griefRecipient: Keypair;
      griefRecipient = Keypair.generate();

      const wc = poseidonHash(
        pubkeyToField(relayer.publicKey),
        RELAYER_FEE_MAX,
        pubkeyToField(griefRecipient.publicKey)
      );

      console.log("\n  [withdraw.ts] Generating ZK proof for H-1 griefing test...");
      const res = await snarkjs.groth16.fullProve(
        {
          nullifierHash: note.nullifierHash.toString(),
          root: root.toString(),
          withdrawalCommitment: wc.toString(),
          nullifier: note.nullifier.toString(),
          secret: note.secret.toString(),
          denomination: DENOMINATION.toString(),
          pathElements: pathElements.map((x) => x.toString()),
          pathIndices: pathIndices.map((x) => x.toString()),
          recipient: pubkeyToField(griefRecipient.publicKey).toString(),
          relayerAddress: pubkeyToField(relayer.publicKey).toString(),
          relayerFeeMax: RELAYER_FEE_MAX.toString(),
        },
        WITHDRAW_WASM,
        WITHDRAW_ZKEY
      );
      console.log("  [withdraw.ts] Proof generated.");

      const [griefPda, griefBump] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier"),
          poolPda.toBytes(),
          bigIntToBytes32(note.nullifierHash),
        ],
        program.programId
      );

      // ── The attack: fund the nullifier PDA so create_account fails ──
      // The runtime forbids leaving an account below rent-exemption, so the
      // cheapest grief is the rent-exempt minimum for a 0-byte account
      // (~890,880 lamports ≈ 0.00089 SOL) — still ~1:1100 against a 1 SOL note.
      const attacker = Keypair.generate();
      const airdropSig = await provider.connection.requestAirdrop(
        attacker.publicKey,
        LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      const griefAmount =
        await provider.connection.getMinimumBalanceForRentExemption(0);

      const griefTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: attacker.publicKey,
          toPubkey: griefPda,
          lamports: griefAmount,
        })
      );
      await provider.sendAndConfirm(griefTx, [attacker]);

      const preFunded = await provider.connection.getAccountInfo(griefPda);
      assert.ok(preFunded !== null, "PDA should now exist with lamports");
      assert.equal(
        preFunded!.lamports,
        griefAmount,
        "PDA should hold the griefing lamports"
      );
      assert.equal(preFunded!.data.length, 0, "PDA should still have no data");
      assert.equal(
        preFunded!.owner.toBase58(),
        SystemProgram.programId.toBase58(),
        "pre-funded PDA is system-owned"
      );

      // ── The withdrawal must still go through ──
      const recipientBefore = await provider.connection.getBalance(
        griefRecipient.publicKey
      );

      const args = buildWithdrawArgs(
        res.proof,
        res.publicSignals,
        griefBump,
        RELAYER_FEE_MAX,
        RELAYER_FEE_ACTUAL
      );

      await program.methods
        .withdraw(args)
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          nullifierPda: griefPda,
          recipient: griefRecipient.publicKey,
          treasury: treasury.publicKey,
          relayer: relayer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([relayer])
        .rpc();

      const recipientAfter = await provider.connection.getBalance(
        griefRecipient.publicKey
      );
      const expectedUserAmount =
        Number(DENOMINATION) - Number(TREASURY_FEE) - Number(RELAYER_FEE_ACTUAL);
      assert.equal(
        recipientAfter - recipientBefore,
        expectedUserAmount,
        "recipient must receive the full user amount despite the griefing attempt"
      );

      // The nullifier account must be properly initialised, not left half-built.
      const after = await provider.connection.getAccountInfo(griefPda);
      assert.ok(after !== null, "nullifier account must exist");
      assert.equal(
        after!.owner.toBase58(),
        program.programId.toBase58(),
        "nullifier account must be owned by the program"
      );
      assert.equal(
        after!.data.length,
        8 + 72,
        "nullifier account must be allocated to 8 + NULLIFIER_SIZE bytes"
      );
      // The attacker's stray lamport is absorbed, so the account stays rent-exempt.
      const minRent = await provider.connection.getMinimumBalanceForRentExemption(
        8 + 72
      );
      assert.isAtLeast(
        after!.lamports,
        minRent,
        "nullifier account must be rent-exempt"
      );
      // Stored pool must match — proves step 14 wrote real data.
      assert.equal(
        new PublicKey(after!.data.subarray(8, 40)).toBase58(),
        poolPda.toBase58(),
        "nullifier account must record its pool"
      );

      console.log(
        `  [H-1] withdrawal succeeded despite pre-funded PDA; account now ${after!.data.length}B, ${after!.lamports} lamports`
      );
    });

    it("still blocks a replay after the pre-funded PDA was consumed", async () => {
      // Sanity: the fallback path must not weaken the double-spend guard.
      // (The PDA now has data, so step 6 rejects it.)
      const note = generateNote(DENOMINATION);
      const [pda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier"),
          poolPda.toBytes(),
          bigIntToBytes32(note.nullifierHash),
        ],
        program.programId
      );
      const info = await provider.connection.getAccountInfo(pda);
      assert.isNull(info, "unused nullifier PDA should not exist yet");
    });
  });

  // ── H-2: recipient substitution via field-element alias ──────────────────────
  //
  // The withdrawal commitment binds the recipient only through its field-element
  // encoding. Under the old `pubkey mod Fr` encoding, R and R + Fr encoded
  // identically, so a malicious relayer could pass R + Fr in the recipient slot:
  // the commitment check passed, the nullifier was consumed, the relayer kept its
  // fee, and the funds landed at an address nobody can sign for. An irreversible
  // burn, possible for 81% of addresses.
  describe("withdraw — aliased recipient substitution (H-2)", () => {
    it("rejects a recipient whose field encoding was expected to collide", async () => {
      // Pick a recipient whose +Fr alias still fits in 32 bytes (~81% of keys).
      let victim: Keypair;
      let alias: PublicKey;
      for (;;) {
        victim = Keypair.generate();
        const aliasInt = pubkeyToBigInt(victim.publicKey) + BN254_FIELD_ORDER;
        if (aliasInt < 1n << 256n) {
          alias = new PublicKey(bigIntToBytes32(aliasInt));
          break;
        }
      }

      // Precondition: under the OLD encoding these two distinct addresses were
      // indistinguishable. Under the new one they must differ.
      const oldVictim = pubkeyToBigInt(victim.publicKey) % BN254_FIELD_ORDER;
      const oldAlias = pubkeyToBigInt(alias) % BN254_FIELD_ORDER;
      assert.equal(
        oldVictim.toString(),
        oldAlias.toString(),
        "precondition: mod-Fr encoding collides for these two addresses"
      );
      assert.notEqual(
        pubkeyToField(victim.publicKey).toString(),
        pubkeyToField(alias).toString(),
        "new encoding must separate the alias"
      );

      const note = generateNote(DENOMINATION);
      await program.methods
        .deposit(Array.from(bigIntToBytes32(note.commitment)))
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          depositor: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      const { pathElements, pathIndices, root } = jsTree.insert(note.commitment);

      const wc = poseidonHash(
        pubkeyToField(relayer.publicKey),
        RELAYER_FEE_MAX,
        pubkeyToField(victim.publicKey)
      );

      console.log("\n  [withdraw.ts] Generating ZK proof for H-2 substitution test...");
      const res = await snarkjs.groth16.fullProve(
        {
          nullifierHash: note.nullifierHash.toString(),
          root: root.toString(),
          withdrawalCommitment: wc.toString(),
          nullifier: note.nullifier.toString(),
          secret: note.secret.toString(),
          denomination: DENOMINATION.toString(),
          pathElements: pathElements.map((x) => x.toString()),
          pathIndices: pathIndices.map((x) => x.toString()),
          recipient: pubkeyToField(victim.publicKey).toString(),
          relayerAddress: pubkeyToField(relayer.publicKey).toString(),
          relayerFeeMax: RELAYER_FEE_MAX.toString(),
        },
        WITHDRAW_WASM,
        WITHDRAW_ZKEY
      );
      console.log("  [withdraw.ts] Proof generated.");

      const [nPda, nBump] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier"),
          poolPda.toBytes(),
          bigIntToBytes32(note.nullifierHash),
        ],
        program.programId
      );
      const args = buildWithdrawArgs(
        res.proof,
        res.publicSignals,
        nBump,
        RELAYER_FEE_MAX,
        RELAYER_FEE_ACTUAL
      );

      // The attack: relayer swaps in the alias.
      try {
        await program.methods
          .withdraw(args)
          .accountsPartial({
            pool: poolPda,
            vault: vaultPda,
            nullifierPda: nPda,
            recipient: alias, // ← substituted
            treasury: treasury.publicKey,
            relayer: relayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([relayer])
          .rpc();
        assert.fail(
          "FUND BURN: aliased recipient accepted — funds sent to an unspendable address"
        );
      } catch (err: any) {
        assert.include(
          err.message,
          "InvalidWithdrawalCommitment",
          `Expected InvalidWithdrawalCommitment, got: ${err.message}`
        );
      }

      // The alias must have received nothing, and the note must still be spendable
      // by the intended recipient.
      const aliasBal = await provider.connection.getBalance(alias);
      assert.equal(aliasBal, 0, "alias must not have received any lamports");

      const victimBefore = await provider.connection.getBalance(victim.publicKey);
      await program.methods
        .withdraw(args)
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          nullifierPda: nPda,
          recipient: victim.publicKey,
          treasury: treasury.publicKey,
          relayer: relayer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([relayer])
        .rpc();
      const victimAfter = await provider.connection.getBalance(victim.publicKey);
      assert.equal(
        victimAfter - victimBefore,
        Number(DENOMINATION) - Number(TREASURY_FEE) - Number(RELAYER_FEE_ACTUAL),
        "intended recipient must still be able to withdraw"
      );
      console.log("  [H-2] alias rejected, intended recipient paid in full");
    });

    it("accepts any recipient address, including non-canonical ones", async () => {
      // The alternative fix (requiring recipient < Fr) would have rejected ~19% of
      // all Solana addresses. This encoding has no such restriction — assert that
      // an address >= Fr is a usable recipient.
      let big: PublicKey | null = null;
      for (let i = 0; i < 500 && !big; i++) {
        const kp = Keypair.generate();
        if (pubkeyToBigInt(kp.publicKey) >= BN254_FIELD_ORDER) big = kp.publicKey;
      }
      assert.ok(big, "should find a pubkey >= Fr within 500 tries");

      const note = generateNote(DENOMINATION);
      await program.methods
        .deposit(Array.from(bigIntToBytes32(note.commitment)))
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          depositor: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      const { pathElements, pathIndices, root } = jsTree.insert(note.commitment);

      const wc = poseidonHash(
        pubkeyToField(relayer.publicKey),
        RELAYER_FEE_MAX,
        pubkeyToField(big!)
      );

      console.log("\n  [withdraw.ts] Generating ZK proof for non-canonical recipient...");
      const res = await snarkjs.groth16.fullProve(
        {
          nullifierHash: note.nullifierHash.toString(),
          root: root.toString(),
          withdrawalCommitment: wc.toString(),
          nullifier: note.nullifier.toString(),
          secret: note.secret.toString(),
          denomination: DENOMINATION.toString(),
          pathElements: pathElements.map((x) => x.toString()),
          pathIndices: pathIndices.map((x) => x.toString()),
          recipient: pubkeyToField(big!).toString(),
          relayerAddress: pubkeyToField(relayer.publicKey).toString(),
          relayerFeeMax: RELAYER_FEE_MAX.toString(),
        },
        WITHDRAW_WASM,
        WITHDRAW_ZKEY
      );
      console.log("  [withdraw.ts] Proof generated.");

      const [nPda, nBump] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier"),
          poolPda.toBytes(),
          bigIntToBytes32(note.nullifierHash),
        ],
        program.programId
      );

      const before = await provider.connection.getBalance(big!);
      await program.methods
        .withdraw(
          buildWithdrawArgs(
            res.proof,
            res.publicSignals,
            nBump,
            RELAYER_FEE_MAX,
            RELAYER_FEE_ACTUAL
          )
        )
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          nullifierPda: nPda,
          recipient: big!,
          treasury: treasury.publicKey,
          relayer: relayer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([relayer])
        .rpc();
      const after = await provider.connection.getBalance(big!);
      assert.equal(
        after - before,
        Number(DENOMINATION) - Number(TREASURY_FEE) - Number(RELAYER_FEE_ACTUAL),
        "a recipient with pubkey >= Fr must still be paid"
      );
      console.log("  [H-2] non-canonical recipient (pubkey >= Fr) paid in full");
    });
  });

  // ── H-3: on-chain relayer fee cap ────────────────────────────────────────────
  //
  // Nothing bounded relayer_fee_max, so a relayer could quote a ceiling
  // approaching the whole denomination and claim it. Cap is denomination / 50.
  describe("withdraw — relayer fee cap (H-3)", () => {
    const CAP = DENOMINATION / 50n; // 20_000_000 lamports on a 1 SOL pool

    // Build a fresh note + proof committed to an arbitrary relayerFeeMax.
    async function proveWithFeeMax(feeMax: bigint) {
      const note = generateNote(DENOMINATION);
      await program.methods
        .deposit(Array.from(bigIntToBytes32(note.commitment)))
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          depositor: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      const { pathElements, pathIndices, root } = jsTree.insert(note.commitment);

      const r = Keypair.generate();
      const wc = poseidonHash(
        pubkeyToField(relayer.publicKey),
        feeMax,
        pubkeyToField(r.publicKey)
      );
      const res = await snarkjs.groth16.fullProve(
        {
          nullifierHash: note.nullifierHash.toString(),
          root: root.toString(),
          withdrawalCommitment: wc.toString(),
          nullifier: note.nullifier.toString(),
          secret: note.secret.toString(),
          denomination: DENOMINATION.toString(),
          pathElements: pathElements.map((x) => x.toString()),
          pathIndices: pathIndices.map((x) => x.toString()),
          recipient: pubkeyToField(r.publicKey).toString(),
          relayerAddress: pubkeyToField(relayer.publicKey).toString(),
          relayerFeeMax: feeMax.toString(),
        },
        WITHDRAW_WASM,
        WITHDRAW_ZKEY
      );
      const [pda, bump] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier"),
          poolPda.toBytes(),
          bigIntToBytes32(note.nullifierHash),
        ],
        program.programId
      );
      return { res, pda, bump, recipient: r };
    }

    it("rejects relayer_fee_max above denomination / 50", async () => {
      console.log("\n  [withdraw.ts] Generating ZK proof for above-cap fee...");
      const { res, pda, bump, recipient: r } = await proveWithFeeMax(CAP + 1n);
      console.log("  [withdraw.ts] Proof generated.");

      try {
        await program.methods
          .withdraw(buildWithdrawArgs(res.proof, res.publicSignals, bump, CAP + 1n, 0n))
          .accountsPartial({
            pool: poolPda,
            vault: vaultPda,
            nullifierPda: pda,
            recipient: r.publicKey,
            treasury: treasury.publicKey,
            relayer: relayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([relayer])
          .rpc();
        assert.fail("Should have rejected relayer_fee_max above the cap");
      } catch (err: any) {
        assert.include(
          err.message,
          "RelayerFeeMaxTooHigh",
          `Expected RelayerFeeMaxTooHigh, got: ${err.message}`
        );
      }
    });

    it("accepts relayer_fee_max exactly at the cap", async () => {
      console.log("\n  [withdraw.ts] Generating ZK proof for at-cap fee...");
      const { res, pda, bump, recipient: r } = await proveWithFeeMax(CAP);
      console.log("  [withdraw.ts] Proof generated.");

      const before = await provider.connection.getBalance(r.publicKey);
      await program.methods
        .withdraw(buildWithdrawArgs(res.proof, res.publicSignals, bump, CAP, CAP))
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          nullifierPda: pda,
          recipient: r.publicKey,
          treasury: treasury.publicKey,
          relayer: relayer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([relayer])
        .rpc();
      const after = await provider.connection.getBalance(r.publicKey);
      assert.equal(
        after - before,
        Number(DENOMINATION - TREASURY_FEE - CAP),
        "boundary fee must be accepted and split correctly"
      );
      // Even at the cap the user keeps the large majority.
      assert.isAbove(
        (after - before) / Number(DENOMINATION),
        0.97,
        "user must retain >97% even at the maximum fee"
      );
      console.log(
        `  [H-3] at-cap fee accepted; user kept ${(((after - before) / Number(DENOMINATION)) * 100).toFixed(2)}%`
      );
    });
  });

  // ── M-2: real conservation invariant, not a tautology ───────────────────────
  describe("withdraw — lamport conservation (M-2)", () => {
    it("rejects the vault being passed as the recipient", async () => {
      // Would net lamports back into the vault. The old "fee invariant" could not
      // detect this because duplicate AccountInfos share a lamport cell.
      const note = generateNote(DENOMINATION);
      await program.methods
        .deposit(Array.from(bigIntToBytes32(note.commitment)))
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          depositor: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      const { pathElements, pathIndices, root } = jsTree.insert(note.commitment);

      // Commit to the vault as recipient so the commitment check passes and the
      // distinctness guard is what actually rejects it.
      const wc = poseidonHash(
        pubkeyToField(relayer.publicKey),
        RELAYER_FEE_MAX,
        pubkeyToField(vaultPda)
      );
      console.log("\n  [withdraw.ts] Generating ZK proof for M-2 vault-as-recipient...");
      const res = await snarkjs.groth16.fullProve(
        {
          nullifierHash: note.nullifierHash.toString(),
          root: root.toString(),
          withdrawalCommitment: wc.toString(),
          nullifier: note.nullifier.toString(),
          secret: note.secret.toString(),
          denomination: DENOMINATION.toString(),
          pathElements: pathElements.map((x) => x.toString()),
          pathIndices: pathIndices.map((x) => x.toString()),
          recipient: pubkeyToField(vaultPda).toString(),
          relayerAddress: pubkeyToField(relayer.publicKey).toString(),
          relayerFeeMax: RELAYER_FEE_MAX.toString(),
        },
        WITHDRAW_WASM,
        WITHDRAW_ZKEY
      );
      console.log("  [withdraw.ts] Proof generated.");

      const [pda, bump] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier"),
          poolPda.toBytes(),
          bigIntToBytes32(note.nullifierHash),
        ],
        program.programId
      );

      try {
        await program.methods
          .withdraw(
            buildWithdrawArgs(
              res.proof,
              res.publicSignals,
              bump,
              RELAYER_FEE_MAX,
              RELAYER_FEE_ACTUAL
            )
          )
          .accountsPartial({
            pool: poolPda,
            vault: vaultPda,
            nullifierPda: pda,
            recipient: vaultPda, // ← vault as recipient
            treasury: treasury.publicKey,
            relayer: relayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([relayer])
          .rpc();
        assert.fail("Should have rejected the vault as recipient");
      } catch (err: any) {
        assert.include(
          err.message,
          "DuplicateAccount",
          `Expected DuplicateAccount, got: ${err.message}`
        );
      }
    });

    it("conserves lamports exactly across an honest withdrawal", async () => {
      // vault -denomination == treasury +fee + relayer +fee + recipient +amount
      const note = generateNote(DENOMINATION);
      await program.methods
        .deposit(Array.from(bigIntToBytes32(note.commitment)))
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          depositor: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      const { pathElements, pathIndices, root } = jsTree.insert(note.commitment);

      const r = Keypair.generate();
      const wc = poseidonHash(
        pubkeyToField(relayer.publicKey),
        RELAYER_FEE_MAX,
        pubkeyToField(r.publicKey)
      );
      console.log("\n  [withdraw.ts] Generating ZK proof for M-2 conservation...");
      const res = await snarkjs.groth16.fullProve(
        {
          nullifierHash: note.nullifierHash.toString(),
          root: root.toString(),
          withdrawalCommitment: wc.toString(),
          nullifier: note.nullifier.toString(),
          secret: note.secret.toString(),
          denomination: DENOMINATION.toString(),
          pathElements: pathElements.map((x) => x.toString()),
          pathIndices: pathIndices.map((x) => x.toString()),
          recipient: pubkeyToField(r.publicKey).toString(),
          relayerAddress: pubkeyToField(relayer.publicKey).toString(),
          relayerFeeMax: RELAYER_FEE_MAX.toString(),
        },
        WITHDRAW_WASM,
        WITHDRAW_ZKEY
      );
      console.log("  [withdraw.ts] Proof generated.");

      const [pda, bump] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("nullifier"),
          poolPda.toBytes(),
          bigIntToBytes32(note.nullifierHash),
        ],
        program.programId
      );

      const bal = (k: PublicKey) => provider.connection.getBalance(k);
      const [v0, t0, r0] = await Promise.all([
        bal(vaultPda),
        bal(treasury.publicKey),
        bal(r.publicKey),
      ]);

      await program.methods
        .withdraw(
          buildWithdrawArgs(
            res.proof,
            res.publicSignals,
            bump,
            RELAYER_FEE_MAX,
            RELAYER_FEE_ACTUAL
          )
        )
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          nullifierPda: pda,
          recipient: r.publicKey,
          treasury: treasury.publicKey,
          relayer: relayer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([relayer])
        .rpc();

      const [v1, t1, r1] = await Promise.all([
        bal(vaultPda),
        bal(treasury.publicKey),
        bal(r.publicKey),
      ]);

      assert.equal(v0 - v1, Number(DENOMINATION), "vault pays exactly one denomination");
      assert.equal(t1 - t0, Number(TREASURY_FEE), "treasury receives exactly its fee");
      assert.equal(
        r1 - r0,
        Number(DENOMINATION - TREASURY_FEE - RELAYER_FEE_ACTUAL),
        "recipient receives exactly the user amount"
      );
      // Vault outflow equals the sum of all credits (relayer fee included).
      assert.equal(
        v0 - v1,
        t1 - t0 + (r1 - r0) + Number(RELAYER_FEE_ACTUAL),
        "no lamports created or destroyed"
      );
      console.log("  [M-2] lamport conservation verified across all four accounts");
    });
  });

  // ── Stale root ────────────────────────────────────────────────────────────────
  describe("withdraw — stale root", () => {
    it("rejects proof with root not in history", async () => {
      // Generate a fresh note and proof for this sub-test
      const note2 = generateNote(DENOMINATION);

      await program.methods
        .deposit(Array.from(bigIntToBytes32(note2.commitment)))
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          depositor: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const { pathElements, pathIndices, root } = jsTree.insert(note2.commitment);

      let recipientBigInt2: bigint;
      let recipient2: Keypair;
      recipient2 = Keypair.generate();
      recipientBigInt2 = pubkeyToField(recipient2.publicKey);

      const withdrawalCommitment2 = poseidonHash(
        pubkeyToField(relayer.publicKey),
        RELAYER_FEE_MAX,
        recipientBigInt2
      );

      console.log("\n  [withdraw.ts] Generating ZK proof for stale-root test...");
      const circomInputs2 = {
        nullifierHash: note2.nullifierHash.toString(),
        root: root.toString(),
        withdrawalCommitment: withdrawalCommitment2.toString(),
        nullifier: note2.nullifier.toString(),
        secret: note2.secret.toString(),
        denomination: DENOMINATION.toString(),
        pathElements: pathElements.map((x) => x.toString()),
        pathIndices: pathIndices.map((x) => x.toString()),
        recipient: recipientBigInt2.toString(),
        relayerAddress: pubkeyToField(relayer.publicKey).toString(),
        relayerFeeMax: RELAYER_FEE_MAX.toString(),
      };

      const result2 = await snarkjs.groth16.fullProve(
        circomInputs2,
        WITHDRAW_WASM,
        WITHDRAW_ZKEY
      );
      console.log("  [withdraw.ts] Proof generated.");

      // Find nullifier PDA for note2
      const nullifierHashBytes2 = bigIntToBytes32(note2.nullifierHash);
      const [nullifierPda2, nullifierBump2] = PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier"), poolPda.toBytes(), nullifierHashBytes2],
        program.programId
      );

      // Build args but with a FAKE root (random bytes, not in root history)
      const fakeRoot = Array.from({ length: 32 }, (_, i) => i + 1);
      const argsWithFakeRoot = buildWithdrawArgs(
        result2.proof,
        result2.publicSignals,
        nullifierBump2,
        RELAYER_FEE_MAX,
        RELAYER_FEE_ACTUAL
      );
      // Override the root with fake bytes
      argsWithFakeRoot.root = fakeRoot;

      try {
        await program.methods
          .withdraw(argsWithFakeRoot)
          .accountsPartial({
            pool: poolPda,
            vault: vaultPda,
            nullifierPda: nullifierPda2,
            recipient: recipient2.publicKey,
            treasury: treasury.publicKey,
            relayer: relayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([relayer])
          .rpc();
        assert.fail("Should have rejected stale/fake root");
      } catch (err: any) {
        assert.include(
          err.message,
          "RootNotFound",
          `Expected RootNotFound, got: ${err.message}`
        );
      }
    });
  });

  // ── Fee ceiling ──────────────────────────────────────────────────────────────
  describe("withdraw — fee ceiling", () => {
    it("rejects relayer_fee_taken > relayer_fee_max", async function () {
      this.timeout(120_000);

      // Generate a fresh note
      const noteFee = generateNote(DENOMINATION);

      // Deposit on-chain
      await program.methods
        .deposit(Array.from(bigIntToBytes32(noteFee.commitment)))
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          depositor: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Update JS tree
      const { pathElements, pathIndices, root } = jsTree.insert(noteFee.commitment);

      // Generate in-field recipient
      let recipientFee: Keypair;
      let recipientFeeBigInt: bigint;
      recipientFee = Keypair.generate();
      recipientFeeBigInt = pubkeyToField(recipientFee.publicKey);

      const withdrawalCommitmentFee = poseidonHash(
        pubkeyToField(relayer.publicKey),
        RELAYER_FEE_MAX,
        recipientFeeBigInt
      );

      console.log("\n  [withdraw.ts] Generating ZK proof for fee ceiling test...");
      const circomInputsFee = {
        nullifierHash: noteFee.nullifierHash.toString(),
        root: root.toString(),
        withdrawalCommitment: withdrawalCommitmentFee.toString(),
        nullifier: noteFee.nullifier.toString(),
        secret: noteFee.secret.toString(),
        denomination: DENOMINATION.toString(),
        pathElements: pathElements.map((x) => x.toString()),
        pathIndices: pathIndices.map((x) => x.toString()),
        recipient: recipientFeeBigInt.toString(),
        relayerAddress: pubkeyToField(relayer.publicKey).toString(),
        relayerFeeMax: RELAYER_FEE_MAX.toString(),
      };

      const resultFee = await snarkjs.groth16.fullProve(
        circomInputsFee,
        WITHDRAW_WASM,
        WITHDRAW_ZKEY
      );
      console.log("  [withdraw.ts] Proof generated.");

      // Build args with relayer_fee_taken = relayer_fee_max + 1 (exceeds ceiling)
      const nullifierHashBytesFee = bigIntToBytes32(noteFee.nullifierHash);
      const [nullifierPdaFee, nullifierBumpFee] = PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier"), poolPda.toBytes(), nullifierHashBytesFee],
        program.programId
      );

      const badFeeArgs = buildWithdrawArgs(
        resultFee.proof,
        resultFee.publicSignals,
        nullifierBumpFee,
        RELAYER_FEE_MAX,
        RELAYER_FEE_MAX + 1n // exceeds max
      );

      try {
        await program.methods
          .withdraw(badFeeArgs)
          .accountsPartial({
            pool: poolPda,
            vault: vaultPda,
            nullifierPda: nullifierPdaFee,
            recipient: recipientFee.publicKey,
            treasury: treasury.publicKey,
            relayer: relayer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([relayer])
          .rpc();
        assert.fail("Should have rejected fee exceeding max");
      } catch (err: any) {
        assert.include(
          err.message,
          "RelayerFeeExceedsMax",
          `Expected RelayerFeeExceedsMax, got: ${err.message}`
        );
      }
    });
  });

  // ── CU profiling ──────────────────────────────────────────────────────────────
  describe("CU profiling — T22 withdraw", () => {
    it("measures CU for withdraw instruction", async () => {
      // Generate a new note for CU measurement (so the nullifier isn't spent)
      const noteForCU = generateNote(DENOMINATION);

      await program.methods
        .deposit(Array.from(bigIntToBytes32(noteForCU.commitment)))
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          depositor: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const { pathElements, pathIndices, root } = jsTree.insert(noteForCU.commitment);

      let recipientCU: Keypair;
      let recipientCUBigInt: bigint;
      recipientCU = Keypair.generate();
      recipientCUBigInt = pubkeyToField(recipientCU.publicKey);

      const wCommitmentCU = poseidonHash(
        pubkeyToField(relayer.publicKey),
        RELAYER_FEE_MAX,
        recipientCUBigInt
      );

      console.log("\n  [T22] Generating ZK proof for CU measurement...");
      const cuInputs = {
        nullifierHash: noteForCU.nullifierHash.toString(),
        root: root.toString(),
        withdrawalCommitment: wCommitmentCU.toString(),
        nullifier: noteForCU.nullifier.toString(),
        secret: noteForCU.secret.toString(),
        denomination: DENOMINATION.toString(),
        pathElements: pathElements.map((x) => x.toString()),
        pathIndices: pathIndices.map((x) => x.toString()),
        recipient: recipientCUBigInt.toString(),
        relayerAddress: pubkeyToField(relayer.publicKey).toString(),
        relayerFeeMax: RELAYER_FEE_MAX.toString(),
      };

      const cuResult = await snarkjs.groth16.fullProve(
        cuInputs,
        WITHDRAW_WASM,
        WITHDRAW_ZKEY
      );
      console.log("  [T22] Proof generated.");

      const nullifierHashBytesCU = bigIntToBytes32(noteForCU.nullifierHash);
      const [nullifierPdaCU, nullifierBumpCU] = PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier"), poolPda.toBytes(), nullifierHashBytesCU],
        program.programId
      );

      const withdrawArgsCU = buildWithdrawArgs(
        cuResult.proof,
        cuResult.publicSignals,
        nullifierBumpCU,
        RELAYER_FEE_MAX,
        RELAYER_FEE_ACTUAL
      );

      const ix = await program.methods
        .withdraw(withdrawArgsCU)
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          nullifierPda: nullifierPdaCU,
          recipient: recipientCU.publicKey,
          treasury: treasury.publicKey,
          relayer: relayer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([relayer])
        .instruction();

      const { cu, err, logs } = await measureCUFromIx(provider, ix);

      console.log(`  [T22] withdraw CU: ${cu.toLocaleString()}`);
      if (err) {
        console.log(`  (simulation error: ${JSON.stringify(err)})`);
        console.log(`  logs: ${logs.slice(-10).join("\n")}`);
      }
      assert.isAbove(cu, 0, "CU should be > 0");
    });
  });
});
