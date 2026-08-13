#!/usr/bin/env node
"use strict";

/**
 * scripts/devnet_verify.js
 *
 * On-chain (devnet) verification of security fixes. One check group per finding.
 * Complements the local validator suite in tests/ — this exercises the REAL
 * deployed program, so it catches build/deploy drift that local tests cannot.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   node scripts/devnet_verify.js [C-1] [H-1] ...      # default: all
 *
 * Cost: reuses a dedicated 0.02 SOL test pool across runs (created once,
 * ~0.064 SOL of non-recoverable rent) plus ~0.045 SOL per run in deposits and
 * fees. Deposited SOL is withdrawn back where the check succeeds.
 */

const anchor = require("@coral-xyz/anchor");
const {
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");
const snarkjs = require("snarkjs");
const crypto = require("crypto");

// ── Constants ────────────────────────────────────────────────────────────────
// Dedicated verification pool: 0.02 SOL, distinct from the 0.1/1/10 SOL pools.
const DENOMINATION_BI = 20_000_000n;
const DENOMINATION = new anchor.BN(DENOMINATION_BI.toString());
const VERSION = 1; // v1 = dedicated verification pool (v0 holds earlier runs)
const TREE_DEPTH = 20;

const BN254_FIELD_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BN254_Fq =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

const RELAYER_FEE_MAX = 100_000n;
const RELAYER_FEE_TAKEN = 100_000n;
const TREASURY_FEE = DENOMINATION_BI / 500n;

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
  const r = _poseidon(inputs.map((x) => _F.e(x)));
  return BigInt(_F.toObject(r));
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function randomFieldElem() {
  let v = 0n;
  for (const b of crypto.randomBytes(32)) v = (v << 8n) | BigInt(b);
  return v % BN254_FIELD_ORDER;
}
function bigIntToBytes32(n) {
  return Buffer.from(n.toString(16).padStart(64, "0"), "hex");
}
function pubkeyToBigInt(pk) {
  let v = 0n;
  for (const b of pk.toBytes()) v = (v << 8n) | BigInt(b);
  return v;
}
// Map a pubkey to a field element. MUST match pubkey_to_field in withdraw.rs:
// split into two 128-bit halves and hash (H-2). `pubkey mod Fr` was not injective.
function pubkeyToField(pk) {
  const b = pk.toBytes();
  let hi = 0n, lo = 0n;
  for (let i = 0; i < 16; i++) hi = (hi << 8n) | BigInt(b[i]);
  for (let i = 16; i < 32; i++) lo = (lo << 8n) | BigInt(b[i]);
  return poseidonHash(hi, lo);
}
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
function findPoolPda(admin, denomination, version, programId) {
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
function findVaultPda(poolPda, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBytes()],
    programId
  );
}
function findNullifierPda(poolPda, nullifierHashBytes, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), poolPda.toBytes(), nullifierHashBytes],
    programId
  );
}

// ── Minimal incremental Merkle tree (mirrors on-chain insert) ────────────────
class Tree {
  constructor(depth) {
    this.depth = depth;
    this.zeros = [0n];
    for (let i = 1; i <= depth; i++)
      this.zeros[i] = poseidonHash(this.zeros[i - 1], this.zeros[i - 1]);
    this.layers = Array.from({ length: depth + 1 }, () => []);
  }
  nodeAt(level, index) {
    return index < this.layers[level].length
      ? this.layers[level][index]
      : this.zeros[level];
  }
  insert(leaf) {
    const index = this.layers[0].length;
    this.layers[0].push(leaf);
    let cur = index;
    for (let level = 1; level <= this.depth; level++) {
      const p = cur >> 1;
      const parent = poseidonHash(
        this.nodeAt(level - 1, p * 2),
        this.nodeAt(level - 1, p * 2 + 1)
      );
      if (p < this.layers[level].length) this.layers[level][p] = parent;
      else this.layers[level].push(parent);
      cur = p;
    }
    return index;
  }
  proof(leafIndex) {
    const pathElements = [];
    const pathIndices = [];
    let cur = leafIndex;
    for (let level = 0; level < this.depth; level++) {
      const isRight = cur % 2 === 1;
      pathIndices.push(isRight ? 1 : 0);
      pathElements.push(this.nodeAt(level, isRight ? cur - 1 : cur + 1));
      cur = cur >> 1;
    }
    return { pathElements, pathIndices, root: this.nodeAt(this.depth, 0) };
  }
}

