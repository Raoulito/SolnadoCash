// tests/sequence_fuzz.ts
//
// Randomised INSTRUCTION SEQUENCE fuzzing with invariant checks after every step.
//
// Why this exists instead of Trident
// ─────────────────────────────────
// Trident 0.12 was the intended tool and cannot run this program. trident-svm executes
// SBF through trident-syscall-stubs-v2, which implements sol_log, the sysvar getters and
// sol_invoke_signed — but NOT sol_poseidon or sol_alt_bn128_group_op. Every instruction
// here calls Poseidon (initialize_pool computes the empty root, deposit hashes 20 levels,
// withdraw verifies a Groth16 proof), so the program aborted on the first hash:
// initialize_pool panicked on 496/496 iterations before any flow could run. Enabling
// trident-fuzz's `syscalls` feature pulls in the stub crate but does not add the missing
// syscalls.
//
// These sequences therefore run against solana-test-validator, where the syscalls exist.
// That is more faithful than an emulated SVM, and it lets the fuzzer drive REAL proofs —
// something Trident could never do, since it cannot forge a valid Groth16 proof.
//
// What this covers that nothing else does: every other on-chain test is single-shot
// (set up, one operation, assert). This interleaves deposit / withdraw / replay / garbage
// withdraw / pause / unpause in a seeded random order and re-checks global invariants
// after EVERY step.
//
//   I1 vault lamports == rent + (deposits - withdrawals) * denomination  (no funds leak)
//   I2 next_index == accepted deposits, and never decreases
//   I3 one nullifier account exists per successful withdrawal
//   I4 admin / denomination / treasury / bumps never change after init
//   I5 a garbage withdrawal never succeeds
//   I6 deposits succeed iff the pool is unpaused
//   I7 a valid withdrawal succeeds even while paused (users can always exit)
//   I8 replaying a spent note always fails
//
// Reproduce a failure with:  SEQ_FUZZ_SEED=<seed> anchor test --skip-build

import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, setProvider, workspace, BN } = anchorPkg as any;

import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { assert } from "chai";
import * as path from "path";
import { fileURLToPath } from "url";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import type { Solnadocash } from "../target/types/solnadocash";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUILD_DIR = path.join(__dirname, "../circuits/build");
const WITHDRAW_WASM = path.join(BUILD_DIR, "withdraw_js/withdraw.wasm");
const WITHDRAW_ZKEY = path.join(BUILD_DIR, "withdraw_final.zkey");

const DENOMINATION = 1_000_000_000n;
const TREE_DEPTH = 20;
const Fr =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const Fq =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const RELAYER_FEE = 83_000n;
const TREASURY_FEE = DENOMINATION / 500n;

const OFF_ADMIN = 8;
const OFF_DENOM = 8 + 64;
const OFF_NEXT_INDEX = 8 + 80;
const OFF_TREASURY = 8 + 88;
const OFF_BUMP = 8 + 121;
const OFF_VAULT_BUMP = 8 + 122;
const OFF_IS_PAUSED = 8 + 123;

/**
 * Fail loudly instead of hanging.
 *
 * Seed 8675309 stalled for ~28 minutes on an earlier run and was killed without a
 * diagnosis. "It hung" is not a finding, so every operation is now wrapped: if one does
 * not settle within OP_TIMEOUT_MS the test rejects naming the operation, which turns an
 * indefinite stall into a located failure. Note a Solana program cannot itself loop
 * forever — the compute budget terminates it — so any stall is in the harness or the RPC
 * round-trip.
 */
const OP_TIMEOUT_MS = Number(process.env.SEQ_FUZZ_OP_TIMEOUT || 60_000);
async function withTimeout<T>(label: string, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`OPERATION STALLED (>${OP_TIMEOUT_MS}ms): ${label}`)),
      OP_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Seeded xorshift32 so any failure is reproducible from its seed. */
function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 0x100000000;
  };
}

