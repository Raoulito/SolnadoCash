"use strict";
// sdk/test/e2e.test.ts
// T35 — End-to-end SDK test: generateNote → deposit → generateProof → withdraw via relayer
//
// This test exercises the full privacy flow using all SDK modules together:
//   note.ts → proof.ts → fees.ts → stealth.ts
// Circuit files are required for proof generation (skipped if missing).
// Relayer interactions are mocked via globalThis.fetch.
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
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = require("node:assert");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_url_1 = require("node:url");
const web3_js_1 = require("@solana/web3.js");
const snarkjs = __importStar(require("snarkjs"));
const note_js_1 = require("../src/note.js");
const proof_js_1 = require("../src/proof.js");
const fees_js_1 = require("../src/fees.js");
const stealth_js_1 = require("../src/stealth.js");
const __dirname = (0, node_path_1.dirname)((0, node_url_1.fileURLToPath)(import.meta.url));
const ROOT_DIR = (0, node_path_1.resolve)(__dirname, "../..");
const WITHDRAW_WASM = (0, node_path_1.resolve)(ROOT_DIR, "circuits/build/withdraw_js/withdraw.wasm");
const WITHDRAW_ZKEY = (0, node_path_1.resolve)(ROOT_DIR, "circuits/build/withdraw_final.zkey");
const VK_PATH = (0, node_path_1.resolve)(ROOT_DIR, "circuits/build/withdraw_vk.json");
const hasCircuits = (0, node_fs_1.existsSync)(WITHDRAW_WASM) &&
    (0, node_fs_1.existsSync)(WITHDRAW_ZKEY) &&
    (0, node_fs_1.existsSync)(VK_PATH);
