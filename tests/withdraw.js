"use strict";
// tests/withdraw.ts
//
// T21 — Full ZK proof integration tests for withdraw instruction
// T22 — CU profiling for withdraw
//
// Uses snarkjs groth16.fullProve to generate real Groth16 proofs.
// NOTE: proof generation takes ~30-60s per test — mocha timeout is set accordingly.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Use default import for CJS/ESM interop in Node.js v24
const anchor_1 = __importDefault(require("@coral-xyz/anchor"));
const { AnchorProvider, setProvider, workspace, BN } = anchor_1.default;
const web3_js_1 = require("@solana/web3.js");
const chai_1 = require("chai");
const path = __importStar(require("path"));
const url_1 = require("url");
// ESM-compatible __dirname
const __filename = (0, url_1.fileURLToPath)(import.meta.url);
const __dirname = path.dirname(__filename);
// snarkjs and circomlibjs — ESM imports
const snarkjs = __importStar(require("snarkjs"));
const circomlibjs_1 = require("circomlibjs");
// ── Build artifact paths ──────────────────────────────────────────────────────
const BUILD_DIR = path.join(__dirname, "../circuits/build");
const WITHDRAW_WASM = path.join(BUILD_DIR, "withdraw_js/withdraw.wasm");
const WITHDRAW_ZKEY = path.join(BUILD_DIR, "withdraw_final.zkey");
// ── Constants ─────────────────────────────────────────────────────────────────
const DENOMINATION = 1000000000n; // 1 SOL in lamports (BigInt for circom)
const TREE_DEPTH = 20;
const BN254_FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
// BN254 base field prime (Fq) — used for G1 point negation
const BN254_Fq = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const MAX_CU = 1400000;
// ── Global Poseidon ───────────────────────────────────────────────────────────
let _poseidon;
let _F;
async function ensurePoseidon() {
    if (!_poseidon) {
        _poseidon = await (0, circomlibjs_1.buildPoseidon)();
        _F = _poseidon.F;
    }
}
function poseidonHash(...inputs) {
    const result = _poseidon(inputs.map((x) => _F.e(x)));
    return BigInt(_F.toObject(result));
}
// ── Random field element ──────────────────────────────────────────────────────
function randomFieldElem() {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
        bytes[i] = Math.floor(Math.random() * 256);
    let value = 0n;
    for (const b of bytes)
        value = (value << 8n) | BigInt(b);
    return value % BN254_FIELD_ORDER;
}
// ── bigIntToBytes32 ───────────────────────────────────────────────────────────
function bigIntToBytes32(n) {
    const hex = n.toString(16).padStart(64, "0");
    return Buffer.from(hex, "hex");
}
// ── pubkeyToBigInt ────────────────────────────────────────────────────────────
// Interpret Solana pubkey bytes as a big-endian unsigned integer.
function pubkeyToBigInt(pk) {
    const bytes = pk.toBytes();
    let v = 0n;
    for (const b of bytes)
        v = (v << 8n) | BigInt(b);
    return v;
}
// ── snarkjsProofToBytes ───────────────────────────────────────────────────────
function snarkjsProofToBytes(proof) {
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
        this.roots = [this._zeroRoot()];
        this.nextIndex = 0n;
    }
    _zeroRoot() {
        let hash = 0n;
        for (let i = 0; i < this.depth; i++) {
            hash = poseidonHash(hash, this.zeros[i]);
        }
        return hash;
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
            }
            else {
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
    currentRoot() {
        return this.roots[this.roots.length - 1];
    }
}
// ── generateNote ──────────────────────────────────────────────────────────────
function generateNote(denomination) {
    const nullifier = randomFieldElem();
    const secret = randomFieldElem();
    const commitment = poseidonHash(nullifier, secret, denomination);
    const nullifierHash = poseidonHash(nullifier);
    return { nullifier, secret, commitment, nullifierHash };
}
// ── buildWithdrawArgs ─────────────────────────────────────────────────────────
function buildWithdrawArgs(proof, publicSignals, // [nullifierHash, root, withdrawalCommitment]
nullifierBump, relayerFeeMax, relayerFeeActual) {
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
function findPoolPda(admin, denomination, version, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([
        Buffer.from("pool"),
        admin.toBytes(),
        new web3_js_1.PublicKey(Buffer.alloc(32, 0)).toBytes(),
        denomination.toArrayLike(Buffer, "le", 8),
        Buffer.from([version]),
    ], programId);
}
function findVaultPda(poolPda, programId) {
    return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("vault"), poolPda.toBytes()], programId);
}
// ── CU measurement ────────────────────────────────────────────────────────────
async function measureCUFromIx(provider, ix) {
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
describe("Withdraw (T21 + T22 ZK flow)", function () {
    // Long timeout for proof generation
    this.timeout(300000);
    const provider = AnchorProvider.env();
    setProvider(provider);
    const program = workspace.Solnadocash;
    // Shared state set up in before()
    let admin;
    let treasury;
    let relayer;
    let recipient;
    let poolPda;
    let vaultPda;
    // JS-side merkle tree
    let jsTree;
    // Note for test withdrawals
    let note1;
    // Proof + signals for note1
    let proof1;
    let publicSignals1;
    // On-chain proof args for note1
    let withdrawArgs1;
    let nullifierPda1;
    let nullifierBump1;
    // fee amounts
    const RELAYER_FEE_MAX = 83000n;
    const RELAYER_FEE_ACTUAL = 83000n;
    const TREASURY_FEE = DENOMINATION / 500n; // 2_000_000
    before(async () => {
        // Build Poseidon first
        await ensurePoseidon();
        admin = web3_js_1.Keypair.generate();
        treasury = web3_js_1.Keypair.generate();
        // Generate recipient keypair — pubkey must be < BN254_FIELD_ORDER
        // Solana pubkeys are 32 bytes (256-bit), occasionally >= BN254 field order.
        // Generate until we get one that's in-field.
        let recipientBigInt;
        let relayerBigInt;
        do {
            recipient = web3_js_1.Keypair.generate();
            recipientBigInt = pubkeyToBigInt(recipient.publicKey);
        } while (recipientBigInt >= BN254_FIELD_ORDER);
        // Similarly for relayer
        do {
            relayer = web3_js_1.Keypair.generate();
            relayerBigInt = pubkeyToBigInt(relayer.publicKey);
        } while (relayerBigInt >= BN254_FIELD_ORDER);
        // Airdrop SOL
        for (const kp of [admin, relayer]) {
            const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * web3_js_1.LAMPORTS_PER_SOL);
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
            systemProgram: web3_js_1.SystemProgram.programId,
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
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .signers([admin])
            .rpc();
        // Update JS tree to match on-chain state
        const { pathElements, pathIndices, root } = jsTree.insert(note1.commitment);
        // Re-read to get current values (relayer might have been regenerated)
        relayerBigInt = pubkeyToBigInt(relayer.publicKey);
        recipientBigInt = pubkeyToBigInt(recipient.publicKey);
        // Compute withdrawal_commitment = Poseidon(relayer, relayerFeeMax, recipient)
        const withdrawalCommitment = poseidonHash(relayerBigInt, RELAYER_FEE_MAX, recipientBigInt);
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
        const result = await snarkjs.groth16.fullProve(circomInputs, WITHDRAW_WASM, WITHDRAW_ZKEY);
        proof1 = result.proof;
        publicSignals1 = result.publicSignals;
        console.log("  [withdraw.ts] Proof generated.");
        // Find nullifier PDA for note1
        const nullifierHashBytes = bigIntToBytes32(note1.nullifierHash);
        [nullifierPda1, nullifierBump1] = web3_js_1.PublicKey.findProgramAddressSync([
            Buffer.from("nullifier"),
            poolPda.toBytes(),
            nullifierHashBytes,
        ], program.programId);
        withdrawArgs1 = buildWithdrawArgs(proof1, publicSignals1, nullifierBump1, RELAYER_FEE_MAX, RELAYER_FEE_ACTUAL);
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
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([relayer])
                .rpc();
            const recipientAfter = await provider.connection.getBalance(recipient.publicKey);
            const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
            const expectedTreasuryFee = Number(TREASURY_FEE);
            const expectedRelayerFee = Number(RELAYER_FEE_ACTUAL);
            const expectedUserAmount = Number(DENOMINATION) - expectedTreasuryFee - expectedRelayerFee;
            // Treasury received treasury_fee
            chai_1.assert.equal(treasuryAfter - treasuryBefore, expectedTreasuryFee, `Treasury should receive ${expectedTreasuryFee} lamports`);
            // Recipient received user_amount
            chai_1.assert.equal(recipientAfter - recipientBefore, expectedUserAmount, `Recipient should receive ${expectedUserAmount} lamports`);
            // Nullifier PDA was created
            const nullifierInfo = await provider.connection.getAccountInfo(nullifierPda1);
            chai_1.assert.ok(nullifierInfo !== null, "Nullifier PDA should have been created");
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
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([relayer])
                    .rpc();
                chai_1.assert.fail("Should have rejected double-spend");
            }
            catch (err) {
                chai_1.assert.include(err.message, "NullifierAlreadySpent", `Expected NullifierAlreadySpent, got: ${err.message}`);
            }
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
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([admin])
                .rpc();
            const { pathElements, pathIndices, root } = jsTree.insert(note2.commitment);
            let recipientBigInt2;
            let recipient2;
            do {
                recipient2 = web3_js_1.Keypair.generate();
                recipientBigInt2 = pubkeyToBigInt(recipient2.publicKey);
            } while (recipientBigInt2 >= BN254_FIELD_ORDER);
            const withdrawalCommitment2 = poseidonHash(pubkeyToBigInt(relayer.publicKey), RELAYER_FEE_MAX, recipientBigInt2);
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
                relayerAddress: pubkeyToBigInt(relayer.publicKey).toString(),
                relayerFeeMax: RELAYER_FEE_MAX.toString(),
            };
            const result2 = await snarkjs.groth16.fullProve(circomInputs2, WITHDRAW_WASM, WITHDRAW_ZKEY);
            console.log("  [withdraw.ts] Proof generated.");
            // Find nullifier PDA for note2
            const nullifierHashBytes2 = bigIntToBytes32(note2.nullifierHash);
            const [nullifierPda2, nullifierBump2] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("nullifier"), poolPda.toBytes(), nullifierHashBytes2], program.programId);
            // Build args but with a FAKE root (random bytes, not in root history)
            const fakeRoot = Array.from({ length: 32 }, (_, i) => i + 1);
            const argsWithFakeRoot = buildWithdrawArgs(result2.proof, result2.publicSignals, nullifierBump2, RELAYER_FEE_MAX, RELAYER_FEE_ACTUAL);
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
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([relayer])
                    .rpc();
                chai_1.assert.fail("Should have rejected stale/fake root");
            }
            catch (err) {
                chai_1.assert.include(err.message, "RootNotFound", `Expected RootNotFound, got: ${err.message}`);
            }
        });
    });
    // ── Fee ceiling ──────────────────────────────────────────────────────────────
    describe("withdraw — fee ceiling", () => {
        it("rejects relayer_fee_taken > relayer_fee_max", async function () {
            this.timeout(120000);
            // Generate a fresh note
            const noteFee = generateNote(DENOMINATION);
            // Deposit on-chain
            await program.methods
                .deposit(Array.from(bigIntToBytes32(noteFee.commitment)))
                .accountsPartial({
                pool: poolPda,
                vault: vaultPda,
                depositor: admin.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([admin])
                .rpc();
            // Update JS tree
            const { pathElements, pathIndices, root } = jsTree.insert(noteFee.commitment);
            // Generate in-field recipient
            let recipientFee;
            let recipientFeeBigInt;
            do {
                recipientFee = web3_js_1.Keypair.generate();
                recipientFeeBigInt = pubkeyToBigInt(recipientFee.publicKey);
            } while (recipientFeeBigInt >= BN254_FIELD_ORDER);
            const withdrawalCommitmentFee = poseidonHash(pubkeyToBigInt(relayer.publicKey), RELAYER_FEE_MAX, recipientFeeBigInt);
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
                relayerAddress: pubkeyToBigInt(relayer.publicKey).toString(),
                relayerFeeMax: RELAYER_FEE_MAX.toString(),
            };
            const resultFee = await snarkjs.groth16.fullProve(circomInputsFee, WITHDRAW_WASM, WITHDRAW_ZKEY);
            console.log("  [withdraw.ts] Proof generated.");
            // Build args with relayer_fee_taken = relayer_fee_max + 1 (exceeds ceiling)
            const nullifierHashBytesFee = bigIntToBytes32(noteFee.nullifierHash);
            const [nullifierPdaFee, nullifierBumpFee] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("nullifier"), poolPda.toBytes(), nullifierHashBytesFee], program.programId);
            const badFeeArgs = buildWithdrawArgs(resultFee.proof, resultFee.publicSignals, nullifierBumpFee, RELAYER_FEE_MAX, RELAYER_FEE_MAX + 1n // exceeds max
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
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([relayer])
                    .rpc();
                chai_1.assert.fail("Should have rejected fee exceeding max");
            }
            catch (err) {
                chai_1.assert.include(err.message, "RelayerFeeExceedsMax", `Expected RelayerFeeExceedsMax, got: ${err.message}`);
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
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([admin])
                .rpc();
            const { pathElements, pathIndices, root } = jsTree.insert(noteForCU.commitment);
            let recipientCU;
            let recipientCUBigInt;
            do {
                recipientCU = web3_js_1.Keypair.generate();
                recipientCUBigInt = pubkeyToBigInt(recipientCU.publicKey);
            } while (recipientCUBigInt >= BN254_FIELD_ORDER);
            const wCommitmentCU = poseidonHash(pubkeyToBigInt(relayer.publicKey), RELAYER_FEE_MAX, recipientCUBigInt);
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
                relayerAddress: pubkeyToBigInt(relayer.publicKey).toString(),
                relayerFeeMax: RELAYER_FEE_MAX.toString(),
            };
            const cuResult = await snarkjs.groth16.fullProve(cuInputs, WITHDRAW_WASM, WITHDRAW_ZKEY);
            console.log("  [T22] Proof generated.");
            const nullifierHashBytesCU = bigIntToBytes32(noteForCU.nullifierHash);
            const [nullifierPdaCU, nullifierBumpCU] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("nullifier"), poolPda.toBytes(), nullifierHashBytesCU], program.programId);
            const withdrawArgsCU = buildWithdrawArgs(cuResult.proof, cuResult.publicSignals, nullifierBumpCU, RELAYER_FEE_MAX, RELAYER_FEE_ACTUAL);
            const ix = await program.methods
                .withdraw(withdrawArgsCU)
                .accountsPartial({
                pool: poolPda,
                vault: vaultPda,
                nullifierPda: nullifierPdaCU,
                recipient: recipientCU.publicKey,
                treasury: treasury.publicKey,
                relayer: relayer.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([relayer])
                .instruction();
            const { cu, err, logs } = await measureCUFromIx(provider, ix);
            console.log(`  [T22] withdraw CU: ${cu.toLocaleString()}`);
            if (err) {
                console.log(`  (simulation error: ${JSON.stringify(err)})`);
                console.log(`  logs: ${logs.slice(-10).join("\n")}`);
            }
            chai_1.assert.isAbove(cu, 0, "CU should be > 0");
        });
    });
});