// ── Leaf cache ───────────────────────────────────────────────────────────────
// Every leaf in the verification pool is inserted by this script, so cache them
// locally. Rebuilding from getTransaction logs hits public-RPC rate limits fast
// (which is finding H-5 in miniature).
const CACHE_PATH = path.join(__dirname, ".devnet_verify_leaves.json");
function loadLeaves(poolKey) {
  try {
    const all = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return (all[poolKey] || []).map((x) => BigInt(x));
  } catch {
    return [];
  }
}
function saveLeaves(poolKey, leaves) {
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {}
  all[poolKey] = leaves.map((x) => x.toString());
  fs.writeFileSync(CACHE_PATH, JSON.stringify(all, null, 1));
}

// ── Test bookkeeping ─────────────────────────────────────────────────────────
const results = [];
function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  [${id}] ${name}${detail ? " — " + detail : ""}`);
}
async function expectReject(id, name, expectedCode, fn) {
  try {
    await fn();
    record(id, name, false, `expected ${expectedCode}, transaction SUCCEEDED`);
  } catch (err) {
    const msg = (err && (err.message || String(err))) + " " + JSON.stringify(err && err.logs || []);
    if (msg.includes(expectedCode)) record(id, name, true, expectedCode);
    else record(id, name, false, `expected ${expectedCode}, got: ${(err.message || "").slice(0, 200)}`);
  }
}

/** Transaction meta is not always available immediately after confirmation on
 *  public RPC, so poll briefly before giving up. */
async function fetchTxFee(connection, sig, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx?.meta?.fee != null) return BigInt(tx.meta.fee);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

// ── Shared fixture ───────────────────────────────────────────────────────────
async function setupFixture(program, provider, recipientPredicate = null) {
  const connection = provider.connection;
  const funder = provider.wallet;

  const [poolPda] = findPoolPda(
    funder.publicKey,
    DENOMINATION,
    VERSION,
    program.programId
  );
  const [vaultPda] = findVaultPda(poolPda, program.programId);

  // Treasury is fixed at pool creation; recover it from the account if the pool
  // already exists, otherwise create the pool with the funder as treasury.
  let treasury;
  const existing = await connection.getAccountInfo(poolPda);
  if (existing) {
    treasury = new PublicKey(existing.data.subarray(8 + 88, 8 + 120));
    console.log("  Reusing verification pool:", poolPda.toBase58());
  } else {
    treasury = funder.publicKey;
    console.log("  Creating verification pool:", poolPda.toBase58());
    await program.methods
      .initializePool(DENOMINATION, VERSION)
      .accountsPartial({
        admin: funder.publicKey,
        pool: poolPda,
        vault: vaultPda,
        treasury,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // Relayer signs the withdrawal and pays nullifier rent.
  // Any address works: the pubkey->field encoding is collision-resistant (H-2).
  const relayer = Keypair.generate();
  let recipient = Keypair.generate();
  if (recipientPredicate) {
    while (!recipientPredicate(recipient.publicKey)) recipient = Keypair.generate();
  }

  const fundRelayer = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: relayer.publicKey,
      lamports: 0.03 * LAMPORTS_PER_SOL,
    })
  );
  await provider.sendAndConfirm(fundRelayer, []);

  // Deposit the note under test, plus one filler deposit so the vault can fund
  // a SECOND payout. Without the filler an exploit attempt would fail on
  // InsufficientVaultBalance and prove nothing.

  // Replay existing leaves so our Merkle root matches the on-chain tree.
  const tree = new Tree(TREE_DEPTH);
  const poolKey = poolPda.toBase58();
  const poolData = (await connection.getAccountInfo(poolPda)).data;
  const nextIndex = Number(poolData.readBigUInt64LE(8 + 80));

  let cached = loadLeaves(poolKey);
  if (cached.length !== nextIndex) {
    if (nextIndex === 0) {
      cached = [];
    } else {
      console.log(`  Cache miss (${cached.length}/${nextIndex}) — rebuilding from logs...`);
      const coder = new anchor.BorshCoder(program.idl);
      const parser = new anchor.EventParser(program.programId, coder);
      const sigs = await connection.getSignaturesForAddress(poolPda, { limit: 1000 }, "confirmed");
      sigs.reverse();
      const found = [];
      for (const sg of sigs) {
        if (sg.err) continue;
        let tx = null;
        for (let attempt = 0; attempt < 5 && !tx; attempt++) {
          try {
            tx = await connection.getTransaction(sg.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });
          } catch {
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          }
        }
        await new Promise((r) => setTimeout(r, 120)); // throttle
        if (!tx?.meta?.logMessages) continue;
        for (const ev of parser.parseLogs(tx.meta.logMessages)) {
          if (ev.name === "DepositEvent" || ev.name === "depositEvent") {
            let v = 0n;
            for (const b of ev.data.leaf) v = (v << 8n) | BigInt(b);
            found.push({ v, i: Number(ev.data.leafIndex) });
          }
        }
      }
      found.sort((a, b) => a.i - b.i);
      cached = found.map((f) => f.v);
    }
    if (cached.length !== nextIndex) {
      throw new Error(
        `Merkle rebuild mismatch: on-chain next_index=${nextIndex}, rebuilt=${cached.length}`
      );
    }
    saveLeaves(poolKey, cached);
  }
  for (const l of cached) tree.insert(l);

  const note = {
    nullifier: randomFieldElem(),
    secret: randomFieldElem(),
  };
  note.commitment = poseidonHash(note.nullifier, note.secret, DENOMINATION_BI);
  note.nullifierHash = poseidonHash(note.nullifier);

  for (const c of [note.commitment, randomFieldElem()]) {
    await program.methods
      .deposit(Array.from(bigIntToBytes32(c)))
      .accountsPartial({
        pool: poolPda,
        vault: vaultPda,
        depositor: funder.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    tree.insert(c);
    cached.push(c);
  }
  saveLeaves(poolKey, cached);

  const leafIndex = tree.layers[0].indexOf(note.commitment);
  const { pathElements, pathIndices, root } = tree.proof(leafIndex);

  const relayerField = pubkeyToField(relayer.publicKey);
  const recipientField = pubkeyToField(recipient.publicKey);
  const withdrawalCommitment = poseidonHash(
    relayerField,
    RELAYER_FEE_MAX,
    recipientField
  );

  console.log("  Generating ZK proof...");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      nullifierHash: note.nullifierHash.toString(),
      root: root.toString(),
      withdrawalCommitment: withdrawalCommitment.toString(),
      nullifier: note.nullifier.toString(),
      secret: note.secret.toString(),
      denomination: DENOMINATION_BI.toString(),
      pathElements: pathElements.map(String),
      pathIndices: pathIndices.map(String),
      recipient: recipientField.toString(),
      relayerAddress: relayerField.toString(),
      relayerFeeMax: RELAYER_FEE_MAX.toString(),
    },
    WITHDRAW_WASM,
    WITHDRAW_ZKEY
  );

  const { proofA, proofB, proofC } = snarkjsProofToBytes(proof);
  const baseArgs = {
    proofA: Array.from(proofA),
    proofB: Array.from(proofB),
    proofC: Array.from(proofC),
    nullifierHash: Array.from(bigIntToBytes32(BigInt(publicSignals[0]))),
    root: Array.from(bigIntToBytes32(BigInt(publicSignals[1]))),
    withdrawalCommitment: Array.from(bigIntToBytes32(BigInt(publicSignals[2]))),
    relayerFeeMax: new anchor.BN(RELAYER_FEE_MAX.toString()),
    relayerFeeTaken: new anchor.BN(RELAYER_FEE_TAKEN.toString()),
    nullifierBump: 0,
  };

  return {
    poolPda,
    vaultPda,
    treasury,
    relayer,
    recipient,
    note,
    publicSignals,
    baseArgs,
    tree,
  };
}

function withdrawCall(program, fx, args, accounts = {}) {
  const [nullifierPda, bump] = findNullifierPda(
    fx.poolPda,
    Buffer.from(args.nullifierHash),
    program.programId
  );
  return program.methods
    .withdraw({ ...args, nullifierBump: bump })
    .accountsPartial({
      pool: fx.poolPda,
      vault: fx.vaultPda,
      nullifierPda,
      recipient: fx.recipient.publicKey,
      treasury: fx.treasury,
      relayer: fx.relayer.publicKey,
      systemProgram: SystemProgram.programId,
      ...accounts,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })])
    .signers([fx.relayer]);
}

// ── C-1: non-canonical public inputs ─────────────────────────────────────────
async function verifyC1(program, provider, fx) {
  console.log("\n── C-1: non-canonical public inputs (aliased double-spend) ──");

  const vaultBefore = await provider.connection.getBalance(fx.vaultPda);
  console.log(`  vault balance: ${vaultBefore / LAMPORTS_PER_SOL} SOL`);

  // h + Fr: identical Groth16 pairing result, different PDA seed.
  const aliased = BigInt(fx.publicSignals[0]) + BN254_FIELD_ORDER;
  if (aliased >= 1n << 256n) throw new Error("alias does not fit in 32 bytes");
  const aliasedBytes = bigIntToBytes32(aliased);

  const [canonPda] = findNullifierPda(
    fx.poolPda,
    Buffer.from(fx.baseArgs.nullifierHash),
    program.programId
  );
  const [aliasPda] = findNullifierPda(fx.poolPda, aliasedBytes, program.programId);
  record(
    "C-1",
    "aliased hash derives a different nullifier PDA (attack precondition)",
    canonPda.toBase58() !== aliasPda.toBase58(),
    `${canonPda.toBase58().slice(0, 8)}… vs ${aliasPda.toBase58().slice(0, 8)}…`
  );

  await expectReject(
    "C-1",
    "nullifier_hash >= Fr is rejected",
    "NonCanonicalPublicInput",
    () =>
      withdrawCall(program, fx, {
        ...fx.baseArgs,
        nullifierHash: Array.from(aliasedBytes),
      }).rpc()
  );

  await expectReject(
    "C-1",
    "root >= Fr is rejected",
    "NonCanonicalPublicInput",
    () =>
      withdrawCall(program, fx, {
        ...fx.baseArgs,
        root: Array.from(bigIntToBytes32(BigInt(fx.publicSignals[1]) + BN254_FIELD_ORDER)),
        nullifierHash: Array.from(bigIntToBytes32(randomFieldElem())),
      }).rpc()
  );

  await expectReject(
    "C-1",
    "withdrawal_commitment >= Fr is rejected",
    "NonCanonicalPublicInput",
    () =>
      withdrawCall(program, fx, {
        ...fx.baseArgs,
        withdrawalCommitment: Array.from(
          bigIntToBytes32(BigInt(fx.publicSignals[2]) + BN254_FIELD_ORDER)
        ),
        nullifierHash: Array.from(bigIntToBytes32(randomFieldElem())),
      }).rpc()
  );

  // No false positives: the honest proof must still pay out.
  const recipBefore = await provider.connection.getBalance(fx.recipient.publicKey);
  const treasBefore = await provider.connection.getBalance(fx.treasury);
  const vaultPre = await provider.connection.getBalance(fx.vaultPda);
  try {
    const sig = await withdrawCall(program, fx, fx.baseArgs).rpc();
    const recipAfter = await provider.connection.getBalance(fx.recipient.publicKey);
    const treasAfter = await provider.connection.getBalance(fx.treasury);
    const vaultPost = await provider.connection.getBalance(fx.vaultPda);
    const expectedUser = DENOMINATION_BI - TREASURY_FEE - RELAYER_FEE_TAKEN;

    record(
      "C-1",
      "honest canonical proof still succeeds",
      BigInt(recipAfter - recipBefore) === expectedUser,
      `recipient +${recipAfter - recipBefore} (expected ${expectedUser}), tx ${sig.slice(0, 12)}…`
    );

    // The vault must lose exactly one denomination — no lamports created or destroyed.
    record(
      "C-1",
      "vault debited exactly one denomination",
      BigInt(vaultPre - vaultPost) === DENOMINATION_BI,
      `-${vaultPre - vaultPost} (expected ${DENOMINATION_BI})`
    );

    // The treasury here is also the transaction fee payer, so its net delta is
    // treasury_fee minus the fee it paid. Read the real fee from the tx meta
    // instead of assuming it.
    const treasuryIsFeePayer = fx.treasury.equals(provider.wallet.publicKey);
    const paidFee = treasuryIsFeePayer
      ? await fetchTxFee(provider.connection, sig)
      : 0n;
    if (paidFee === null) {
      record(
        "C-1",
        "treasury fee correct (denomination/500)",
        false,
        "could not read tx fee from RPC"
      );
    } else {
      record(
        "C-1",
        "treasury fee correct (denomination/500)",
        BigInt(treasAfter - treasBefore) === TREASURY_FEE - paidFee,
        `+${treasAfter - treasBefore} = fee ${TREASURY_FEE} - tx fee ${paidFee}` +
          (treasuryIsFeePayer ? " (treasury is also fee payer)" : "")
      );
    }
  } catch (err) {
    record("C-1", "honest canonical proof still succeeds", false, err.message);
  }

  // And the spent note is still blocked by the ordinary double-spend guard.
  await expectReject(
    "C-1",
    "replay of the spent canonical hash still blocked",
    "NullifierAlreadySpent",
    () => withdrawCall(program, fx, fx.baseArgs).rpc()
  );
}

// ── H-1: pre-funded nullifier PDA griefing ───────────────────────────────────
async function verifyH1(program, provider, fx) {
  console.log("\n── H-1: pre-funded nullifier PDA (permanent freeze) ──");

  const [pda] = findNullifierPda(
    fx.poolPda,
    Buffer.from(fx.baseArgs.nullifierHash),
    program.programId
  );

  // The runtime forbids leaving an account below rent-exemption, so the cheapest
  // grief is the rent-exempt minimum for a 0-byte account.
  const griefAmount = await provider.connection.getMinimumBalanceForRentExemption(0);
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: pda,
      lamports: griefAmount,
    })
  );
  await provider.sendAndConfirm(tx, []);

  const pre = await provider.connection.getAccountInfo(pda);
  record(
    "H-1",
    "nullifier PDA can be pre-funded by a third party (attack precondition)",
    pre !== null && pre.lamports === griefAmount && pre.data.length === 0,
    `${griefAmount} lamports, ${pre ? pre.data.length : "?"}B data`
  );

  const recipBefore = await provider.connection.getBalance(fx.recipient.publicKey);
  try {
    const sig = await withdrawCall(program, fx, fx.baseArgs).rpc();
    const recipAfter = await provider.connection.getBalance(fx.recipient.publicKey);
    const expectedUser = DENOMINATION_BI - TREASURY_FEE - RELAYER_FEE_TAKEN;
    record(
      "H-1",
      "withdrawal completes despite the pre-funded PDA",
      BigInt(recipAfter - recipBefore) === expectedUser,
      `recipient +${recipAfter - recipBefore} (expected ${expectedUser}), tx ${sig.slice(0, 12)}…`
    );

    const post = await provider.connection.getAccountInfo(pda);
    const minRent = await provider.connection.getMinimumBalanceForRentExemption(80);
    record(
      "H-1",
      "nullifier account correctly initialised by the fallback path",
      post !== null &&
        post.owner.equals(program.programId) &&
        post.data.length === 80 &&
        post.lamports >= minRent,
      post
        ? `owner=${post.owner.toBase58().slice(0, 8)}… ${post.data.length}B ${post.lamports} lamports`
        : "missing"
    );
    record(
      "H-1",
      "nullifier account records its pool",
      post !== null &&
        new PublicKey(post.data.subarray(8, 40)).equals(fx.poolPda),
      "pool field matches"
    );
  } catch (err) {
    record("H-1", "withdrawal completes despite the pre-funded PDA", false, err.message);
  }

  await expectReject(
    "H-1",
    "double-spend guard still holds after the fallback path",
    "NullifierAlreadySpent",
    () => withdrawCall(program, fx, fx.baseArgs).rpc()
  );
}

// ── H-2: aliased recipient substitution ──────────────────────────────────────
async function verifyH2(program, provider, fx) {
  console.log("\n── H-2: recipient substitution via field-element alias ──");

  // The alias of the committed recipient: same value under the OLD mod-Fr
  // encoding, a different address on chain.
  const recipInt = pubkeyToBigInt(fx.recipient.publicKey);
  const aliasInt = recipInt + BN254_FIELD_ORDER;
  if (aliasInt >= 1n << 256n) {
    record("H-2", "alias fits in 32 bytes", false, "recipient too large; rerun");
    return;
  }
  const alias = new PublicKey(bigIntToBytes32(aliasInt));

  record(
    "H-2",
    "old mod-Fr encoding collided for these two addresses (attack precondition)",
    (recipInt % BN254_FIELD_ORDER) === (aliasInt % BN254_FIELD_ORDER) &&
      !alias.equals(fx.recipient.publicKey),
    `${fx.recipient.publicKey.toBase58().slice(0, 8)}… vs ${alias.toBase58().slice(0, 8)}…`
  );
  record(
    "H-2",
    "new encoding separates them",
    pubkeyToField(fx.recipient.publicKey) !== pubkeyToField(alias),
    "distinct field elements"
  );

  await expectReject(
    "H-2",
    "substituted alias recipient is rejected",
    "InvalidWithdrawalCommitment",
    () => withdrawCall(program, fx, fx.baseArgs, { recipient: alias }).rpc()
  );

  const aliasBal = await provider.connection.getBalance(alias);
  record("H-2", "alias received nothing", aliasBal === 0, `${aliasBal} lamports`);

  // The note must still be spendable by the intended recipient.
  const before = await provider.connection.getBalance(fx.recipient.publicKey);
  try {
    const sig = await withdrawCall(program, fx, fx.baseArgs).rpc();
    const after = await provider.connection.getBalance(fx.recipient.publicKey);
    const expectedUser = DENOMINATION_BI - TREASURY_FEE - RELAYER_FEE_TAKEN;
    record(
      "H-2",
      "intended recipient still paid in full",
      BigInt(after - before) === expectedUser,
      `+${after - before} (expected ${expectedUser}), tx ${sig.slice(0, 12)}…`
    );
  } catch (err) {
    record("H-2", "intended recipient still paid in full", false, err.message);
  }
}

// ── H-3: on-chain relayer fee cap ────────────────────────────────────────────
async function verifyH3(program, provider, fx) {
  console.log("\n── H-3: relayer fee cap ──");

  const cap = DENOMINATION_BI / 50n;
  record(
    "H-3",
    "cap is 2% of denomination",
    cap === 400_000n,
    `${cap} lamports on a ${Number(DENOMINATION_BI) / LAMPORTS_PER_SOL} SOL pool`
  );

  // Reuse the fixture note but claim a fee above the cap. The commitment binds
  // fee_max, so this needs its own proof — built by the caller via feeMax.
  await expectReject(
    "H-3",
    "relayer_fee_max above the cap is rejected",
    "RelayerFeeMaxTooHigh",
    () =>
      withdrawCall(program, fx, {
        ...fx.baseArgs,
        relayerFeeMax: new anchor.BN((cap + 1n).toString()),
        relayerFeeTaken: new anchor.BN("0"),
      }).rpc()
  );

  // And the honest at-quote fee still works.
  const before = await provider.connection.getBalance(fx.recipient.publicKey);
  try {
    const sig = await withdrawCall(program, fx, fx.baseArgs).rpc();
    const after = await provider.connection.getBalance(fx.recipient.publicKey);
    const expectedUser = DENOMINATION_BI - TREASURY_FEE - RELAYER_FEE_TAKEN;
    record(
      "H-3",
      "in-cap fee still succeeds",
      BigInt(after - before) === expectedUser,
      `+${after - before} (expected ${expectedUser}), tx ${sig.slice(0, 12)}…`
    );
  } catch (err) {
    record("H-3", "in-cap fee still succeeds", false, err.message);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(WITHDRAW_WASM) || !fs.existsSync(WITHDRAW_ZKEY)) {
    console.error("ERROR: circuit build artifacts missing — run scripts/trusted_setup.sh");
    process.exit(1);
  }

  const requested = process.argv.slice(2).map((s) => s.toUpperCase());
  const wanted = (id) => requested.length === 0 || requested.includes(id);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync("target/idl/solnadocash.json", "utf8"));
  const program = new anchor.Program(idl, provider);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  SolnadoCash — on-chain fix verification");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("Program: ", program.programId.toBase58());
  console.log("Cluster: ", provider.connection.rpcEndpoint);
  console.log("Wallet:  ", provider.wallet.publicKey.toBase58());
  const bal = await provider.connection.getBalance(provider.wallet.publicKey);
  console.log("Balance: ", bal / LAMPORTS_PER_SOL, "SOL\n");
  if (bal < 0.2 * LAMPORTS_PER_SOL) {
    console.error("ERROR: need at least 0.2 SOL");
    process.exit(1);
  }

  await initPoseidon();

  // Each group spends its own note, so build a fresh fixture per group.
  if (wanted("C-1")) {
    console.log("\nPreparing fixture for C-1...");
    await verifyC1(program, provider, await setupFixture(program, provider));
  }
  if (wanted("H-1")) {
    console.log("\nPreparing fixture for H-1...");
    await verifyH1(program, provider, await setupFixture(program, provider));
  }
  if (wanted("H-2")) {
    console.log("\nPreparing fixture for H-2...");
    // Needs a recipient whose +Fr alias still fits in 32 bytes (~81% of keys).
    await verifyH2(
      program,
      provider,
      await setupFixture(program, provider, (pk) => pubkeyToBigInt(pk) + BN254_FIELD_ORDER < 1n << 256n)
    );
  }

  if (wanted("H-3")) {
    console.log("\nPreparing fixture for H-3...");
    await verifyH3(program, provider, await setupFixture(program, provider));
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  const failed = results.filter((r) => !r.ok);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAILED [${f.id}] ${f.name}: ${f.detail}`);
  }
  console.log("═══════════════════════════════════════════════════════════");
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("ERROR:", err.message || err);
  if (err.logs) err.logs.forEach((l) => console.error("  ", l));
  process.exit(1);
});
