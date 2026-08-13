// sdk/test/fees.test.ts
// T34 — Tests for fee utilities

import { strict as assert } from "node:assert";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  computeTreasuryFee,
  computeMinUserReceives,
  getFeeQuote,
  validateFeeQuote,
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

  describe("getFeeQuote expiry", () => {
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

  describe("validateFeeQuote (H-4)", () => {
    const DENOM = 1_000_000_000n; // 1 SOL
    const TREASURY = 2_000_000n;
    const relayer = Keypair.generate().publicKey;

    function quote(overrides: Partial<FeeQuote> = {}): FeeQuote {
      const relayerFeeMax = overrides.relayerFeeMax ?? 3_066_420n;
      return {
        relayerAddress: relayer,
        relayerFeeMax,
        validUntil: Date.now() + 30_000,
        estimatedUserReceives: DENOM - TREASURY - relayerFeeMax,
        ...overrides,
      };
    }

    it("derives every figure locally from the denomination", () => {
      const b = validateFeeQuote(DENOM, quote());
      assert.equal(b.treasuryFee, TREASURY);
      assert.equal(b.relayerFeeMax, 3_066_420n);
      assert.equal(b.userReceivesMin, DENOM - TREASURY - 3_066_420n);
      assert.equal(b.denomination, DENOM);
      assert.ok(b.relayerFeePct > 0.3 && b.relayerFeePct < 0.31);
    });

    it("rejects a fee above the on-chain cap (2%)", () => {
      // The 1e6 unit bug quoted 0.303 SOL on a 1 SOL pool — 30%.
      assert.throws(
        () => validateFeeQuote(DENOM, quote({ relayerFeeMax: 303_066_420n })),
        /exceeds the maximum/
      );
    });

    it("accepts a fee exactly at the cap", () => {
      const cap = DENOM / 50n;
      const b = validateFeeQuote(DENOM, quote({ relayerFeeMax: cap }));
      assert.equal(b.relayerFeeMax, cap);
      assert.equal(b.relayerFeePct, 2);
    });

    it("rejects a relayer that misreports what the user receives", () => {
      // Honest ceiling, dishonest headline figure.
      assert.throws(
        () =>
          validateFeeQuote(
            DENOM,
            quote({ relayerFeeMax: 19_000_000n, estimatedUserReceives: 997_000_000n })
          ),
        /inconsistent/
      );
    });

    it("rejects an expired quote", () => {
      assert.throws(
        () => validateFeeQuote(DENOM, quote({ validUntil: Date.now() - 1 })),
        /expired/
      );
    });

    it("rejects a negative fee", () => {
      assert.throws(
        () => validateFeeQuote(DENOM, quote({ relayerFeeMax: -1n })),
        /negative/
      );
    });

    it("honours a stricter caller-supplied ceiling", () => {
      assert.throws(
        () =>
          validateFeeQuote(DENOM, quote({ relayerFeeMax: 3_066_420n }), {
            maxRelayerFee: 1_000_000n,
          }),
        /exceeds the maximum/
      );
    });

    it("guarantees the user keeps at least 97.8% at the cap", () => {
      const b = validateFeeQuote(DENOM, quote({ relayerFeeMax: DENOM / 50n }));
      const kept = Number(b.userReceivesMin) / Number(DENOM);
      assert.ok(kept >= 0.978, `user kept ${kept}`);
    });
  });
});