let _poseidon: any, _F: any;
function ph(...xs: bigint[]): bigint {
  return BigInt(_F.toObject(_poseidon(xs.map((x) => _F.e(x)))));
}
function toBytes32(n: bigint): Buffer {
  return Buffer.from(n.toString(16).padStart(64, "0"), "hex");
}
function pkToField(pk: PublicKey): bigint {
  const b = pk.toBytes();
  let hi = 0n, lo = 0n;
  for (let i = 0; i < 16; i++) hi = (hi << 8n) | BigInt(b[i]);
  for (let i = 16; i < 32; i++) lo = (lo << 8n) | BigInt(b[i]);
  return ph(hi, lo);
}

class Tree {
  layers: bigint[][];
  zeros: bigint[] = [];
  depth: number;
  constructor(depth = TREE_DEPTH) {
    this.depth = depth;
    this.zeros[0] = 0n;
    for (let i = 1; i <= depth; i++) this.zeros[i] = ph(this.zeros[i - 1], this.zeros[i - 1]);
    this.layers = Array.from({ length: depth + 1 }, () => []);
  }
  at(l: number, i: number) {
    return i < this.layers[l].length ? this.layers[l][i] : this.zeros[l];
  }
  insert(leaf: bigint) {
    const idx = this.layers[0].length;
    this.layers[0].push(leaf);
    let cur = idx;
    for (let l = 1; l <= this.depth; l++) {
      const p = cur >> 1;
      const v = ph(this.at(l - 1, p * 2), this.at(l - 1, p * 2 + 1));
      if (p < this.layers[l].length) this.layers[l][p] = v;
      else this.layers[l].push(v);
      cur = p;
    }
    return idx;
  }
  proof(i: number) {
    const els: bigint[] = [], idxs: number[] = [];
    let cur = i;
    for (let l = 0; l < this.depth; l++) {
      const right = cur % 2 === 1;
      idxs.push(right ? 1 : 0);
      els.push(this.at(l, right ? cur - 1 : cur + 1));
      cur >>= 1;
    }
    return { els, idxs, root: this.at(this.depth, 0) };
  }
}

function proofToBytes(p: any) {
  const g = toBytes32;
  return {
    a: Buffer.concat([g(BigInt(p.pi_a[0])), g(Fq - BigInt(p.pi_a[1]))]),
    b: Buffer.concat([
      g(BigInt(p.pi_b[0][1])), g(BigInt(p.pi_b[0][0])),
      g(BigInt(p.pi_b[1][1])), g(BigInt(p.pi_b[1][0])),
    ]),
    c: Buffer.concat([g(BigInt(p.pi_c[0])), g(BigInt(p.pi_c[1]))]),
  };
}

