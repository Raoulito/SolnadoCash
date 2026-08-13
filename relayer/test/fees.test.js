// relayer/test/fees.test.js
// Unit tests for fee computation

import { strict as assert } from "node:assert";
import {
  computeRelayerFeeMax,
  computeRelayerCost,
  getNullifierRent,
  NULLIFIER_ACCOUNT_SIZE,
  computeTreasuryFee,
  computeMinUserReceives,
  getPriorityFeePerCU,
  priorityFeeLamports,
  BASE_FEE,
  COMPUTE_UNITS,
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

  describe("priorityFeeLamports (H-3 unit conversion)", () => {
    it("converts micro-lamports/CU to lamports (divides by 1e6)", () => {
      // 1,000 µL/CU over 200,000 CU = 200,000,000 µL = 200 lamports.
      assert.equal(priorityFeeLamports(1_000), 200);
    });

    it("zero priority fee costs nothing", () => {
      assert.equal(priorityFeeLamports(0), 0);
    });

    it("does not inflate the fee by 1e6", () => {
      // The bug computed priorityFeePerCU * COMPUTE_UNITS directly, so 1,000
      // µL/CU became 200,000,000 lamports (0.2 SOL) instead of 200.
      const buggy = 1_000 * COMPUTE_UNITS;
      assert.equal(buggy, 200_000_000);
      assert.ok(
        priorityFeeLamports(1_000) < buggy / 1_000_000 + 1,
        "must be ~1e6 smaller than the buggy value"
      );
    });

    it("a busy network still yields a fee far below a 1 SOL denomination", async () => {
      // 10,000 µL/CU is a genuinely congested network. The bug quoted 3.003 SOL
      // here, which exceeds a 1 SOL pool and made every withdrawal fail with
      // ArithmeticOverflow.
      const mockConnection = {
        getRecentPrioritizationFees: async () =>
          Array.from({ length: 10 }, () => ({ prioritizationFee: 10_000 })),
      };
      const fee = await computeRelayerFeeMax(mockConnection);
      assert.ok(
        fee < 1_000_000_000 / 100,
        `fee ${fee} should be well under 1% of a 1 SOL pool`
      );
      // cost = 5000 + ceil(10000*200000/1e6) + 2039280 = 2046280; *1.5 = 3069420
      assert.equal(fee, Math.ceil((BASE_FEE + 2_000 + NULLIFIER_RENT) * MARGIN));
    });
  });

  describe("getNullifierRent (M-6)", () => {
    it("reads the rent-exempt minimum for 80 bytes from the chain", async () => {
      let askedFor = null;
      const mockConnection = {
        getRecentPrioritizationFees: async () => [],
        getMinimumBalanceForRentExemption: async (size) => {
          askedFor = size;
          return 1_447_680;
        },
      };
      const rent = await getNullifierRent(mockConnection);
      assert.equal(askedFor, NULLIFIER_ACCOUNT_SIZE);
      assert.equal(NULLIFIER_ACCOUNT_SIZE, 80);
      assert.equal(rent, 1_447_680);
    });

    it("fallback constant is the real 80-byte rent, not the SPL token figure", () => {
      // (128 + 80) * 3480 * 2 = 1_447_680. The old value 2_039_280 is the rent for
      // a 165-byte SPL token account and over-charged by ~41% on this component.
      assert.equal(NULLIFIER_RENT, (128 + 80) * 3480 * 2);
      assert.notEqual(NULLIFIER_RENT, 2_039_280);
    });
  });

  describe("computeRelayerCost (H-3 honest charging)", () => {
    it("excludes the margin, so an honest relayer charges less than the ceiling", async () => {
      const mockConnection = {
        getRecentPrioritizationFees: async () =>
          Array.from({ length: 10 }, () => ({ prioritizationFee: 500 })),
      };
      const cost = await computeRelayerCost(mockConnection);
      const max = await computeRelayerFeeMax(mockConnection);
      assert.ok(cost < max, `cost ${cost} must be below ceiling ${max}`);
      assert.equal(max, Math.ceil(cost * MARGIN));
    });
  });

  describe("getPriorityFeePerCU", () => {
    it("returns the 90th percentile in micro-lamports/CU", async () => {
      const mockConnection = {
        getRecentPrioritizationFees: async () =>
          Array.from({ length: 10 }, (_, i) => ({
            prioritizationFee: (i + 1) * 100,
          })),
      };
      assert.equal(await getPriorityFeePerCU(mockConnection), 1000);
    });

    it("returns 0 when the RPC fails", async () => {
      const mockConnection = {
        getRecentPrioritizationFees: async () => {
          throw new Error("RPC error");
        },
      };
      assert.equal(await getPriorityFeePerCU(mockConnection), 0);
    });
  });
});
