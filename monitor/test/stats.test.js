// monitor/test/stats.test.js
import { strict as assert } from "node:assert";
import { actionsInTransaction, tally, DEPOSIT_DISCRIMINATOR, WITHDRAW_DISCRIMINATOR } from "../src/stats.js";

const PROGRAM = "DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59";
const POOL_A = "PoolA111111111111111111111111111111111111111";
const POOL_B = "PoolB111111111111111111111111111111111111111";
const VAULT = "Vau1t11111111111111111111111111111111111111";
const ALICE = "A1ice11111111111111111111111111111111111111";
const BOB = "Bob1111111111111111111111111111111111111111";
const ME = "Me11111111111111111111111111111111111111111";
const RELAYER = "Re1ayer1111111111111111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";

// Instruction data is passed as a JSON array string here; the decoder turns it back into bytes.
const enc = (bytes) => JSON.stringify([...bytes]);
const decode = (s) => Uint8Array.from(JSON.parse(s));
const depositData = enc([...DEPOSIT_DISCRIMINATOR, ...new Uint8Array(32)]);
const withdrawData = enc([...WITHDRAW_DISCRIMINATOR, ...new Uint8Array(368)]);

/** A transaction in getTransaction's "json" shape. */
function tx({ keys, instructions, inner = [], err = null, loaded, blockTime = 1_000 }) {
  return {
    blockTime,
    transaction: { message: { accountKeys: keys, instructions } },
    meta: { err, innerInstructions: inner, ...(loaded ? { loadedAddresses: loaded } : {}) },
  };
}
const deposit = (pool, who, blockTime = 1_000) =>
  tx({ blockTime, keys: [who, pool, VAULT, SYSTEM, PROGRAM],
       instructions: [{ programIdIndex: 4, accounts: [1, 2, 0, 3], data: depositData }] });
const withdrawal = (pool, blockTime = 1_000) =>
  tx({ blockTime, keys: [RELAYER, pool, VAULT, "Nu11", "Rec", "Trea", SYSTEM, PROGRAM],
       instructions: [{ programIdIndex: 7, accounts: [1, 2, 3, 4, 5, 0, 6], data: withdrawData }] });

describe("beta stats: reading pool actions from transactions", () => {
  it("reads a deposit's pool and depositor, and a withdrawal's pool", () => {
    assert.deepEqual(actionsInTransaction(deposit(POOL_A, ALICE), PROGRAM, decode), [
      { kind: "deposit", pool: POOL_A, depositor: ALICE },
    ]);
    assert.deepEqual(actionsInTransaction(withdrawal(POOL_B), PROGRAM, decode), [{ kind: "withdraw", pool: POOL_B }]);
  });

  it("ignores failed transactions and other programs' instructions", () => {
    const failed = deposit(POOL_A, ALICE);
    failed.meta.err = { InstructionError: [0, { Custom: 6004 }] };
    assert.deepEqual(actionsInTransaction(failed, PROGRAM, decode), []);
    const other = deposit(POOL_A, ALICE);
    other.transaction.message.instructions[0].programIdIndex = 3; // the system program
    assert.deepEqual(actionsInTransaction(other, PROGRAM, decode), []);
  });

  it("finds deposits made through another program (inner instructions) and lookup tables", () => {
    const viaCpi = tx({
      keys: [ALICE, "SomeRouter1111111111111111111111111111111111", SYSTEM],
      instructions: [{ programIdIndex: 1, accounts: [], data: enc([1]) }],
      inner: [{ index: 0, instructions: [{ programIdIndex: 5, accounts: [3, 4, 0, 2], data: depositData }] }],
      loaded: { writable: [POOL_A, VAULT], readonly: [PROGRAM] },
    });
    assert.deepEqual(actionsInTransaction(viaCpi, PROGRAM, decode), [{ kind: "deposit", pool: POOL_A, depositor: ALICE }]);
  });
});

describe("beta stats: totals", () => {
  const pools = { [POOL_A]: "0.1 SOL", [POOL_B]: "1 SOL" };
  const rec = (t) => ({ blockTime: t.blockTime, actions: actionsInTransaction(t, PROGRAM, decode) });

  it("counts deposits, withdrawals and distinct depositing wallets per pool and overall", () => {
    const s = tally(
      [deposit(POOL_A, ALICE), deposit(POOL_A, ALICE), deposit(POOL_A, BOB), deposit(POOL_B, ALICE), withdrawal(POOL_A)].map(rec),
      { pools }
    );
    assert.deepEqual(s.rows, [
      { pool: POOL_A, label: "0.1 SOL", deposits: 3, withdrawals: 1, wallets: 2 },
      { pool: POOL_B, label: "1 SOL", deposits: 1, withdrawals: 0, wallets: 1 },
    ]);
    assert.deepEqual(s.total, { deposits: 4, withdrawals: 1, wallets: 2 });
  });

  it("counts only inside the window: from `since` included to `until` excluded", () => {
    const s = tally([deposit(POOL_A, ALICE, 99), deposit(POOL_A, BOB, 100), deposit(POOL_A, ME, 200)].map(rec),
      { pools, since: 100, until: 200 });
    assert.deepEqual(s.total, { deposits: 1, withdrawals: 0, wallets: 1 });
  });

  it("leaves out the project's own wallets, and says how many deposits that removed", () => {
    const s = tally([deposit(POOL_A, ME), deposit(POOL_A, ME), deposit(POOL_A, ALICE)].map(rec), { pools, exclude: [ME] });
    assert.deepEqual(s.total, { deposits: 1, withdrawals: 0, wallets: 1 });
    assert.equal(s.excludedDeposits, 2);
  });

  it("ignores actions on pools that are not being counted", () => {
    const s = tally([deposit("Elsewhere11111111111111111111111111111111111", ALICE)].map(rec), { pools });
    assert.deepEqual(s.total, { deposits: 0, withdrawals: 0, wallets: 0 });
  });
});
