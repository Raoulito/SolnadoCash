"use strict";
// tests/pool.ts
//
// T21 — Pool management integration tests (no ZK proofs)
// T22 — CU profiling for initialize_pool, deposit, pause_pool
//
// Run: anchor test
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Use default import for CJS/ESM interop in Node.js v24
const anchor_1 = __importDefault(require("@coral-xyz/anchor"));
const { AnchorProvider, Program, setProvider, workspace, BN } = anchor_1.default;
const web3_js_1 = require("@solana/web3.js");
const chai_1 = require("chai");
// ── Constants ──────────────────────────────────────────────────────────────────
const DENOMINATION = new BN(1000000000); // 1 SOL
const VERSION = 0;
const MAX_CU = 1400000;
// Generate a random 32-byte commitment guaranteed to be < BN254 field order.
// Setting byte[0] = 0 ensures value < 2^248 << field order (~2^254).
function randomInFieldCommitment() {
    const c = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
    c[0] = 0;
    return c;
}
// ── PDA helpers ───────────────────────────────────────────────────────────────
function findPoolPda(admin, denomination, version, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([
        Buffer.from("pool"),
        admin.toBytes(),
        new web3_js_1.PublicKey(Buffer.alloc(32, 0)).toBytes(), // mint = Pubkey::default() for SOL
        denomination.toArrayLike(Buffer, "le", 8),
        Buffer.from([version]),
    ], programId);
}
function findVaultPda(poolPda, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("vault"), poolPda.toBytes()], programId);
}
// ── CU measurement helper ─────────────────────────────────────────────────────
async function measureCU(provider, ixBuilder) {
    const ix = await ixBuilder.instruction();
    const budgetIx = web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU });
    const { blockhash } = await provider.connection.getLatestBlockhash();
    const msg = new web3_js_1.TransactionMessage({
        payerKey: provider.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [budgetIx, ix],
    }).compileToV0Message();
    const vTx = new web3_js_1.VersionedTransaction(msg);
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
    const program = workspace.Solnadocash;
    // ── initialize_pool ─────────────────────────────────────────────────────────
    describe("initialize_pool", () => {
        let admin;
        let treasury;
        let poolPda;
        let vaultPda;
        before(async () => {
            admin = web3_js_1.Keypair.generate();
            treasury = web3_js_1.Keypair.generate();
            // Fund admin
            const sig = await provider.connection.requestAirdrop(admin.publicKey, 5 * web3_js_1.LAMPORTS_PER_SOL);
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
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([admin])
                .rpc();
            const pool = await program.account.pool.fetch(poolPda);
            chai_1.assert.ok(pool.admin.equals(admin.publicKey), "admin mismatch");
            chai_1.assert.equal(pool.denomination.toNumber(), DENOMINATION.toNumber(), "denomination");
            chai_1.assert.equal(pool.version, VERSION, "version");
            chai_1.assert.ok(pool.treasury.equals(treasury.publicKey), "treasury mismatch");
            chai_1.assert.equal(pool.nextIndex.toNumber(), 0, "nextIndex should be 0");
            chai_1.assert.equal(pool.isPaused, false, "should not be paused");
            // vault account should exist
            const vaultInfo = await provider.connection.getAccountInfo(vaultPda);
            chai_1.assert.ok(vaultInfo !== null, "vault PDA should exist");
        });
        it("rejects denomination < 500", async () => {
            const admin2 = web3_js_1.Keypair.generate();
            const sig = await provider.connection.requestAirdrop(admin2.publicKey, 5 * web3_js_1.LAMPORTS_PER_SOL);
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
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([admin2])
                    .rpc();
                chai_1.assert.fail("should have thrown DenominationTooLow");
            }
            catch (err) {
                chai_1.assert.include(err.message, "DenominationTooLow", `Expected DenominationTooLow, got: ${err.message}`);
            }
        });
        it("rejects version = 255", async () => {
            const admin3 = web3_js_1.Keypair.generate();
            const sig = await provider.connection.requestAirdrop(admin3.publicKey, 5 * web3_js_1.LAMPORTS_PER_SOL);
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
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([admin3])
                    .rpc();
                chai_1.assert.fail("should have thrown VersionTooHigh");
            }
            catch (err) {
                chai_1.assert.include(err.message, "VersionTooHigh", `Expected VersionTooHigh, got: ${err.message}`);
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
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([admin])
                    .rpc();
                chai_1.assert.fail("should have rejected re-initialization");
            }
            catch (err) {
                // Anchor's init constraint rejects because the account already exists
                chai_1.assert.ok(err, "expected error on re-initialization");
            }
        });
    });
    // ── deposit ──────────────────────────────────────────────────────────────────
    describe("deposit", () => {
        let admin;
        let treasury;
        let poolPda;
        let vaultPda;
        before(async () => {
            admin = web3_js_1.Keypair.generate();
            treasury = web3_js_1.Keypair.generate();
            const sig = await provider.connection.requestAirdrop(admin.publicKey, 10 * web3_js_1.LAMPORTS_PER_SOL);
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
                systemProgram: web3_js_1.SystemProgram.programId,
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
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([admin])
                .rpc();
            const poolAfter = await program.account.pool.fetch(poolPda);
            chai_1.assert.equal(poolAfter.nextIndex.toNumber(), 1, "nextIndex should be 1 after deposit");
            chai_1.assert.notEqual(poolAfter.currentRootIndex.toNumber(), rootIndexBefore, "currentRootIndex should have advanced");
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
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([admin])
                    .rpc();
                chai_1.assert.fail("should have thrown PoolPaused");
            }
            catch (err) {
                chai_1.assert.include(err.message, "PoolPaused", `Expected PoolPaused, got: ${err.message}`);
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
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([admin])
                .rpc();
            const pool = await program.account.pool.fetch(poolPda);
            chai_1.assert.isAbove(pool.nextIndex.toNumber(), 1, "nextIndex should have advanced after unpause+deposit");
        });
    });
    // ── pause / unpause ───────────────────────────────────────────────────────────
    describe("pause / unpause", () => {
        let admin;
        let treasury;
        let poolPda;
        let vaultPda;
        before(async () => {
            admin = web3_js_1.Keypair.generate();
            treasury = web3_js_1.Keypair.generate();
            const sig = await provider.connection.requestAirdrop(admin.publicKey, 5 * web3_js_1.LAMPORTS_PER_SOL);
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
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([admin])
                .rpc();
        });
        it("non-admin cannot pause", async () => {
            const nonAdmin = web3_js_1.Keypair.generate();
            const sig = await provider.connection.requestAirdrop(nonAdmin.publicKey, 2 * web3_js_1.LAMPORTS_PER_SOL);
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
                chai_1.assert.fail("non-admin should not be able to pause");
            }
            catch (err) {
                chai_1.assert.ok(err, "expected an error when non-admin tries to pause");
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
            const nonAdmin = web3_js_1.Keypair.generate();
            const sig = await provider.connection.requestAirdrop(nonAdmin.publicKey, 2 * web3_js_1.LAMPORTS_PER_SOL);
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
                chai_1.assert.fail("non-admin should not be able to unpause");
            }
            catch (err) {
                chai_1.assert.ok(err, "expected an error when non-admin tries to unpause");
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
    const program = workspace.Solnadocash;
    let admin;
    let treasury;
    let poolPda;
    let vaultPda;
    before(async () => {
        admin = web3_js_1.Keypair.generate();
        treasury = web3_js_1.Keypair.generate();
        const sig = await provider.connection.requestAirdrop(admin.publicKey, 10 * web3_js_1.LAMPORTS_PER_SOL);
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
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .signers([admin])
            .rpc();
    });
    it("measures CU for initialize_pool", async () => {
        // Use a fresh admin so the PDA doesn't already exist
        const freshAdmin = web3_js_1.Keypair.generate();
        const sig = await provider.connection.requestAirdrop(freshAdmin.publicKey, 5 * web3_js_1.LAMPORTS_PER_SOL);
        await provider.connection.confirmTransaction(sig);
        const [freshPool] = findPoolPda(freshAdmin.publicKey, DENOMINATION, VERSION, program.programId);
        const [freshVault] = findVaultPda(freshPool, program.programId);
        const { cu, err, logs } = await measureCU(provider, program.methods
            .initializePool(DENOMINATION, VERSION)
            .accountsPartial({
            admin: freshAdmin.publicKey,
            pool: freshPool,
            vault: freshVault,
            treasury: treasury.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .signers([freshAdmin]));
        console.log(`\n  [T22] initialize_pool CU: ${cu.toLocaleString()}`);
        if (err) {
            console.log(`  (simulation error: ${JSON.stringify(err)})`);
            console.log(`  logs: ${logs.slice(-5).join("\n")}`);
        }
        chai_1.assert.isAbove(cu, 0, "CU should be > 0");
    });
    it("measures CU for deposit", async () => {
        const commitment = randomInFieldCommitment();
        const { cu, err, logs } = await measureCU(provider, program.methods
            .deposit(commitment)
            .accountsPartial({
            pool: poolPda,
            vault: vaultPda,
            depositor: admin.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .signers([admin]));
        console.log(`  [T22] deposit CU: ${cu.toLocaleString()}`);
        if (err) {
            console.log(`  (simulation error: ${JSON.stringify(err)})`);
            console.log(`  logs: ${logs.slice(-5).join("\n")}`);
        }
        chai_1.assert.isAbove(cu, 0, "CU should be > 0");
    });
    it("measures CU for pause_pool", async () => {
        const { cu, err, logs } = await measureCU(provider, program.methods
            .pausePool()
            .accountsPartial({
            admin: admin.publicKey,
            pool: poolPda,
        })
            .signers([admin]));
        console.log(`  [T22] pause_pool CU: ${cu.toLocaleString()}`);
        if (err) {
            console.log(`  (simulation error: ${JSON.stringify(err)})`);
            console.log(`  logs: ${logs.slice(-5).join("\n")}`);
        }
        chai_1.assert.isAbove(cu, 0, "CU should be > 0");
    });
});
