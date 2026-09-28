// relayer/test/priorityfee.test.js
//
// L-9. The relayer estimated its priority fee with getRecentPrioritizationFees() and no accounts.
// Unscoped, the RPC reports the minimum fee that landed a transaction in each recent slot, which is
// 0 whenever any transaction got in for free. Measured on mainnet: all 150 slots 0, p90 0, while the
// same query scoped to a contended writable account returned non-zero fees in 135 of 150 slots (p90
// 12,810 uL/CU). So the relayer attached no priority fee and its withdrawals could expire under
// load. A withdrawal write-locks the pool's vault and the relayer, so the estimate must be scoped to
// the accounts the transaction will actually contend for.

import { strict as assert } from "node:assert";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getPriorityFeePerCU, computeRelayerCost, computeRelayerFeeMax } from "../src/fees.js";

function recordingConnection(fees) {
  const calls = [];
  return {
    calls,
    getRecentPrioritizationFees: async (config) => {
      calls.push(config);
      return fees;
    },
    getMinimumBalanceForRentExemption: async () => 1_447_680,
  };
}

const vault = Keypair.generate().publicKey;
const relayer = Keypair.generate().publicKey;
const slots = (xs) => xs.map((prioritizationFee, i) => ({ slot: i, prioritizationFee }));

describe("L-9 — the priority fee is estimated for the accounts a withdrawal locks", () => {
  it("asks the RPC for fees on the vault and relayer, not the whole cluster", async () => {
    const c = recordingConnection(slots([0, 0, 0]));
    await getPriorityFeePerCU(c, [vault, relayer]);
    assert.equal(c.calls.length, 1);
    const locked = c.calls[0]?.lockedWritableAccounts?.map((k) => new PublicKey(k).toBase58());
    assert.deepEqual(locked?.sort(), [vault, relayer].map((k) => k.toBase58()).sort());
  });

  it("the quote and the cost estimate are scoped the same way", async () => {
    const c = recordingConnection(slots([10_000, 12_000, 13_000]));
    await computeRelayerCost(c, [vault, relayer]);
    await computeRelayerFeeMax(c, [vault, relayer]);
    assert.equal(c.calls.length, 2); // one estimate for the cost, one for the fee max
    for (const call of c.calls) assert.equal(call?.lockedWritableAccounts?.length, 2);
  });

  it("still takes the 90th percentile of what the scoped query returns", async () => {
    const fees = slots(Array.from({ length: 10 }, (_, i) => (i + 1) * 1_000));
    assert.equal(await getPriorityFeePerCU(recordingConnection(fees), [vault]), 10_000);
  });
});
