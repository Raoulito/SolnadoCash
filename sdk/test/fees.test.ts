// sdk/test/fees.test.ts
// T34 — Tests for fee utilities

import { strict as assert } from "node:assert";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  computeTreasuryFee,
  computeMinUserReceives,
  getFeeQuote,
  FeeQuote,
} from "../src/fees.js";

describe("T34 — sdk/src/fees.ts", function () {
  // ── computeTreasuryFee ──────────────────────────────────────────────────

  describe("computeTreasuryFee", () => {
    it("1 SOL pool → 0.002 SOL treasury fee", () => {
      const denom = 1_000_000_000n; // 1 SOL
      const fee = computeTreasuryFee(denom);
      assert.equal(fee, 2_000_000n); // 0.002 SOL
    });

    it("0.1 SOL pool → 200_000 lamports", () => {
      const fee = computeTreasuryFee(100_000_000n);
      assert.equal(fee, 200_000n);
    });

    it("10 SOL pool → 0.02 SOL", () => {
      const fee = computeTreasuryFee(10_000_000_000n);
      assert.equal(fee, 20_000_000n);
    });

    it("minimum denomination (500) → fee = 1", () => {
      const fee = computeTreasuryFee(500n);
      assert.equal(fee, 1n);
    });

    it("exact 0.2% via integer division", () => {
      // 999 / 500 = 1 (integer division, not 1.998)
      const fee = computeTreasuryFee(999n);
      assert.equal(fee, 1n);
    });

    it("throws for denomination < 500 (BF-14)", () => {
      assert.throws(
        () => computeTreasuryFee(499n),
        /Denomination must be >= 500/
      );
      assert.throws(
        () => computeTreasuryFee(0n),
        /Denomination must be >= 500/
      );
    });

    it("handles large denomination without overflow", () => {
      // u64 max ≈ 18.4 * 10^18
      const bigDenom = 18_000_000_000_000_000_000n;
      const fee = computeTreasuryFee(bigDenom);
      assert.equal(fee, bigDenom / 500n);
    });
  });

  // ── computeMinUserReceives ──────────────────────────────────────────────

  describe("computeMinUserReceives", () => {
    const makeQuote = (relayerFeeMax: bigint): FeeQuote => ({
      relayerAddress: Keypair.generate().publicKey,
      relayerFeeMax,
      validUntil: Date.now() + 30_000,
      estimatedUserReceives: 0n, // not used by computeMinUserReceives
    });

    it("1 SOL pool, typical relayer fee", () => {
      const denom = 1_000_000_000n;
      const quote = makeQuote(83_000n);
      const userReceives = computeMinUserReceives(denom, quote);
      // 1_000_000_000 - 2_000_000 - 83_000 = 997_917_000
      assert.equal(userReceives, 997_917_000n);
    });

    it("deducts both treasury and relayer fees", () => {
      const denom = 10_000_000_000n; // 10 SOL
      const quote = makeQuote(150_000n);
      const treasury = computeTreasuryFee(denom); // 20_000_000
      const expected = denom - treasury - 150_000n;
      assert.equal(computeMinUserReceives(denom, quote), expected);
    });

    it("zero relayer fee → only treasury deducted", () => {
      const denom = 1_000_000_000n;
      const quote = makeQuote(0n);
      const userReceives = computeMinUserReceives(denom, quote);
      assert.equal(userReceives, denom - 2_000_000n);
    });
  });

  // ── getFeeQuote ─────────────────────────────────────────────────────────

  describe("getFeeQuote", () => {
    const pool = Keypair.generate().publicKey;
    const relayerPubkey = Keypair.generate().publicKey;

    // Mock fetch globally for these tests
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("parses a valid relayer response", async () => {
      const validUntil = Date.now() + 30_000;
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            relayerAddress: relayerPubkey.toBase58(),
            relayerFeeMax: "83000",
            validUntil,
            estimatedUserReceives: "997917000",
            treasuryFee: "2000000",
            denomination: "1000000000",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );

      const quote = await getFeeQuote("http://localhost:3000", pool);

      assert.equal(quote.relayerAddress.toBase58(), relayerPubkey.toBase58());
      assert.equal(quote.relayerFeeMax, 83_000n);
      assert.equal(quote.validUntil, validUntil);
      assert.equal(quote.estimatedUserReceives, 997_917_000n);
    });

    it("strips trailing slash from relayer URL", async () => {
      let capturedUrl = "";
      const validUntil = Date.now() + 30_000;
      globalThis.fetch = async (input: any) => {
        capturedUrl = typeof input === "string" ? input : input.url;
        return new Response(
          JSON.stringify({
            relayerAddress: relayerPubkey.toBase58(),
            relayerFeeMax: "0",
            validUntil,
            estimatedUserReceives: "0",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      await getFeeQuote("http://localhost:3000///", pool);
      assert.ok(
        capturedUrl.startsWith("http://localhost:3000/fee_quote"),
        `URL should not have double slashes: ${capturedUrl}`
      );
    });

    it("throws on HTTP error", async () => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: "PoolNotFound" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });

      await assert.rejects(
        () => getFeeQuote("http://localhost:3000", pool),
        /Relayer fee_quote failed \(404\): PoolNotFound/
      );
    });

    it("throws on expired quote", async () => {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            relayerAddress: relayerPubkey.toBase58(),
            relayerFeeMax: "83000",
            validUntil: Date.now() - 1000, // already expired
            estimatedUserReceives: "997917000",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );

      await assert.rejects(
        () => getFeeQuote("http://localhost:3000", pool),
        /Fee quote already expired/
      );
    });
  });
});