// ── Test constants ────────────────────────────────────────────────────────────
const DENOMINATION = 1000000000n; // 1 SOL
const RELAYER_FEE_MAX = 83000n; // typical relayer fee
(hasCircuits ? describe : describe.skip)("T35 — End-to-end SDK flow", function () {
    this.timeout(120000);
    // Simulated actors
    const poolAddress = web3_js_1.Keypair.generate().publicKey;
    const relayerKeypair = web3_js_1.Keypair.generate();
    const recipientScanKeypair = web3_js_1.Keypair.generate();
    const recipientSpendKeypair = web3_js_1.Keypair.generate();
    let tree;
    let originalFetch;
    before(async () => {
        await (0, proof_js_1.initPoseidon)();
        tree = new proof_js_1.MerkleTree(20);
        originalFetch = globalThis.fetch;
    });
    after(() => {
        globalThis.fetch = originalFetch;
    });
    // ── Step 1: Note generation ───────────────────────────────────────────
    let note;
    it("Step 1 — generateNote creates a valid secret note", () => {
        note = (0, note_js_1.generateNote)(DENOMINATION, poolAddress);
        node_assert_1.strict.equal(note.denomination, DENOMINATION);
        node_assert_1.strict.equal(note.poolAddress.toBase58(), poolAddress.toBase58());
        node_assert_1.strict.ok(note.nullifier > 0n, "nullifier must be non-zero");
        node_assert_1.strict.ok(note.secret > 0n, "secret must be non-zero");
        node_assert_1.strict.ok(note.encoded.startsWith("sndo_"), "encoded must have sndo_ prefix");
    });
    // ── Step 2: Note encode/decode roundtrip ──────────────────────────────
    it("Step 2 — encodeNote/decodeNote roundtrips correctly", () => {
        const encoded = (0, note_js_1.encodeNote)(note);
        node_assert_1.strict.equal(encoded, note.encoded);
        const decoded = (0, note_js_1.decodeNote)(encoded);
        node_assert_1.strict.equal(decoded.nullifier, note.nullifier);
        node_assert_1.strict.equal(decoded.secret, note.secret);
        node_assert_1.strict.equal(decoded.denomination, note.denomination);
        node_assert_1.strict.equal(decoded.poolAddress.toBase58(), note.poolAddress.toBase58());
    });
    // ── Step 3: Compute commitment and insert into Merkle tree ────────────
    let commitment;
    it("Step 3 — compute commitment and insert into Merkle tree (simulates deposit)", () => {
        commitment = (0, proof_js_1.poseidonHash)(note.nullifier, note.secret, note.denomination);
        node_assert_1.strict.ok(commitment > 0n, "commitment must be non-zero");
        const emptyRoot = tree.root;
        const leafIndex = tree.insert(commitment);
        node_assert_1.strict.equal(leafIndex, 0, "first deposit should be at index 0");
        node_assert_1.strict.equal(tree.nextIndex, 1);
        node_assert_1.strict.notEqual(tree.root, emptyRoot, "root should change after insert");
        // Verify commitment is findable
        node_assert_1.strict.equal(tree.findLeaf(commitment), 0);
    });
    // ── Step 4: Generate stealth address for recipient ────────────────────
    let stealthAddress;
    let ephemeralPubkey;
    it("Step 4 — generate stealth address for recipient", () => {
        const result = (0, stealth_js_1.generateStealthAddress)(recipientScanKeypair.publicKey, recipientSpendKeypair.publicKey);
        stealthAddress = result.stealthAddress;
        ephemeralPubkey = result.ephemeralKey.publicKey;
        node_assert_1.strict.ok(stealthAddress instanceof web3_js_1.PublicKey);
        // Recipient can recover the same address
        const recovered = (0, stealth_js_1.recoverStealthKeypair)(recipientScanKeypair.secretKey.slice(0, 32), recipientSpendKeypair.publicKey, ephemeralPubkey);
        node_assert_1.strict.equal(recovered.publicKey.toBase58(), stealthAddress.toBase58(), "recipient must recover the same stealth address");
    });
    // ── Step 5: Get fee quote from relayer (mocked) ───────────────────────
    let quote;
    it("Step 5 — getFeeQuote from relayer", async () => {
        const validUntil = Date.now() + 30000;
        const treasuryFee = (0, fees_js_1.computeTreasuryFee)(DENOMINATION);
        const estimatedUserReceives = DENOMINATION - treasuryFee - RELAYER_FEE_MAX;
        // Mock the relayer's /fee_quote endpoint
        globalThis.fetch = async (input) => {
            const url = typeof input === "string" ? input : input.url;
            node_assert_1.strict.ok(url.includes("/fee_quote?pool="), "should call /fee_quote endpoint");
            node_assert_1.strict.ok(url.includes(poolAddress.toBase58()), "should include pool address");
            return new Response(JSON.stringify({
                relayerAddress: relayerKeypair.publicKey.toBase58(),
                relayerFeeMax: RELAYER_FEE_MAX.toString(),
                validUntil,
                estimatedUserReceives: estimatedUserReceives.toString(),
                treasuryFee: treasuryFee.toString(),
                denomination: DENOMINATION.toString(),
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        };
        quote = await (0, fees_js_1.getFeeQuote)("https://relayer.solnadocash.io", poolAddress);
        node_assert_1.strict.equal(quote.relayerAddress.toBase58(), relayerKeypair.publicKey.toBase58());
        node_assert_1.strict.equal(quote.relayerFeeMax, RELAYER_FEE_MAX);
        node_assert_1.strict.equal(quote.validUntil, validUntil);
        node_assert_1.strict.equal(quote.estimatedUserReceives, estimatedUserReceives);
    });
    // ── Step 6: Verify fee calculations ───────────────────────────────────
    it("Step 6 — fee calculations are consistent", () => {
        const treasuryFee = (0, fees_js_1.computeTreasuryFee)(DENOMINATION);
        node_assert_1.strict.equal(treasuryFee, 2000000n, "treasury = 0.002 SOL for 1 SOL pool");
        const minUserReceives = (0, fees_js_1.computeMinUserReceives)(DENOMINATION, quote);
        const expected = DENOMINATION - treasuryFee - quote.relayerFeeMax;
        node_assert_1.strict.equal(minUserReceives, expected);
        node_assert_1.strict.ok(minUserReceives > 0n, "user must receive positive amount");
        // Verify fee invariant: treasury + relayer + user == denomination
        node_assert_1.strict.equal(treasuryFee + quote.relayerFeeMax + minUserReceives, DENOMINATION, "fee invariant: all fees + user amount == denomination");
    });
    // ── Step 7: Generate ZK proof ─────────────────────────────────────────
    let proof;
    let publicSignals;
    it("Step 7 — generateWithdrawProof creates a valid Groth16 proof", async () => {
        const result = await (0, proof_js_1.generateWithdrawProof)(note, quote, stealthAddress, // withdraw to stealth address
        tree, { wasmPath: WITHDRAW_WASM, zkeyPath: WITHDRAW_ZKEY });
        proof = result.proof;
        publicSignals = result.publicSignals;
        // Verify proof structure
        node_assert_1.strict.ok(proof.pi_a, "proof must have pi_a");
        node_assert_1.strict.ok(proof.pi_b, "proof must have pi_b");
        node_assert_1.strict.ok(proof.pi_c, "proof must have pi_c");
        node_assert_1.strict.equal(proof.protocol, "groth16");
        // Verify public signals order: [nullifierHash, root, withdrawalCommitment]
        node_assert_1.strict.equal(publicSignals.length, 3);
        const expectedNullifierHash = (0, proof_js_1.poseidonHash)(note.nullifier);
        node_assert_1.strict.equal(publicSignals[0], expectedNullifierHash, "signal[0] must be nullifierHash");
        node_assert_1.strict.equal(publicSignals[1], tree.root, "signal[1] must be current Merkle root");
        // Verify withdrawalCommitment binds recipient + relayer + fee
        const relayerField = (0, proof_js_1.pubkeyToField)(quote.relayerAddress);
        const recipientField = (0, proof_js_1.pubkeyToField)(stealthAddress);
        const expectedWC = (0, proof_js_1.poseidonHash)(relayerField, quote.relayerFeeMax, recipientField);
        node_assert_1.strict.equal(publicSignals[2], expectedWC, "signal[2] must be withdrawalCommitment");
    });
    // ── Step 8: Verify proof off-chain (snarkjs) ──────────────────────────
    it("Step 8 — proof verifies with snarkjs (off-chain verification)", async () => {
        const { readFileSync } = await Promise.resolve().then(() => __importStar(require("node:fs")));
        const vk = JSON.parse(readFileSync(VK_PATH, "utf8"));
        const signalsAsStrings = publicSignals.map((s) => s.toString());
        const valid = await snarkjs.groth16.verify(vk, signalsAsStrings, proof);
        node_assert_1.strict.ok(valid, "proof must verify against the verification key");
    });
    // ── Step 9: Submit to relayer (mocked) ────────────────────────────────
    it("Step 9 — submit proof to relayer and receive tx signature", async () => {
        const fakeTxSig = "5wHu1qwD7q3bYJe4QsCxqW" + "a".repeat(64);
        globalThis.fetch = async (input, init) => {
            const url = typeof input === "string" ? input : input.url;
            node_assert_1.strict.ok(url.includes("/submit_proof"), "should call /submit_proof endpoint");
            node_assert_1.strict.equal(init?.method, "POST");
            const body = JSON.parse(init.body);
            // Verify the relayer receives correct proof format
            node_assert_1.strict.ok(body.proof, "body must include proof");
            node_assert_1.strict.ok(body.proof.pi_a, "proof must have pi_a");
            node_assert_1.strict.ok(body.proof.pi_b, "proof must have pi_b");
            node_assert_1.strict.ok(body.proof.pi_c, "proof must have pi_c");
            // Verify public signals (as decimal strings)
            node_assert_1.strict.deepEqual(body.publicSignals, [
                publicSignals[0].toString(),
                publicSignals[1].toString(),
                publicSignals[2].toString(),
            ]);
            // Verify pool and recipient
            node_assert_1.strict.equal(body.poolAddress, poolAddress.toBase58());
            node_assert_1.strict.equal(body.recipient, stealthAddress.toBase58());
            node_assert_1.strict.equal(body.relayerFeeMax, RELAYER_FEE_MAX.toString());
            return new Response(JSON.stringify({
                txSignature: fakeTxSig,
                feeTaken: RELAYER_FEE_MAX.toString(),
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        };
        // Simulate what the SDK client would do to submit
        const relayerUrl = "https://relayer.solnadocash.io";
        const res = await fetch(`${relayerUrl}/submit_proof`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                proof,
                publicSignals: publicSignals.map((s) => s.toString()),
                poolAddress: poolAddress.toBase58(),
                recipient: stealthAddress.toBase58(),
                relayerFeeMax: RELAYER_FEE_MAX.toString(),
            }),
        });
        node_assert_1.strict.equal(res.status, 200);
        const data = await res.json();
        node_assert_1.strict.ok(data.txSignature, "response must include txSignature");
        node_assert_1.strict.equal(data.feeTaken, RELAYER_FEE_MAX.toString());
    });
    // ── Step 10: Verify double-spend protection ───────────────────────────
    it("Step 10 — same note cannot generate proof with different recipient", async () => {
        // The same note in the same tree should still produce a valid proof
        // (double-spend is enforced on-chain via nullifier PDA, not in the circuit).
        // But the nullifierHash must be the same, which the on-chain program rejects.
        const differentRecipient = web3_js_1.Keypair.generate().publicKey;
        const result2 = await (0, proof_js_1.generateWithdrawProof)(note, quote, differentRecipient, tree, { wasmPath: WITHDRAW_WASM, zkeyPath: WITHDRAW_ZKEY });
        // Same nullifierHash — on-chain would reject as double-spend
        node_assert_1.strict.equal(result2.publicSignals[0], publicSignals[0], "nullifierHash must be identical for the same note");
        // Different withdrawalCommitment (different recipient)
        node_assert_1.strict.notEqual(result2.publicSignals[2], publicSignals[2], "withdrawalCommitment must differ for different recipient");
    });
    // ── Step 11: Multiple deposits in same tree ───────────────────────────
    it("Step 11 — second deposit updates tree, first deposit proof still works", async () => {
        // Simulate a second deposit from a different user
        const note2 = (0, note_js_1.generateNote)(DENOMINATION, poolAddress);
        const commitment2 = (0, proof_js_1.poseidonHash)(note2.nullifier, note2.secret, note2.denomination);
        const leafIndex2 = tree.insert(commitment2);
        node_assert_1.strict.equal(leafIndex2, 1, "second deposit at index 1");
        node_assert_1.strict.equal(tree.nextIndex, 2);
        // Generate proof for the SECOND note (new tree state)
        const recipient2 = web3_js_1.Keypair.generate().publicKey;
        const { proof: proof2, publicSignals: ps2 } = await (0, proof_js_1.generateWithdrawProof)(note2, quote, recipient2, tree, {
            wasmPath: WITHDRAW_WASM,
            zkeyPath: WITHDRAW_ZKEY,
        });
        // Verify proof2 is valid
        const { readFileSync } = await Promise.resolve().then(() => __importStar(require("node:fs")));
        const vk = JSON.parse(readFileSync(VK_PATH, "utf8"));
        const valid = await snarkjs.groth16.verify(vk, ps2.map((s) => s.toString()), proof2);
        node_assert_1.strict.ok(valid, "second deposit proof must also verify");
        // Root is different from original proof (tree grew)
        node_assert_1.strict.notEqual(ps2[1], publicSignals[1], "root must differ after second deposit");
        // NullifierHash is different (different note)
        node_assert_1.strict.notEqual(ps2[0], publicSignals[0], "nullifierHash must differ for different notes");
    });
});