describe("Sequence fuzzing (random operation orders, invariant-checked)", function () {
  this.timeout(1_800_000);

  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.Solnadocash as import("@coral-xyz/anchor").Program<Solnadocash>;

  const SEED = Number(process.env.SEQ_FUZZ_SEED || 20260814);
  const STEPS = Number(process.env.SEQ_FUZZ_STEPS || 30);
  const rng = makeRng(SEED);

  let admin: Keypair, treasury: Keypair, relayer: Keypair;
  let poolPda: PublicKey, vaultPda: PublicKey;
  let tree: Tree;
  let vaultRent = 0n;
  let immutableSnapshot: string | null = null;

  let deposits = 0n, withdrawals = 0n, lastNextIndex = 0n;
  let paused = false;
  const liveNotes: { n: bigint; s: bigint; leaf: number }[] = [];
  const spentNotes: { n: bigint; s: bigint; leaf: number }[] = [];
  const opCounts: Record<string, number> = {};

  const randField = () => {
    let v = 0n;
    for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(Math.floor(rng() * 256));
    return v % Fr;
  };

  async function poolData(): Promise<Buffer> {
    const a = await provider.connection.getAccountInfo(poolPda);
    assert.ok(a, "pool account vanished");
    return a!.data;
  }

  async function checkInvariants(ctx: string) {
    const d = await poolData();
    const nextIndex = d.readBigUInt64LE(OFF_NEXT_INDEX);
    const denom = d.readBigUInt64LE(OFF_DENOM);
    const vault = BigInt(await provider.connection.getBalance(vaultPda));

    const expected = vaultRent + (deposits - withdrawals) * denom;
    assert.equal(
      vault.toString(), expected.toString(),
      `[${ctx}] I1: vault ${vault} != rent + (${deposits}-${withdrawals})*${denom} = ${expected}`
    );
    assert.isTrue(nextIndex >= lastNextIndex, `[${ctx}] I2: next_index went backwards`);
    assert.equal(nextIndex.toString(), deposits.toString(), `[${ctx}] I2: next_index != deposits`);
    lastNextIndex = nextIndex;

    const snap = Buffer.concat([
      d.subarray(OFF_ADMIN, OFF_ADMIN + 32),
      d.subarray(OFF_DENOM, OFF_DENOM + 8),
      d.subarray(OFF_TREASURY, OFF_TREASURY + 32),
      Buffer.from([d[OFF_BUMP], d[OFF_VAULT_BUMP]]),
    ]).toString("hex");
    if (immutableSnapshot === null) immutableSnapshot = snap;
    else assert.equal(snap, immutableSnapshot, `[${ctx}] I4: an immutable pool field changed`);

    assert.equal(d[OFF_IS_PAUSED] === 1, paused, `[${ctx}] is_paused disagrees with the model`);
  }

  function nullifierPda(nullifierHash: bigint): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier"), poolPda.toBytes(), toBytes32(nullifierHash)],
      program.programId
    )[0];
  }

  async function buildProof(note: { n: bigint; s: bigint; leaf: number }, recipient: PublicKey) {
    const { els, idxs, root } = tree.proof(note.leaf);
    const wc = ph(pkToField(relayer.publicKey), RELAYER_FEE, pkToField(recipient));
    const res = await withTimeout("snarkjs.groth16.fullProve", snarkjs.groth16.fullProve(
      {
        nullifierHash: ph(note.n).toString(),
        root: root.toString(),
        withdrawalCommitment: wc.toString(),
        nullifier: note.n.toString(),
        secret: note.s.toString(),
        denomination: DENOMINATION.toString(),
        pathElements: els.map(String),
        pathIndices: idxs.map(String),
        recipient: pkToField(recipient).toString(),
        relayerAddress: pkToField(relayer.publicKey).toString(),
        relayerFeeMax: RELAYER_FEE.toString(),
      },
      WITHDRAW_WASM,
      WITHDRAW_ZKEY
    ));
    const pb = proofToBytes(res.proof);
    return {
      proofA: Array.from(pb.a),
      proofB: Array.from(pb.b),
      proofC: Array.from(pb.c),
      nullifierHash: Array.from(toBytes32(BigInt(res.publicSignals[0]))),
      root: Array.from(toBytes32(BigInt(res.publicSignals[1]))),
      withdrawalCommitment: Array.from(toBytes32(BigInt(res.publicSignals[2]))),
      relayerFeeMax: new BN(RELAYER_FEE.toString()),
      relayerFeeTaken: new BN(RELAYER_FEE.toString()),
    };
  }

  before(async () => {
    _poseidon = await buildPoseidon();
    _F = _poseidon.F;

    admin = Keypair.generate();
    treasury = Keypair.generate();
    relayer = Keypair.generate();
    for (const [kp, sol] of [[admin, 200], [relayer, 20]] as [Keypair, number][]) {
      const sig = await withTimeout(
        `requestAirdrop(${sol} SOL)`,
        provider.connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL)
      );
      await withTimeout(`confirmTransaction(airdrop ${sol} SOL)`,
        provider.connection.confirmTransaction(sig));
    }

    const denomBN = new BN(DENOMINATION.toString());
    [poolPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pool"),
        admin.publicKey.toBytes(),
        new PublicKey(Buffer.alloc(32, 0)).toBytes(),
        denomBN.toArrayLike(Buffer, "le", 8),
        Buffer.from([0]),
      ],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBytes()],
      program.programId
    );

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

    vaultRent = BigInt(await provider.connection.getBalance(vaultPda));
    tree = new Tree();
    console.log(
      `\n  [seq-fuzz] seed=${SEED} steps=${STEPS} — reproduce with SEQ_FUZZ_SEED=${SEED}`
    );
    await checkInvariants("init");
  });


  // snarkjs/ffjavascript caches a bn128 curve with a WORKER THREAD POOL in
  // globalThis.curve_bn128 and never tears it down. Those workers keep the Node event
  // loop alive, so mocha finishes the run and then hangs forever at exit. That is what
  // the "28-minute hang" on seed 8675309 actually was: the test had already PASSED in
  // 23 seconds and the process simply refused to exit. Terminating the pool fixes it.
  after(async () => {
    const g = globalThis as unknown as { curve_bn128?: { terminate?: () => Promise<void> } };
    if (g.curve_bn128?.terminate) {
      await g.curve_bn128.terminate();
    }
  });

  it("holds every invariant across a random operation sequence", async () => {
    for (let step = 0; step < STEPS; step++) {
      // Weights matter. A first pass used pause=12%/unpause=10% and the pool spent most
      // of the run paused: 14 deposit attempts produced only 3 deposits and 1 withdrawal,
      // so the value-moving paths were barely exercised. Pausing is now rare, and when
      // paused the sequence strongly prefers unpausing so the run keeps making progress.
      const r = rng();
      let op: string;
      if (paused) {
        // While paused, mostly unpause — but still probe that deposits are refused and
        // that withdrawals succeed anyway (I6/I7).
        if (r < 0.55) op = "unpause";
        else if (r < 0.75) op = "withdraw";
        else if (r < 0.9) op = "deposit";
        else op = "withdraw_garbage";
      } else if (r < 0.42) op = "deposit";
      else if (r < 0.66) op = "withdraw";
      else if (r < 0.78) op = "withdraw_garbage";
      else if (r < 0.9) op = "replay";
      else op = "pause";

      opCounts[op] = (opCounts[op] || 0) + 1;
      if (process.env.SEQ_FUZZ_TRACE) {
        process.stdout.write(`    step ${step}: ${op} (live=${liveNotes.length} spent=${spentNotes.length} paused=${paused})\n`);
      }
      const stepStarted = Date.now();

      if (op === "deposit") {
        const real = rng() < 0.6;
        const n = randField(), s = randField();
        const leafValue = real ? ph(n, s, DENOMINATION) : randField();
        let ok = true;
        try {
          await program.methods
            .deposit(Array.from(toBytes32(leafValue)))
            .accountsPartial({
              pool: poolPda, vault: vaultPda,
              depositor: admin.publicKey, systemProgram: SystemProgram.programId,
            })
            .signers([admin])
            .rpc();
        } catch (e: any) {
          ok = false;
          assert.include(e.message, "PoolPaused", `deposit failed unexpectedly: ${e.message}`);
        }
        if (ok) {
          assert.isFalse(paused, "I6: deposit succeeded while paused");
          const idx = tree.insert(leafValue);
          deposits += 1n;
          if (real) liveNotes.push({ n, s, leaf: idx });
        } else {
          assert.isTrue(paused, "I6: deposit failed while unpaused");
        }
      } else if (op === "withdraw" && liveNotes.length > 0) {
        const note = liveNotes.splice(Math.floor(rng() * liveNotes.length), 1)[0];
        const recipient = Keypair.generate().publicKey;
        const args = await buildProof(note, recipient);
        const nPda = nullifierPda(ph(note.n));
        const before = BigInt(await provider.connection.getBalance(recipient));
        await program.methods
          .withdraw(args)
          .accountsPartial({
            pool: poolPda, vault: vaultPda, nullifierPda: nPda,
            recipient, treasury: treasury.publicKey,
            relayer: relayer.publicKey, systemProgram: SystemProgram.programId,
          })
          .signers([relayer])
          .rpc();
        const after = BigInt(await provider.connection.getBalance(recipient));
        assert.equal(
          (after - before).toString(),
          (DENOMINATION - TREASURY_FEE - RELAYER_FEE).toString(),
          "I7: withdrawal paid the wrong amount"
        );
        withdrawals += 1n;
        spentNotes.push(note);
        const nAcc = await provider.connection.getAccountInfo(nPda);
        assert.ok(nAcc, "I3: nullifier account missing after withdrawal");
      } else if (op === "withdraw_garbage") {
        const nh = randField();
        const nPda = nullifierPda(nh);
        const args = {
          proofA: Array.from(Buffer.concat([toBytes32(randField()), toBytes32(randField())])),
          proofB: Array.from(Buffer.concat([
            toBytes32(randField()), toBytes32(randField()),
            toBytes32(randField()), toBytes32(randField()),
          ])),
          proofC: Array.from(Buffer.concat([toBytes32(randField()), toBytes32(randField())])),
          nullifierHash: Array.from(toBytes32(nh)),
          root: Array.from(toBytes32(randField())),
          withdrawalCommitment: Array.from(toBytes32(randField())),
          relayerFeeMax: new BN(RELAYER_FEE.toString()),
          relayerFeeTaken: new BN(RELAYER_FEE.toString()),
        };
        let succeeded = false;
        try {
          await program.methods
            .withdraw(args as any)
            .accountsPartial({
              pool: poolPda, vault: vaultPda, nullifierPda: nPda,
              recipient: Keypair.generate().publicKey, treasury: treasury.publicKey,
              relayer: relayer.publicKey, systemProgram: SystemProgram.programId,
            })
            .signers([relayer])
            .rpc();
          succeeded = true;
        } catch {
          /* expected */
        }
        assert.isFalse(succeeded, "I5: a garbage withdrawal SUCCEEDED — funds can be stolen");
      } else if (op === "replay" && spentNotes.length > 0) {
        const note = spentNotes[Math.floor(rng() * spentNotes.length)];
        const recipient = Keypair.generate().publicKey;
        const args = await buildProof(note, recipient);
        const nPda = nullifierPda(ph(note.n));
        let succeeded = false;
        try {
          await program.methods
            .withdraw(args)
            .accountsPartial({
              pool: poolPda, vault: vaultPda, nullifierPda: nPda,
              recipient, treasury: treasury.publicKey,
              relayer: relayer.publicKey, systemProgram: SystemProgram.programId,
            })
            .signers([relayer])
            .rpc();
          succeeded = true;
        } catch (e: any) {
          assert.include(
            e.message, "NullifierAlreadySpent",
            `replay failed for the wrong reason: ${e.message}`
          );
        }
        assert.isFalse(succeeded, "I8: DOUBLE SPEND — a spent note was withdrawn again");
      } else if (op === "pause" && !paused) {
        await program.methods
          .pausePool()
          .accountsPartial({ admin: admin.publicKey, pool: poolPda })
          .signers([admin])
          .rpc();
        paused = true;
      } else if (op === "unpause" && paused) {
        await program.methods
          .unpausePool()
          .accountsPartial({ admin: admin.publicKey, pool: poolPda })
          .signers([admin])
          .rpc();
        paused = false;
      }

      await withTimeout(`checkInvariants after ${op}`, checkInvariants(`step ${step} (${op})`));
      if (process.env.SEQ_FUZZ_TRACE) {
        process.stdout.write(`      done in ${Date.now() - stepStarted}ms\n`);
      }
    }

    console.log(
      `  [seq-fuzz] ${STEPS} steps OK — ops: ${Object.entries(opCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`
    );
    console.log(
      `  [seq-fuzz] final: deposits=${deposits} withdrawals=${withdrawals} ` +
        `live=${liveNotes.length} spent=${spentNotes.length} paused=${paused}`
    );
    assert.isAtLeast(Number(deposits), 1, "fuzz run made no deposits");
    assert.isAtLeast(Number(withdrawals), 1, "fuzz run made no successful withdrawals");
  });
});
