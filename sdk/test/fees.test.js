"use strict";
// sdk/test/fees.test.ts
// T34 — Tests for fee utilities
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = require("node:assert");
const web3_js_1 = require("@solana/web3.js");
const fees_js_1 = require("../src/fees.js");
describe("T34 — sdk/src/fees.ts", function () {
    // ── computeTreasuryFee ──────────────────────────────────────────────────
    describe("computeTreasuryFee", () => {
        it("1 SOL pool → 0.002 SOL treasury fee", () => {
            const denom = 1000000000n; // 1 SOL
            const fee = (0, fees_js_1.computeTreasuryFee)(denom);
            node_assert_1.strict.equal(fee, 2000000n); // 0.002 SOL
        });
        it("0.1 SOL pool → 200_000 lamports", () => {
            const fee = (0, fees_js_1.computeTreasuryFee)(100000000n);
            node_assert_1.strict.equal(fee, 200000n);
        });
        it("10 SOL pool → 0.02 SOL", () => {
            const fee = (0, fees_js_1.computeTreasuryFee)(10000000000n);
            node_assert_1.strict.equal(fee, 20000000n);
        });
        it("minimum denomination (500) → fee = 1", () => {
            const fee = (0, fees_js_1.computeTreasuryFee)(500n);
            node_assert_1.strict.equal(fee, 1n);
        });
        it("exact 0.2% via integer division", () => {
            // 999 / 500 = 1 (integer division, not 1.998)
            const fee = (0, fees_js_1.computeTreasuryFee)(999n);
            node_assert_1.strict.equal(fee, 1n);
        });
        it("throws for denomination < 500 (BF-14)", () => {
            node_assert_1.strict.throws(() => (0, fees_js_1.computeTreasuryFee)(499n), /Denomination must be >= 500/);
            node_assert_1.strict.throws(() => (0, fees_js_1.computeTreasuryFee)(0n), /Denomination must be >= 500/);
        });
        it("handles large denomination without overflow", () => {
            // u64 max ≈ 18.4 * 10^18
            const bigDenom = 18000000000000000000n;
            const fee = (0, fees_js_1.computeTreasuryFee)(bigDenom);
            node_assert_1.strict.equal(fee, bigDenom / 500n);
        });
    });
    // ── computeMinUserReceives ──────────────────────────────────────────────
    describe("computeMinUserReceives", () => {
        const makeQuote = (relayerFeeMax) => ({
            relayerAddress: web3_js_1.Keypair.generate().publicKey,
            relayerFeeMax,
            validUntil: Date.now() + 30000,
            estimatedUserReceives: 0n, // not used by computeMinUserReceives
        });
        it("1 SOL pool, typical relayer fee", () => {
            const denom = 1000000000n;
            const quote = makeQuote(83000n);
            const userReceives = (0, fees_js_1.computeMinUserReceives)(denom, quote);
            // 1_000_000_000 - 2_000_000 - 83_000 = 997_917_000
            node_assert_1.strict.equal(userReceives, 997917000n);
        });
        it("deducts both treasury and relayer fees", () => {
            const denom = 10000000000n; // 10 SOL
            const quote = makeQuote(150000n);
            const treasury = (0, fees_js_1.computeTreasuryFee)(denom); // 20_000_000
            const expected = denom - treasury - 150000n;
            node_assert_1.strict.equal((0, fees_js_1.computeMinUserReceives)(denom, quote), expected);
        });
        it("zero relayer fee → only treasury deducted", () => {
            const denom = 1000000000n;
            const quote = makeQuote(0n);
            const userReceives = (0, fees_js_1.computeMinUserReceives)(denom, quote);
            node_assert_1.strict.equal(userReceives, denom - 2000000n);
        });
    });
    // ── getFeeQuote ─────────────────────────────────────────────────────────
    describe("getFeeQuote", () => {
        const pool = web3_js_1.Keypair.generate().publicKey;
        const relayerPubkey = web3_js_1.Keypair.generate().publicKey;
        // Mock fetch globally for these tests
        let originalFetch;
        beforeEach(() => {
            originalFetch = globalThis.fetch;
        });
        afterEach(() => {
            globalThis.fetch = originalFetch;
        });
        it("parses a valid relayer response", async () => {
            const validUntil = Date.now() + 30000;
            globalThis.fetch = async () => new Response(JSON.stringify({
                relayerAddress: relayerPubkey.toBase58(),
                relayerFeeMax: "83000",
                validUntil,
                estimatedUserReceives: "997917000",
                treasuryFee: "2000000",
                denomination: "1000000000",
            }), { status: 200, headers: { "Content-Type": "application/json" } });
            const quote = await (0, fees_js_1.getFeeQuote)("http://localhost:3000", pool);
            node_assert_1.strict.equal(quote.relayerAddress.toBase58(), relayerPubkey.toBase58());
            node_assert_1.strict.equal(quote.relayerFeeMax, 83000n);
            node_assert_1.strict.equal(quote.validUntil, validUntil);
            node_assert_1.strict.equal(quote.estimatedUserReceives, 997917000n);
        });
        it("strips trailing slash from relayer URL", async () => {
            let capturedUrl = "";
            const validUntil = Date.now() + 30000;
            globalThis.fetch = async (input) => {
                capturedUrl = typeof input === "string" ? input : input.url;
                return new Response(JSON.stringify({
                    relayerAddress: relayerPubkey.toBase58(),
                    relayerFeeMax: "0",
                    validUntil,
                    estimatedUserReceives: "0",
                }), { status: 200, headers: { "Content-Type": "application/json" } });
            };
            await (0, fees_js_1.getFeeQuote)("http://localhost:3000///", pool);
            node_assert_1.strict.ok(capturedUrl.startsWith("http://localhost:3000/fee_quote"), `URL should not have double slashes: ${capturedUrl}`);
        });
        it("throws on HTTP error", async () => {
            globalThis.fetch = async () => new Response(JSON.stringify({ error: "PoolNotFound" }), {
                status: 404,
                headers: { "Content-Type": "application/json" },
            });
            await node_assert_1.strict.rejects(() => (0, fees_js_1.getFeeQuote)("http://localhost:3000", pool), /Relayer fee_quote failed \(404\): PoolNotFound/);
        });
        it("throws on expired quote", async () => {
            globalThis.fetch = async () => new Response(JSON.stringify({
                relayerAddress: relayerPubkey.toBase58(),
                relayerFeeMax: "83000",
                validUntil: Date.now() - 1000, // already expired
                estimatedUserReceives: "997917000",
            }), { status: 200, headers: { "Content-Type": "application/json" } });
            await node_assert_1.strict.rejects(() => (0, fees_js_1.getFeeQuote)("http://localhost:3000", pool), /Fee quote already expired/);
        });
    });
});
