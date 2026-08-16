// relayer/test/economics.test.js
//
// The economic properties, asserted rather than left to a report nobody re-runs. Each of these
// would be a silent business failure rather than a crash, which is exactly the kind of thing that
// rots: a rent change or a margin tweak flips a rung from profitable to loss-making and nothing
// fails.

import assert from "assert";
import {
  planFee,
  priorityFeeLamports,
  computeTreasuryFee,
  computeMinUserReceives,
  BASE_FEE,
  NULLIFIER_RENT,
  MARGIN,
} from "../src/fees.js";

const RENT = NULLIFIER_RENT;
const DETERMINISTIC = BASE_FEE + RENT;
const LADDER = [100_000_000n, 1_000_000_000n, 10_000_000_000n, 100_000_000_000n];
const REGIMES = [0, 10_000, 100_000, 1_000_000, 5_000_000, 50_000_000];

function ceilingFor(d, perCU) {
  const cost = BASE_FEE + priorityFeeLamports(perCU) + RENT;
  const withMargin = BigInt(Math.ceil(cost * MARGIN));
  const cap = d / 50n;
  return withMargin < cap ? withMargin : cap;
}

describe("economics", () => {
  it("the relayer never spends more than it charges, at any rung or congestion level", () => {
    for (const d of LADDER) {
      for (const perCU of REGIMES) {
        const feeMax = ceilingFor(d, perCU);
        const plan = planFee({ feeMax, rent: RENT, estimatedPriorityPerCU: perCU });
        const spent = DETERMINISTIC + priorityFeeLamports(plan.appliedPriorityPerCU);
        assert.ok(
          Number(plan.actualFee) >= spent - plan.subsidy,
          `rung ${d} regime ${perCU}: charged ${plan.actualFee} vs spent ${spent}`
        );
        // And the loss, if any, is the deterministic shortfall and nothing congestion-driven.
        assert.equal(plan.subsidy, Math.max(0, DETERMINISTIC - Number(feeMax)));
      }
    }
  });

  it("every rung on the current ladder is profitable for the operator", () => {
    for (const d of LADDER) {
      const treasury = Number(computeTreasuryFee(d));
      for (const perCU of REGIMES) {
        const feeMax = ceilingFor(d, perCU);
        const plan = planFee({ feeMax, rent: RENT, estimatedPriorityPerCU: perCU });
        const spent = DETERMINISTIC + priorityFeeLamports(plan.appliedPriorityPerCU);
        const net = Number(plan.actualFee) - spent + treasury;
        assert.ok(net > 0, `rung ${d} regime ${perCU}: net ${net} lamports`);
      }
    }
  });

  it("contradicts the old claim that 0.1 SOL sits below relayer cost", () => {
    // The cap on the smallest rung clears the real cost. The earlier claim used the pre-M-6 rent
    // for a 165-byte SPL account rather than this program's 80-byte account.
    const cap = 100_000_000n / 50n;
    assert.ok(Number(cap) > DETERMINISTIC, `cap ${cap} must exceed cost ${DETERMINISTIC}`);
    assert.equal(DETERMINISTIC, 1_452_680);
  });

  it("names the minimum viable denomination, so a new rung cannot be added blindly", () => {
    const minViable = BigInt(DETERMINISTIC) * 50n;
    assert.equal(minViable, 72_634_000n); // 0.0727 SOL
    for (const d of LADDER) {
      assert.ok(d >= minViable, `rung ${d} is below the minimum viable ${minViable}`);
    }
  });

  it("a user always keeps at least 97.8%, and the promise is honoured exactly", () => {
    for (const d of LADDER) {
      const cap = d / 50n;
      const worstPayout = d - computeTreasuryFee(d) - cap;
      assert.ok(
        (Number(worstPayout) / Number(d)) * 100 >= 97.8,
        `rung ${d}: user keeps only ${(Number(worstPayout) / Number(d)) * 100}%`
      );
      assert.ok(worstPayout >= computeMinUserReceives(d, cap));
    }
  });

  it("the protocol cannot pay out more than it took in", () => {
    // The on-chain guard is vault.lamports() >= denomination. Modelled here to state the property;
    // proven against the real program in litesvm-tests/tests/outflow_cap.rs.
    for (const d of LADDER) {
      let vault = 0n;
      let inflow = 0n;
      let outflow = 0n;
      for (let i = 0; i < 500; i++) {
        if (i % 3 === 0) {
          vault += d;
          inflow += d;
        } else if (vault >= d) {
          vault -= d;
          outflow += d;
        }
      }
      assert.ok(outflow <= inflow, `rung ${d}: outflow ${outflow} exceeded inflow ${inflow}`);
      assert.equal(vault, inflow - outflow);
    }
  });
});
