// monitor/src/stats.js
//
// Weekly beta numbers for the devnet launch (X plan, gate G6): deposits, withdrawals and the number of
// different wallets that deposited, per pool and in total, over a time window.
//
// Counted from the program's own instructions, not from logs or events: a deposit instruction is the
// program called with the `deposit` discriminator and the pool as its first account; its depositor is
// the instruction's third account, which the program requires to sign. A withdrawal is the same with
// the `withdraw` discriminator. Failed transactions are skipped. Wallets the project uses for its own
// tests can be excluded, so the numbers describe outside testers.
//
// Withdrawals are always sent by a relayer, so they say nothing about who withdrew; only deposits
// identify a wallet. These are counts of on-chain actions, not of people: one person can use several
// wallets.

export const DEPOSIT_DISCRIMINATOR = Uint8Array.from([242, 35, 198, 137, 82, 225, 242, 182]);
export const WITHDRAW_DISCRIMINATOR = Uint8Array.from([183, 18, 70, 156, 148, 109, 161, 34]);

const startsWith = (data, prefix) => data.length >= prefix.length && prefix.every((b, i) => data[i] === b);

/**
 * The pool actions in one confirmed transaction.
 *
 * @param {object} tx  getTransaction result in "json" encoding, with `meta.loadedAddresses` for v0
 * @param {string} programId
 * @param {(s: string) => Uint8Array} decode  base58 decoder
 * @returns {Array<{ kind: 'deposit' | 'withdraw', pool: string, depositor?: string }>}
 */
export function actionsInTransaction(tx, programId, decode) {
  if (!tx || tx.meta?.err) return [];
  const m = tx.transaction.message;
  const keys = [...m.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const top = m.instructions ?? [];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions);
  const out = [];
  for (const ix of [...top, ...inner]) {
    if (keys[ix.programIdIndex] !== programId) continue;
    const data = decode(ix.data);
    const accounts = ix.accounts.map((i) => keys[i]);
    if (startsWith(data, DEPOSIT_DISCRIMINATOR) && accounts.length >= 3) {
      out.push({ kind: 'deposit', pool: accounts[0], depositor: accounts[2] });
    } else if (startsWith(data, WITHDRAW_DISCRIMINATOR) && accounts.length >= 1) {
      out.push({ kind: 'withdraw', pool: accounts[0] });
    }
  }
  return out;
}

/**
 * Totals over a set of transactions.
 *
 * @param {Array<{ blockTime: number, actions: ReturnType<typeof actionsInTransaction> }>} txs
 * @param {{ pools: Record<string, string>, since?: number, until?: number, exclude?: Iterable<string> }} opts
 *   pools: pool address -> label; since/until: unix seconds, inclusive start and exclusive end;
 *   exclude: wallets whose deposits are not counted (the project's own test wallets)
 */
export function tally(txs, { pools, since = 0, until = Infinity, exclude = [] }) {
  const skip = new Set(exclude);
  const perPool = Object.fromEntries(Object.keys(pools).map((p) => [p, { deposits: 0, withdrawals: 0, wallets: new Set() }]));
  const all = new Set();
  let excludedDeposits = 0;
  for (const { blockTime, actions } of txs) {
    if (blockTime < since || blockTime >= until) continue;
    for (const a of actions) {
      const row = perPool[a.pool];
      if (!row) continue;
      if (a.kind === 'withdraw') {
        row.withdrawals += 1;
      } else if (skip.has(a.depositor)) {
        excludedDeposits += 1;
      } else {
        row.deposits += 1;
        row.wallets.add(a.depositor);
        all.add(a.depositor);
      }
    }
  }
  const rows = Object.entries(perPool).map(([pool, r]) => ({
    pool, label: pools[pool], deposits: r.deposits, withdrawals: r.withdrawals, wallets: r.wallets.size,
  }));
  return {
    rows,
    total: {
      deposits: rows.reduce((s, r) => s + r.deposits, 0),
      withdrawals: rows.reduce((s, r) => s + r.withdrawals, 0),
      wallets: all.size,
    },
    excludedDeposits,
  };
}
