"use strict";
// sdk/test/proof.test.ts
// T32 — Tests for MerkleTree, poseidonHash, pubkeyToField, generateWithdrawProof
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = require("node:assert");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_url_1 = require("node:url");
const web3_js_1 = require("@solana/web3.js");
const proof_js_1 = require("../src/proof.js");
const note_js_1 = require("../src/note.js");
const __dirname = (0, node_path_1.dirname)((0, node_url_1.fileURLToPath)(import.meta.url));
const ROOT_DIR = (0, node_path_1.resolve)(__dirname, "../..");
const WITHDRAW_WASM = (0, node_path_1.resolve)(ROOT_DIR, "circuits/build/withdraw_js/withdraw.wasm");
const WITHDRAW_ZKEY = (0, node_path_1.resolve)(ROOT_DIR, "circuits/build/withdraw_final.zkey");
const BN254_FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
describe("T32 — sdk/src/proof.ts", function () {
    this.timeout(120000); // proof generation can be slow
    before(async () => {
        await (0, proof_js_1.initPoseidon)();
    });
    // ── poseidonHash ──────────────────────────────────────────────────────────
    describe("poseidonHash", () => {
        it("hashes single input (nullifierHash style)", () => {
            const result = (0, proof_js_1.poseidonHash)(42n);
            node_assert_1.strict.ok(result > 0n);
            node_assert_1.strict.ok(result < BN254_FIELD_ORDER);
        });
        it("hashes three inputs (commitment style)", () => {
            const result = (0, proof_js_1.poseidonHash)(1n, 2n, 1000000000n);
            node_assert_1.strict.ok(result > 0n);
            node_assert_1.strict.ok(result < BN254_FIELD_ORDER);
        });
        it("is deterministic", () => {
            const a = (0, proof_js_1.poseidonHash)(100n, 200n);
            const b = (0, proof_js_1.poseidonHash)(100n, 200n);
            node_assert_1.strict.equal(a, b);
        });
        it("different inputs produce different hashes", () => {
            const a = (0, proof_js_1.poseidonHash)(1n, 2n);
            const b = (0, proof_js_1.poseidonHash)(2n, 1n);
            node_assert_1.strict.notEqual(a, b);
        });
    });
    // ── pubkeyToField ────────────────────────────────────────────────────────
    describe("pubkeyToField", () => {
        it("returns a value within BN254 Fr", () => {
            const pk = web3_js_1.Keypair.generate().publicKey;
            const field = (0, proof_js_1.pubkeyToField)(pk);
            node_assert_1.strict.ok(field >= 0n);
            node_assert_1.strict.ok(field < BN254_FIELD_ORDER);
        });
        it("is deterministic for the same key", () => {
            const pk = web3_js_1.Keypair.generate().publicKey;
            node_assert_1.strict.equal((0, proof_js_1.pubkeyToField)(pk), (0, proof_js_1.pubkeyToField)(pk));
        });
        it("reduces pubkeys exceeding Fr", () => {
            // Create a pubkey with all 0xFF bytes (exceeds Fr)
            const maxBytes = new Uint8Array(32).fill(0xff);
            const pk = new web3_js_1.PublicKey(maxBytes);
            const field = (0, proof_js_1.pubkeyToField)(pk);
            node_assert_1.strict.ok(field < BN254_FIELD_ORDER);
            // 2^256 - 1 mod Fr
            const expected = (2n ** 256n - 1n) % BN254_FIELD_ORDER;
            node_assert_1.strict.equal(field, expected);
        });
    });
    // ── MerkleTree ────────────────────────────────────────────────────────────
    describe("MerkleTree", () => {
        it("empty tree root equals zeros[depth]", () => {
            const tree = new proof_js_1.MerkleTree(20);
            const expectedRoot = tree.zeros[20];
            node_assert_1.strict.equal(tree.root, expectedRoot);
        });
        it("nextIndex starts at 0", () => {
            const tree = new proof_js_1.MerkleTree();
            node_assert_1.strict.equal(tree.nextIndex, 0);
        });
        it("insert increments nextIndex", () => {
            const tree = new proof_js_1.MerkleTree();
            tree.insert(1n);
            node_assert_1.strict.equal(tree.nextIndex, 1);
            tree.insert(2n);
            node_assert_1.strict.equal(tree.nextIndex, 2);
        });
        it("single insert changes root", () => {
            const tree = new proof_js_1.MerkleTree();
            const emptyRoot = tree.root;
            tree.insert(42n);
            node_assert_1.strict.notEqual(tree.root, emptyRoot);
        });
        it("getProof returns valid path for single leaf", () => {
            const tree = new proof_js_1.MerkleTree();
            tree.insert(42n);
            const proof = tree.getProof(0);
            node_assert_1.strict.equal(proof.leafIndex, 0);
            node_assert_1.strict.equal(proof.pathElements.length, 20);
            node_assert_1.strict.equal(proof.pathIndices.length, 20);
            // First leaf at index 0: all pathIndices should be 0 (left child)
            node_assert_1.strict.ok(proof.pathIndices.every((i) => i === 0));
        });
        it("getProof root matches tree root", () => {
            const tree = new proof_js_1.MerkleTree();
            tree.insert(100n);
            tree.insert(200n);
            const proof0 = tree.getProof(0);
            const proof1 = tree.getProof(1);
            node_assert_1.strict.equal(proof0.root, tree.root);
            node_assert_1.strict.equal(proof1.root, tree.root);
        });
        it("proof can be verified by recomputing root", () => {
            const tree = new proof_js_1.MerkleTree();
            const leaf = (0, proof_js_1.poseidonHash)(123n, 456n, 1000000000n);
            tree.insert(leaf);
            const proof = tree.getProof(0);
            // Recompute root from proof
            let current = leaf;
            for (let i = 0; i < proof.pathElements.length; i++) {
                if (proof.pathIndices[i] === 0) {
                    current = (0, proof_js_1.poseidonHash)(current, proof.pathElements[i]);
                }
                else {
                    current = (0, proof_js_1.poseidonHash)(proof.pathElements[i], current);
                }
            }
            node_assert_1.strict.equal(current, tree.root);
        });
        it("proof valid after multiple inserts", () => {
            const tree = new proof_js_1.MerkleTree();
            const leaves = [10n, 20n, 30n, 40n, 50n];
            for (const leaf of leaves)
                tree.insert(leaf);
            // Verify proof for each leaf
            for (let idx = 0; idx < leaves.length; idx++) {
                const proof = tree.getProof(idx);
                let current = leaves[idx];
                for (let i = 0; i < proof.pathElements.length; i++) {
                    if (proof.pathIndices[i] === 0) {
                        current = (0, proof_js_1.poseidonHash)(current, proof.pathElements[i]);
                    }
                    else {
                        current = (0, proof_js_1.poseidonHash)(proof.pathElements[i], current);
                    }
                }
                node_assert_1.strict.equal(current, tree.root, `Proof failed for leaf index ${idx}`);
            }
        });
        it("findLeaf returns correct index", () => {
            const tree = new proof_js_1.MerkleTree();
            tree.insert(100n);
            tree.insert(200n);
            tree.insert(300n);
            node_assert_1.strict.equal(tree.findLeaf(100n), 0);
            node_assert_1.strict.equal(tree.findLeaf(200n), 1);
            node_assert_1.strict.equal(tree.findLeaf(300n), 2);
            node_assert_1.strict.equal(tree.findLeaf(999n), -1);
        });
        it("getProof throws for out-of-range index", () => {
            const tree = new proof_js_1.MerkleTree();
            tree.insert(1n);
            node_assert_1.strict.throws(() => tree.getProof(-1), /out of range/);
            node_assert_1.strict.throws(() => tree.getProof(1), /out of range/);
        });
        it("second leaf pathIndices[0] is 1 (right child)", () => {
            const tree = new proof_js_1.MerkleTree();
            tree.insert(1n);
            tree.insert(2n);
            const proof = tree.getProof(1);
            node_assert_1.strict.equal(proof.pathIndices[0], 1); // right child at level 0
        });
    });
    // ── generateWithdrawProof (requires circuit files) ────────────────────────
    const hasCircuits = (0, node_fs_1.existsSync)(WITHDRAW_WASM) && (0, node_fs_1.existsSync)(WITHDRAW_ZKEY);
    (hasCircuits ? describe : describe.skip)("generateWithdrawProof (circuit integration)", function () {
        this.timeout(120000);
        it("generates a valid proof for a single-deposit tree", async () => {
            const denomination = 1000000000n;
            const poolAddress = web3_js_1.Keypair.generate().publicKey;
            const note = (0, note_js_1.generateNote)(denomination, poolAddress);
            // Build tree and insert commitment
            const tree = new proof_js_1.MerkleTree();
            const commitment = (0, proof_js_1.poseidonHash)(note.nullifier, note.secret, note.denomination);
            tree.insert(commitment);
            // Mock fee quote
            const relayer = web3_js_1.Keypair.generate();
            const recipient = web3_js_1.Keypair.generate();
            const relayerFeeMax = 5000000n; // 0.005 SOL
            const quote = {
                relayerAddress: relayer.publicKey,
                relayerFeeMax,
                validUntil: Math.floor(Date.now() / 1000) + 30,
                estimatedUserReceives: denomination - denomination / 500n - relayerFeeMax,
            };
            const { proof, publicSignals } = await (0, proof_js_1.generateWithdrawProof)(note, quote, recipient.publicKey, tree, { wasmPath: WITHDRAW_WASM, zkeyPath: WITHDRAW_ZKEY });
            // Verify proof structure
            node_assert_1.strict.ok(proof.pi_a, "proof should have pi_a");
            node_assert_1.strict.ok(proof.pi_b, "proof should have pi_b");
            node_assert_1.strict.ok(proof.pi_c, "proof should have pi_c");
            node_assert_1.strict.equal(proof.protocol, "groth16");
            // Verify public signals: [nullifierHash, root, withdrawalCommitment]
            node_assert_1.strict.equal(publicSignals.length, 3);
            const expectedNullifierHash = (0, proof_js_1.poseidonHash)(note.nullifier);
            node_assert_1.strict.equal(publicSignals[0], expectedNullifierHash);
            node_assert_1.strict.equal(publicSignals[1], tree.root);
            const relayerField = (0, proof_js_1.pubkeyToField)(relayer.publicKey);
            const recipientField = (0, proof_js_1.pubkeyToField)(recipient.publicKey);
            const expectedWC = (0, proof_js_1.poseidonHash)(relayerField, relayerFeeMax, recipientField);
            node_assert_1.strict.equal(publicSignals[2], expectedWC);
        });
        it("throws when commitment is not in tree", async () => {
            const note = (0, note_js_1.generateNote)(1000000000n, web3_js_1.Keypair.generate().publicKey);
            const tree = new proof_js_1.MerkleTree(); // empty tree
            const relayer = web3_js_1.Keypair.generate();
            const quote = {
                relayerAddress: relayer.publicKey,
                relayerFeeMax: 5000000n,
                validUntil: Math.floor(Date.now() / 1000) + 30,
                estimatedUserReceives: 0n,
            };
            await node_assert_1.strict.rejects(() => (0, proof_js_1.generateWithdrawProof)(note, quote, web3_js_1.Keypair.generate().publicKey, tree, {
                wasmPath: WITHDRAW_WASM,
                zkeyPath: WITHDRAW_ZKEY,
            }), /Commitment not found/);
        });
    });
});
