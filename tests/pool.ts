// tests/pool.ts
//
// T21 — Pool management integration tests (no ZK proofs)
// T22 — CU profiling for initialize_pool, deposit, pause_pool
//
// Run: anchor test

// Use default import for CJS/ESM interop in Node.js v24
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, Program, setProvider, workspace, BN } = anchorPkg as any;
type AnchorProviderT = typeof import("@coral-xyz/anchor").AnchorProvider.prototype;

import {
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { assert } from "chai";
import type { Solnadocash } from "../target/types/solnadocash";

// ── Constants ──────────────────────────────────────────────────────────────────
const DENOMINATION = new BN(1_000_000_000); // 1 SOL
const VERSION = 0;
const MAX_CU = 1_400_000;

// Generate a random 32-byte commitment guaranteed to be < BN254 field order.
// Setting byte[0] = 0 ensures value < 2^248 << field order (~2^254).
function randomInFieldCommitment(): number[] {
  const c = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
  c[0] = 0;
  return c;
}

// ── PDA helpers ───────────────────────────────────────────────────────────────

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
      new PublicKey(Buffer.alloc(32, 0)).toBytes(), // mint = Pubkey::default() for SOL
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

// ── CU measurement helper ─────────────────────────────────────────────────────

async function measureCU(
  provider: any,
  ixBuilder: any
): Promise<{ cu: number; err: any; logs: string[] }> {
  const ix = await ixBuilder.instruction();
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

describe("Pool management (T21)", () => {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.Solnadocash as import("@coral-xyz/anchor").Program<Solnadocash>;

  // ── initialize_pool ─────────────────────────────────────────────────────────
  describe("initialize_pool", () => {
    let admin: Keypair;
    let treasury: Keypair;
    let poolPda: PublicKey;
    let vaultPda: PublicKey;

    before(async () => {
      admin = Keypair.generate();
      treasury = Keypair.generate();

      // Fund admin
      const sig = await provider.connection.requestAirdrop(
        admin.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      [poolPda] = findPoolPda(admin.publicKey, DENOMINATION, VERSION, program.programId);
      [vaultPda] = findVaultPda(poolPda, program.programId);
    });

    it("creates pool + vault with correct fields", async () => {
      await program.methods
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

      const pool = await program.account.pool.fetch(poolPda);
      assert.ok(pool.admin.equals(admin.publicKey), "admin mismatch");
      assert.equal(pool.denomination.toNumber(), DENOMINATION.toNumber(), "denomination");
      assert.equal(pool.version, VERSION, "version");
      assert.ok(pool.treasury.equals(treasury.publicKey), "treasury mismatch");
      assert.equal(pool.nextIndex.toNumber(), 0, "nextIndex should be 0");
      assert.equal(pool.isPaused, false, "should not be paused");

      // vault account should exist
      const vaultInfo = await provider.connection.getAccountInfo(vaultPda);
      assert.ok(vaultInfo !== null, "vault PDA should exist");
    });

    it("rejects denomination < 500", async () => {
      const admin2 = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        admin2.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const badDenom = new BN(499);
      const [pool2] = findPoolPda(admin2.publicKey, badDenom, VERSION, program.programId);
      const [vault2] = findVaultPda(pool2, program.programId);

      try {
        await program.methods
          .initializePool(badDenom, VERSION)
          .accountsPartial({
            admin: admin2.publicKey,
            pool: pool2,
            vault: vault2,
            treasury: treasury.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin2])
          .rpc();
        assert.fail("should have thrown DenominationTooLow");
      } catch (err: any) {
        assert.include(
          err.message,
          "DenominationTooLow",
          `Expected DenominationTooLow, got: ${err.message}`
        );
      }
    });

    it("rejects denomination below the rent-exempt payout floor (N-3)", async () => {
      // A withdrawal pays user_amount to a FRESH address, and the runtime refuses to
      // leave an account below rent.minimum_balance(0) = 890,880 lamports. Measured
      // on a validator: 890,879 rejected, 890,880 accepted.
      //
      // Worst case: user_amount = denom - denom/500 - denom/50, so the floor is
      // ~910,900 lamports. The old BF-14 limit of 500 was ~1822x too low and allowed
      // pools whose deposits could never be withdrawn privately.
      const tooLow = new BN(900_000); // above 500, below the real floor
      const admin2 = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        admin2.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const [poolPda2] = findPoolPda(admin2.publicKey, tooLow, 0, program.programId);
      const [vaultPda2] = findVaultPda(poolPda2, program.programId);

      try {
        await program.methods
          .initializePool(tooLow, 0)
          .accountsPartial({
            admin: admin2.publicKey,
            pool: poolPda2,
            vault: vaultPda2,
            treasury: admin2.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin2])
          .rpc();
        assert.fail(
          "FUND TRAP: created a pool whose deposits cannot be withdrawn to a fresh address"
        );
      } catch (err: any) {
        assert.include(
          err.message,
          "DenominationTooLow",
          `Expected DenominationTooLow, got: ${err.message}`
        );
      }
    });

    it("accepts a denomination just above the payout floor (N-3)", async () => {
      // 911_000 - 1_822 - 18_220 = 890_958 >= 890_880
      const justEnough = new BN(911_000);
      const admin3 = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        admin3.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const [poolPda3] = findPoolPda(admin3.publicKey, justEnough, 0, program.programId);
      const [vaultPda3] = findVaultPda(poolPda3, program.programId);

      await program.methods
        .initializePool(justEnough, 0)
        .accountsPartial({
          admin: admin3.publicKey,
          pool: poolPda3,
          vault: vaultPda3,
          treasury: admin3.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin3])
        .rpc();

      const acc = await provider.connection.getAccountInfo(poolPda3);
      assert.ok(acc !== null, "pool just above the floor must be creatable");

      // Sanity: the worst-case payout for this pool clears the rent floor.
      const denom = 911_000;
      const worst = denom - Math.floor(denom / 500) - Math.floor(denom / 50);
      const minRent = await provider.connection.getMinimumBalanceForRentExemption(0);
      assert.isAtLeast(worst, minRent, "worst-case payout must clear rent");
    });

    it("rejects version = 255", async () => {
      const admin3 = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        admin3.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const badVersion = 255;
      const [pool3] = findPoolPda(admin3.publicKey, DENOMINATION, badVersion, program.programId);
      const [vault3] = findVaultPda(pool3, program.programId);

      try {
        await program.methods
          .initializePool(DENOMINATION, badVersion)
          .accountsPartial({
            admin: admin3.publicKey,
            pool: pool3,
            vault: vault3,
            treasury: treasury.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin3])
          .rpc();
        assert.fail("should have thrown VersionTooHigh");
      } catch (err: any) {
        assert.include(
          err.message,
          "VersionTooHigh",
          `Expected VersionTooHigh, got: ${err.message}`
        );
      }
    });

    it("rejects re-initialization of existing pool", async () => {
      // poolPda was already created by the first test — re-init must fail
      try {
        await program.methods
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
        assert.fail("should have rejected re-initialization");
      } catch (err: any) {
        // Anchor's init constraint rejects because the account already exists
        assert.ok(err, "expected error on re-initialization");
      }
    });
  });

  // ── deposit ──────────────────────────────────────────────────────────────────
  describe("deposit", () => {
    let admin: Keypair;
    let treasury: Keypair;
    let poolPda: PublicKey;
    let vaultPda: PublicKey;

    before(async () => {
      admin = Keypair.generate();
      treasury = Keypair.generate();

      const sig = await provider.connection.requestAirdrop(
        admin.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      [poolPda] = findPoolPda(admin.publicKey, DENOMINATION, VERSION, program.programId);
      [vaultPda] = findVaultPda(poolPda, program.programId);

      await program.methods
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
    });

    it("accepts first deposit and updates Merkle root", async () => {
      // Random 32-byte commitment (no actual ZK constraint here)
      const commitment = randomInFieldCommitment();

      const poolBefore = await program.account.pool.fetch(poolPda);
      const rootIndexBefore = poolBefore.currentRootIndex.toNumber();

      await program.methods
        .deposit(commitment)
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          depositor: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const poolAfter = await program.account.pool.fetch(poolPda);
      assert.equal(poolAfter.nextIndex.toNumber(), 1, "nextIndex should be 1 after deposit");
      assert.notEqual(
        poolAfter.currentRootIndex.toNumber(),
        rootIndexBefore,
        "currentRootIndex should have advanced"
      );
    });

    it("rejects deposit when pool is paused", async () => {
      // Pause pool
      await program.methods
        .pausePool()
        .accountsPartial({
          admin: admin.publicKey,
          pool: poolPda,
        })
        .signers([admin])
        .rpc();

      const commitment = randomInFieldCommitment();

      try {
        await program.methods
          .deposit(commitment)
          .accountsPartial({
            pool: poolPda,
            vault: vaultPda,
            depositor: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();
        assert.fail("should have thrown PoolPaused");
      } catch (err: any) {
        assert.include(
          err.message,
          "PoolPaused",
          `Expected PoolPaused, got: ${err.message}`
        );
      }
    });

    it("resumes after unpause", async () => {
      // Unpause
      await program.methods
        .unpausePool()
        .accountsPartial({
          admin: admin.publicKey,
          pool: poolPda,
        })
        .signers([admin])
        .rpc();

      const commitment = randomInFieldCommitment();

      // Should succeed now
      await program.methods
        .deposit(commitment)
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          depositor: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const pool = await program.account.pool.fetch(poolPda);
      assert.isAbove(pool.nextIndex.toNumber(), 1, "nextIndex should have advanced after unpause+deposit");
    });
  });

  // ── pause / unpause ───────────────────────────────────────────────────────────
  describe("pause / unpause", () => {
    let admin: Keypair;
    let treasury: Keypair;
    let poolPda: PublicKey;
    let vaultPda: PublicKey;

    before(async () => {
      admin = Keypair.generate();
      treasury = Keypair.generate();

      const sig = await provider.connection.requestAirdrop(
        admin.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      [poolPda] = findPoolPda(admin.publicKey, DENOMINATION, VERSION, program.programId);
      [vaultPda] = findVaultPda(poolPda, program.programId);

      await program.methods
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
    });

    it("non-admin cannot pause", async () => {
      const nonAdmin = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        nonAdmin.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      try {
        await program.methods
          .pausePool()
          .accountsPartial({
            admin: nonAdmin.publicKey,
            pool: poolPda,
          })
          .signers([nonAdmin])
          .rpc();
        assert.fail("non-admin should not be able to pause");
      } catch (err: any) {
        assert.ok(err, "expected an error when non-admin tries to pause");
      }
    });

    it("non-admin cannot unpause", async () => {
      // Pause with real admin first
      await program.methods
        .pausePool()
        .accountsPartial({
          admin: admin.publicKey,
          pool: poolPda,
        })
        .signers([admin])
        .rpc();

      const nonAdmin = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        nonAdmin.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      try {
        await program.methods
          .unpausePool()
          .accountsPartial({
            admin: nonAdmin.publicKey,
            pool: poolPda,
          })
          .signers([nonAdmin])
          .rpc();
        assert.fail("non-admin should not be able to unpause");
      } catch (err: any) {
        assert.ok(err, "expected an error when non-admin tries to unpause");
      }

      // Cleanup: unpause with real admin
      await program.methods
        .unpausePool()
        .accountsPartial({
          admin: admin.publicKey,
          pool: poolPda,
        })
        .signers([admin])
        .rpc();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T22 — CU Profiling
// ─────────────────────────────────────────────────────────────────────────────

describe("CU profiling — T22 (pool instructions)", () => {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.Solnadocash as import("@coral-xyz/anchor").Program<Solnadocash>;

  let admin: Keypair;
  let treasury: Keypair;
  let poolPda: PublicKey;
  let vaultPda: PublicKey;

  before(async () => {
    admin = Keypair.generate();
    treasury = Keypair.generate();

    const sig = await provider.connection.requestAirdrop(
      admin.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    [poolPda] = findPoolPda(admin.publicKey, DENOMINATION, VERSION, program.programId);
    [vaultPda] = findVaultPda(poolPda, program.programId);

    // Initialize pool so subsequent CU measurements are against an existing pool
    await program.methods
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
  });

  it("measures CU for initialize_pool", async () => {
    // Use a fresh admin so the PDA doesn't already exist
    const freshAdmin = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      freshAdmin.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const [freshPool] = findPoolPda(freshAdmin.publicKey, DENOMINATION, VERSION, program.programId);
    const [freshVault] = findVaultPda(freshPool, program.programId);

    const { cu, err, logs } = await measureCU(
      provider,
      program.methods
        .initializePool(DENOMINATION, VERSION)
        .accountsPartial({
          admin: freshAdmin.publicKey,
          pool: freshPool,
          vault: freshVault,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([freshAdmin])
    );

    console.log(`\n  [T22] initialize_pool CU: ${cu.toLocaleString()}`);
    if (err) {
      console.log(`  (simulation error: ${JSON.stringify(err)})`);
      console.log(`  logs: ${logs.slice(-5).join("\n")}`);
    }
    assert.isAbove(cu, 0, "CU should be > 0");
  });

  it("measures CU for deposit", async () => {
    const commitment = randomInFieldCommitment();

    const { cu, err, logs } = await measureCU(
      provider,
      program.methods
        .deposit(commitment)
        .accountsPartial({
          pool: poolPda,
          vault: vaultPda,
          depositor: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
    );

    console.log(`  [T22] deposit CU: ${cu.toLocaleString()}`);
    if (err) {
      console.log(`  (simulation error: ${JSON.stringify(err)})`);
      console.log(`  logs: ${logs.slice(-5).join("\n")}`);
    }
    assert.isAbove(cu, 0, "CU should be > 0");
  });

  it("measures CU for pause_pool", async () => {
    const { cu, err, logs } = await measureCU(
      provider,
      program.methods
        .pausePool()
        .accountsPartial({
          admin: admin.publicKey,
          pool: poolPda,
        })
        .signers([admin])
    );

    console.log(`  [T22] pause_pool CU: ${cu.toLocaleString()}`);
    if (err) {
      console.log(`  (simulation error: ${JSON.stringify(err)})`);
      console.log(`  logs: ${logs.slice(-5).join("\n")}`);
    }
    assert.isAbove(cu, 0, "CU should be > 0");
  });
});
