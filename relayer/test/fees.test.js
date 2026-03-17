// relayer/test/fees.test.js
// Unit tests for fee computation

import { strict as assert } from "node:assert";
import {
  computeRelayerFeeMax,
  computeTreasuryFee,
  computeMinUserReceives,
  BASE_FEE,
  NULLIFIER_RENT,
  MARGIN,
} from "../src/fees.js";

describe("fees", () => {
  describe("computeTreasuryFee", () => {
    it("returns denomination / 500 for 1 SOL", () => {
      const fee = computeTreasuryFee(1_000_000_000n);
      assert.equal(fee, 2_000_000n);
    });

    it("returns denomination / 500 for 10 SOL", () => {
      const fee = computeTreasuryFee(10_000_000_000n);
      assert.equal(fee, 20_000_000n);
    });

    it("returns 0 for denomination < 500", () => {
      // Integer division: 499 / 500 = 0
      const fee = computeTreasuryFee(499n);
      assert.equal(fee, 0n);
    });
  });

  describe("computeMinUserReceives", () => {
    it("computes denomination - treasury - relayerFeeMax", () => {
      const denomination = 1_000_000_000n;
      const relayerFeeMax = 83_000n;
      const result = computeMinUserReceives(denomination, relayerFeeMax);
      assert.equal(result, 997_917_000n);
    });

    it("fee invariant: treasury + relayer + user = denomination", () => {
      const denomination = 1_000_000_000n;
      const relayerFeeMax = 83_000n;
      const treasury = computeTreasuryFee(denomination);
      const user = computeMinUserReceives(denomination, relayerFeeMax);
      assert.equal(treasury + relayerFeeMax + user, denomination);
    });
  });

  describe("computeRelayerFeeMax", () => {
    it("returns at least (BASE_FEE + NULLIFIER_RENT) * MARGIN with zero priority", async () => {
      // Mock connection that returns empty fees
      const mockConnection = {
        getRecentPrioritizationFees: async () => [],
      };
      const fee = await computeRelayerFeeMax(mockConnection);
      const expected = Math.ceil((BASE_FEE + NULLIFIER_RENT) * MARGIN);
      assert.equal(fee, expected);
    });

    it("includes priority fee in calculation", async () => {
      const mockConnection = {
        getRecentPrioritizationFees: async () =>
          Array.from({ length: 10 }, (_, i) => ({
            prioritizationFee: (i + 1) * 100,
          })),
      };
      const fee = await computeRelayerFeeMax(mockConnection);
      // Should be higher than base-only fee
      const baseFee = Math.ceil((BASE_FEE + NULLIFIER_RENT) * MARGIN);
      assert.ok(fee > baseFee, `${fee} should be > ${baseFee}`);
    });

    it("handles RPC failure gracefully", async () => {
      const mockConnection = {
        getRecentPrioritizationFees: async () => {
          throw new Error("RPC error");
        },
      };
      const fee = await computeRelayerFeeMax(mockConnection);
      const expected = Math.ceil((BASE_FEE + NULLIFIER_RENT) * MARGIN);
      assert.equal(fee, expected);
    });
  });
});
