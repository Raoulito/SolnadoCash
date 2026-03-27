"use strict";
// sdk/test/stealth.test.ts
// T33 — Tests for stealth address generation and recovery
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = require("node:assert");
const web3_js_1 = require("@solana/web3.js");
const stealth_js_1 = require("../src/stealth.js");
describe("T33 — sdk/src/stealth.ts", function () {
    // Recipient's key pairs (scan + spend)
    const scanKeypair = web3_js_1.Keypair.generate();
    const spendKeypair = web3_js_1.Keypair.generate();
    describe("generateStealthAddress", () => {
        it("returns a valid PublicKey and Keypair", () => {
            const result = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spendKeypair.publicKey);
            node_assert_1.strict.ok(result.stealthAddress instanceof web3_js_1.PublicKey);
            node_assert_1.strict.ok(result.ephemeralKey instanceof web3_js_1.Keypair);
            node_assert_1.strict.equal(result.stealthAddress.toBytes().length, 32);
            node_assert_1.strict.equal(result.ephemeralKey.publicKey.toBytes().length, 32);
        });
        it("generates unique stealth addresses each time", () => {
            const a = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spendKeypair.publicKey);
            const b = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spendKeypair.publicKey);
            node_assert_1.strict.notEqual(a.stealthAddress.toBase58(), b.stealthAddress.toBase58());
            node_assert_1.strict.notEqual(a.ephemeralKey.publicKey.toBase58(), b.ephemeralKey.publicKey.toBase58());
        });
        it("stealth address differs from scan and spend keys", () => {
            const { stealthAddress } = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spendKeypair.publicKey);
            node_assert_1.strict.notEqual(stealthAddress.toBase58(), scanKeypair.publicKey.toBase58());
            node_assert_1.strict.notEqual(stealthAddress.toBase58(), spendKeypair.publicKey.toBase58());
        });
        it("different spend keys produce different stealth addresses", () => {
            const spend2 = web3_js_1.Keypair.generate();
            const a = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spendKeypair.publicKey);
            const b = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spend2.publicKey);
            // Different ephemeral keys AND different spend keys → different stealth addresses
            node_assert_1.strict.notEqual(a.stealthAddress.toBase58(), b.stealthAddress.toBase58());
        });
    });
    describe("recoverStealthKeypair", () => {
        it("recovers the same stealth address the sender generated", () => {
            const { stealthAddress, ephemeralKey } = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spendKeypair.publicKey);
            const recovered = (0, stealth_js_1.recoverStealthKeypair)(scanKeypair.secretKey.slice(0, 32), // 32-byte seed
            spendKeypair.publicKey, ephemeralKey.publicKey);
            node_assert_1.strict.equal(recovered.publicKey.toBase58(), stealthAddress.toBase58(), "Recovered stealth address must match generated one");
        });
        it("recovered keypair can sign (has valid secret key)", () => {
            const { ephemeralKey } = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spendKeypair.publicKey);
            const recovered = (0, stealth_js_1.recoverStealthKeypair)(scanKeypair.secretKey.slice(0, 32), spendKeypair.publicKey, ephemeralKey.publicKey);
            // Verify the keypair is internally consistent (pub matches priv)
            const rederived = web3_js_1.Keypair.fromSecretKey(recovered.secretKey);
            node_assert_1.strict.equal(rederived.publicKey.toBase58(), recovered.publicKey.toBase58());
        });
        it("wrong scan key fails to recover", () => {
            const { stealthAddress, ephemeralKey } = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spendKeypair.publicKey);
            const wrongScan = web3_js_1.Keypair.generate();
            const wrong = (0, stealth_js_1.recoverStealthKeypair)(wrongScan.secretKey.slice(0, 32), spendKeypair.publicKey, ephemeralKey.publicKey);
            node_assert_1.strict.notEqual(wrong.publicKey.toBase58(), stealthAddress.toBase58(), "Wrong scan key must produce a different address");
        });
        it("wrong ephemeral key fails to recover", () => {
            const { stealthAddress } = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spendKeypair.publicKey);
            const wrongEph = web3_js_1.Keypair.generate();
            const wrong = (0, stealth_js_1.recoverStealthKeypair)(scanKeypair.secretKey.slice(0, 32), spendKeypair.publicKey, wrongEph.publicKey);
            node_assert_1.strict.notEqual(wrong.publicKey.toBase58(), stealthAddress.toBase58(), "Wrong ephemeral key must produce a different address");
        });
        it("works when scan and spend are the same key", () => {
            // Common setup for SOL pools — single keypair
            const sameKey = web3_js_1.Keypair.generate();
            const { stealthAddress, ephemeralKey } = (0, stealth_js_1.generateStealthAddress)(sameKey.publicKey, sameKey.publicKey);
            const recovered = (0, stealth_js_1.recoverStealthKeypair)(sameKey.secretKey.slice(0, 32), sameKey.publicKey, ephemeralKey.publicKey);
            node_assert_1.strict.equal(recovered.publicKey.toBase58(), stealthAddress.toBase58());
        });
    });
    describe("isMyStealthAddress", () => {
        it("returns true for a matching stealth address", () => {
            const { stealthAddress, ephemeralKey } = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spendKeypair.publicKey);
            const result = (0, stealth_js_1.isMyStealthAddress)(scanKeypair.secretKey.slice(0, 32), spendKeypair.publicKey, ephemeralKey.publicKey, stealthAddress);
            node_assert_1.strict.ok(result, "Should recognize own stealth address");
        });
        it("returns false for a non-matching address", () => {
            const { ephemeralKey } = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spendKeypair.publicKey);
            const randomAddress = web3_js_1.Keypair.generate().publicKey;
            const result = (0, stealth_js_1.isMyStealthAddress)(scanKeypair.secretKey.slice(0, 32), spendKeypair.publicKey, ephemeralKey.publicKey, randomAddress);
            node_assert_1.strict.ok(!result, "Should not match a random address");
        });
        it("returns false with wrong scan key", () => {
            const { stealthAddress, ephemeralKey } = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spendKeypair.publicKey);
            const wrongScan = web3_js_1.Keypair.generate();
            const result = (0, stealth_js_1.isMyStealthAddress)(wrongScan.secretKey.slice(0, 32), spendKeypair.publicKey, ephemeralKey.publicKey, stealthAddress);
            node_assert_1.strict.ok(!result, "Wrong scan key should not match");
        });
    });
    describe("determinism", () => {
        it("same inputs always produce same stealth address", () => {
            // Use a fixed ephemeral seed to verify determinism
            // (generateStealthAddress uses random internally, so we test via recovery)
            const { stealthAddress, ephemeralKey } = (0, stealth_js_1.generateStealthAddress)(scanKeypair.publicKey, spendKeypair.publicKey);
            // Recover twice with same inputs
            const a = (0, stealth_js_1.recoverStealthKeypair)(scanKeypair.secretKey.slice(0, 32), spendKeypair.publicKey, ephemeralKey.publicKey);
            const b = (0, stealth_js_1.recoverStealthKeypair)(scanKeypair.secretKey.slice(0, 32), spendKeypair.publicKey, ephemeralKey.publicKey);
            node_assert_1.strict.equal(a.publicKey.toBase58(), b.publicKey.toBase58());
            node_assert_1.strict.equal(a.publicKey.toBase58(), stealthAddress.toBase58());
        });
    });
});
