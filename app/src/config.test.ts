// app/src/config.test.ts
//
// The pool ladder is duplicated in three places by necessity — this config, the deploy script,
// and the monitor's env list — and scripts/check_pools.js scrapes THIS file with a regex to
// verify on-chain state. So the shape here is load-bearing: a malformed entry silently drops a
// pool from the treasury audit rather than failing loudly.

import { describe, expect, it } from 'vitest';
import { POOLS } from './config';

const EXPECTED_LADDER = [0.1, 1, 10, 100];

describe('denomination ladder', () => {
  it('has every rung, in ascending order', () => {
    expect(POOLS.map((p) => p.denominationSol)).toEqual(EXPECTED_LADDER);
  });

  it('states lamports that match the SOL figure exactly', () => {
    // Float arithmetic must not creep into an on-chain amount: the deposit has to equal the
    // pool's denomination to the lamport or the transaction fails.
    for (const p of POOLS) {
      expect(p.denominationLamports).toBe(
        BigInt(Math.round(p.denominationSol * 1e9))
      );
      expect(p.denominationLamports % 1n).toBe(0n);
    }
  });

  it('clears the on-chain denomination floor on every rung', () => {
    // initialize_pool rejects a denomination whose worst-case payout falls below
    // Rent::minimum_balance(0) (~890,880 lamports), because a fresh recipient account must be
    // left rent-exempt.
    const RENT_MIN = 890_880n;
    for (const p of POOLS) {
      const worstCase =
        p.denominationLamports -
        p.denominationLamports / 500n -
        p.denominationLamports / 50n;
      expect(worstCase).toBeGreaterThanOrEqual(RENT_MIN);
    }
  });

  it('has a unique address and label per rung', () => {
    const addresses = POOLS.map((p) => p.address);
    const labels = POOLS.map((p) => p.label);
    expect(new Set(addresses).size).toBe(POOLS.length);
    expect(new Set(labels).size).toBe(POOLS.length);
  });

  it('uses plausible base58 addresses, since check_pools.js scrapes them', () => {
    for (const p of POOLS) {
      expect(p.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }
  });

  it('keeps the ladder narrow enough that rungs can actually fill', () => {
    // A rung only hides anyone once it holds ~50+ deposits, so the count of rungs is bounded
    // by liquidity. This is a deliberate design constraint, not an oversight: see the comment
    // in config.ts for the staged growth plan.
    expect(POOLS.length).toBeLessThanOrEqual(4);
  });

  it('documents that the proportional fee cap is below cost at the bottom rung', () => {
    // The cap is denomination/50 while a relayer's real cost is ~0.003 SOL at any size, so on
    // the 0.1 SOL rung the cap sits BELOW cost and relayers subsidise the withdrawal. This is
    // why the withdraw screen warns on the ABSOLUTE fee rather than the percentage, and why a
    // floor/ceiling cap shape is still owed.
    const REAL_COST = 3_000_000n; // ~0.003 SOL
    expect(POOLS[0].denominationLamports / 50n).toBeLessThan(REAL_COST);
  });
});
