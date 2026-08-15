// relayer/test/planfee.test.js
//
// `relayer_fee_max` is frozen into the ZK proof when the user requests a quote, but the transaction
// is submitted 30 to 90 seconds later, after proof generation. Congestion can rise in between.
//
// The old behaviour clamped what the relayer CHARGED to the ceiling while still attaching the full
// estimated priority fee, so the relayer paid the difference out of pocket with no bound. That is an
// economic drain: sustained congestion, or an attacker inducing it, bleeds the relayer to
// insolvency, and an insolvent relayer is worse than a slow one because users are then forced to
// self-relay and lose the privacy they came for.
//
// The property these tests pin: the relayer's unrecoverable loss is BOUNDED by a known constant
// (the deterministic shortfall on small denominations) and is never a function of congestion.

import assert from "assert";
import { planFee, priorityPerCUFromLamports, BASE_FEE } from "../src/fees.js";

const RENT = 1_447_680;            // nullifier PDA rent, 80 bytes
const DETERMINISTIC = BASE_FEE + RENT;
const CU = 200_000;                 // must match COMPUTE_UNITS in fees.js

/** Lamports that a given per-CU price costs over the whole budget. */
const lamportsFor = (perCU) => Math.ceil((perCU * CU) / 1_000_000);

describe("planFee", () => {
  it("charges exactly what it spends when the ceiling has headroom", () => {
    const feeMax = 2_179_020n; // the 1 SOL quote: cost x 1.5
    const estimated = 1_000;   // uL/CU -> 200 lamports over the budget
    const r = planFee({ feeMax, rent: RENT, estimatedPriorityPerCU: estimated });

    assert.equal(r.degraded, false);
    assert.equal(r.subsidy, 0);
    assert.equal(r.appliedPriorityPerCU, estimated);
    assert.equal(r.actualFee, BigInt(DETERMINISTIC + lamportsFor(estimated)));
    assert.ok(r.actualFee < feeMax, "charge must stay under the ceiling");
  });

  it("caps the priority fee at what the ceiling can reimburse, rather than paying the excess", () => {
    const feeMax = 2_000_000n;                  // 0.1 SOL rung cap
    const budget = Number(feeMax) - DETERMINISTIC; // 547,320 lamports for priority
    // A price must exceed budget/CU x 1e6 to be unaffordable. 547,320 lamports over a 200k CU
    // budget is ~2,736,600 uL/CU, so this is comfortably past it. (My first attempt used 500,000
    // uL/CU, which only costs 100,000 lamports and was well WITHIN budget: the arithmetic runs
    // perCU x CU / 1e6, not perCU x CU.)
    const outrageous = 5_000_000;               // uL/CU -> 1,000,000 lamports

    const r = planFee({ feeMax, rent: RENT, estimatedPriorityPerCU: outrageous });

    assert.equal(r.degraded, true, "must report that it degraded");
    assert.ok(r.shortfall > 0);
    // It applies at most what the budget affords, never the estimate.
    assert.ok(
      lamportsFor(r.appliedPriorityPerCU) <= budget,
      `applied ${lamportsFor(r.appliedPriorityPerCU)} exceeds budget ${budget}`
    );
    // And it never charges above the ceiling.
    assert.ok(r.actualFee <= feeMax);
    // Crucially: no unbounded loss. The loss is zero here because the ceiling covers the
    // deterministic cost.
    assert.equal(r.subsidy, 0);
  });

  it("attaches no priority fee when the ceiling covers only the fixed costs", () => {
    // Exactly zero slack. Note that even 10 lamports of slack buys 50 uL/CU over a 200k budget,
    // so "barely covers" has to mean precisely zero to yield a zero price.
    const feeMax = BigInt(DETERMINISTIC);
    const r = planFee({ feeMax, rent: RENT, estimatedPriorityPerCU: 50_000 });

    assert.equal(r.appliedPriorityPerCU, 0, "cannot afford any priority fee");
    assert.equal(r.actualFee, BigInt(DETERMINISTIC));
    assert.equal(r.subsidy, 0);
    assert.equal(r.degraded, true);
  });

  it("keeps the small-denomination subsidy, but bounded and independent of congestion", () => {
    // A ceiling BELOW the deterministic cost. This is the N-1 situation: the 2% cap does not cover
    // signature fee plus rent, and the project's choice is to subsidise rather than refuse, because
    // refusing pushes the user into self-relaying.
    const feeMax = BigInt(DETERMINISTIC - 200_000);

    const calm = planFee({ feeMax, rent: RENT, estimatedPriorityPerCU: 0 });
    const storm = planFee({ feeMax, rent: RENT, estimatedPriorityPerCU: 5_000_000 });

    // Charge is clamped to the ceiling either way, so the withdrawal still lands.
    assert.equal(calm.actualFee, feeMax);
    assert.equal(storm.actualFee, feeMax);

    // The subsidy is the deterministic shortfall and NOTHING more. Congestion does not change it.
    assert.equal(calm.subsidy, 200_000);
    assert.equal(
      storm.subsidy,
      calm.subsidy,
      "a congestion spike must not increase the relayer's loss"
    );
    assert.equal(storm.appliedPriorityPerCU, 0, "no priority fee it cannot recover");
  });

  it("never spends more than the budget through per-CU rounding", () => {
    // Rounding a lamport budget into a per-CU price must round DOWN, or the applied price costs
    // more than the budget and the loss creeps back in.
    for (const budget of [1, 199, 200, 201, 12_345, 547_320]) {
      const perCU = priorityPerCUFromLamports(budget);
      assert.ok(
        lamportsFor(perCU) <= budget,
        `budget ${budget} -> ${perCU} uL/CU costs ${lamportsFor(perCU)}`
      );
    }
  });

  it("treats a zero or negative priority budget as zero, not as a negative price", () => {
    assert.equal(priorityPerCUFromLamports(0), 0);
    assert.equal(priorityPerCUFromLamports(-5_000), 0);
  });
});
