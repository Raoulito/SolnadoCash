// app/src/utils/merkle.test.ts
//
// The leaf cache exists to make repeat withdrawals cheap (H-5). Two things must hold, and
// the second matters more than the first:
//
//   1. A warm cache costs zero transaction fetches when nothing new was deposited.
//   2. A cache that is stale, gapped or tampered with can NEVER produce a tree that passes
//      verification with wrong contents. It must fall back to a full scan and still end up
//      with the correct root.
//
// Both are asserted here by counting the RPC calls a mocked connection receives.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { initPoseidon, MerkleTree } from '@solnadocash/sdk';
import { rebuildMerkleTree } from './merkle';
import { clearCache, loadCache, saveCache } from './leafCache';
import { PROGRAM_ID } from '../config';
import IDL from '../idl/solnadocash.json';

const POOL = new PublicKey('Ftjp3fRkHE8wiJvQxcqkLSLoBt1fcpaAkPopfDmJ4G2Y');
const POOL_LEN = 8976;
const OFF_NEXT_INDEX = 8 + 80;
const OFF_CURRENT_ROOT_INDEX = 8 + 128;
const OFF_ROOT_HISTORY = 8 + 136;

/** Build a Pool account whose root history genuinely contains the tree's root. */
function poolAccountFor(leaves: bigint[]): { data: Uint8Array } {
  const data = new Uint8Array(POOL_LEN);
  const tree = new MerkleTree(20);
  const roots: bigint[] = [];
  for (const leaf of leaves) {
    tree.insert(leaf);
    roots.push(tree.root);
  }
  // next_index (u64 LE)
  let n = BigInt(leaves.length);
  for (let i = 0; i < 8; i++) {
    data[OFF_NEXT_INDEX + i] = Number(n & 0xffn);
    n >>= 8n;
  }
  // Write each successive root into the ring, newest last, as the program does.
  roots.forEach((root, i) => {
    const slot = (i + 1) % 256;
    const start = OFF_ROOT_HISTORY + slot * 32;
    let v = root;
    for (let j = 31; j >= 0; j--) {
      data[start + j] = Number(v & 0xffn);
      v >>= 8n;
    }
  });
  const current = roots.length === 0 ? 0 : roots.length % 256;
  let c = BigInt(current);
  for (let i = 0; i < 8; i++) {
    data[OFF_CURRENT_ROOT_INDEX + i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return { data };
}

interface Counters {
  getTransaction: number;
  getSignaturesForAddress: number;
  getBlockSignatures?: number;
}

const DEPOSIT_DISC = Uint8Array.from(
  (IDL as { instructions: { name: string; discriminator: number[] }[] }).instructions.find(
    (i) => i.name === 'deposit'
  )!.discriminator
);
const WITHDRAW_DISC = Uint8Array.from(
  (IDL as { instructions: { name: string; discriminator: number[] }[] }).instructions.find(
    (i) => i.name === 'withdraw'
  )!.discriminator
);
const OTHER_PROGRAM = 'Stake11111111111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const PAYER = 'DepositorPayer1111111111111111111111111111';
const VAULT = 'Vau1t111111111111111111111111111111111111111';

function leafBytes(leaf: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = leaf;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function depositData(leaf: bigint, disc: Uint8Array = DEPOSIT_DISC): string {
  const data = new Uint8Array(40);
  data.set(disc, 0);
  data.set(leafBytes(leaf), 8);
  return bs58.encode(data);
}

/**
 * How one deposit reached the chain, and what its transaction's record looks like.
 *
 *   top      — a top-level `deposit` instruction (the normal case)
 *   cpi      — `deposit` invoked by another program, so it appears only in innerInstructions
 *   lookup   — v0 transaction where the pool key arrives through an address lookup table
 */
interface DepositShape {
  via?: 'top' | 'cpi' | 'lookup';
  /** Drop this deposit's DepositEvent from the logs, as the 10 KB log limit does. */
  noEvent?: boolean;
  /** Override the slot. Defaults to one slot per deposit. */
  slot?: number;
}

interface MockOptions {
  shapes?: Record<number, DepositShape>;
  /** Extra transactions that mention the pool but insert nothing. */
  noise?: { signature: string; slot: number; tx: RawTx | 'v1'; afterDeposit: number }[];
  /** Order of signatures inside a slot, as getBlockSignatures would report it. */
  blockOrder?: Record<number, string[]>;
}

interface RawIx {
  programIdIndex: number;
  accounts: number[];
  data: string;
}
interface RawTx {
  slot: number;
  version?: 'legacy' | 0 | 1;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions: RawIx[] } };
  meta: {
    err: unknown;
    logMessages: string[];
    innerInstructions?: { index: number; instructions: RawIx[] }[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  };
}

function depositTx(pool: string, leaf: bigint, index: number, sig: string, slot: number, shape: DepositShape): RawTx {
  const logs = [
    `Program ${PROGRAM_ID} invoke [1]`,
    'Program log: Instruction: Deposit',
    ...(shape.noEvent ? ['Log truncated'] : [`__EVENT__:DepositEvent:${index}:${leaf.toString(16)}`]),
  ];
  const via = shape.via ?? 'top';
  if (via === 'cpi') {
    // Keys: payer, other program, pool, vault, system, this program. The deposit is inner.
    return {
      slot,
      version: 'legacy',
      transaction: {
        signatures: [sig],
        message: {
          accountKeys: [PAYER, OTHER_PROGRAM, pool, VAULT, SYSTEM, PROGRAM_ID],
          instructions: [{ programIdIndex: 1, accounts: [2, 3, 0, 4, 5], data: bs58.encode([9]) }],
        },
      },
      meta: {
        err: null,
        logMessages: logs,
        innerInstructions: [
          {
            index: 0,
            instructions: [{ programIdIndex: 5, accounts: [2, 3, 0, 4], data: depositData(leaf) }],
          },
        ],
      },
    };
  }
  if (via === 'lookup') {
    // v0: static keys hold payer, system and the program; pool and vault come from a table.
    // Resolved index order is static, then loaded writable, then loaded readonly.
    return {
      slot,
      version: 0,
      transaction: {
        signatures: [sig],
        message: {
          accountKeys: [PAYER, SYSTEM, PROGRAM_ID],
          instructions: [{ programIdIndex: 2, accounts: [3, 4, 0, 1], data: depositData(leaf) }],
        },
      },
      meta: { err: null, logMessages: logs, loadedAddresses: { writable: [pool, VAULT], readonly: [] } },
    };
  }
  return {
    slot,
    version: 'legacy',
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: [PAYER, pool, VAULT, SYSTEM, PROGRAM_ID],
        instructions: [{ programIdIndex: 4, accounts: [1, 2, 0, 3], data: depositData(leaf) }],
      },
    },
    meta: { err: null, logMessages: logs },
  };
}

/**
 * Mock connection backed by a synthetic deposit history. One signature per deposit, so a
 * getTransaction count equals the number of deposits actually re-fetched.
 *
 * Transactions are served the way the RPC serves them to `getTransaction` with
 * `encoding: 'json'`: instructions with base58 data, inner instructions, loaded addresses and
 * logs. A v1 transaction is refused unless the request declares maxSupportedTransactionVersion
 * of at least 1, exactly as the RPC does (-32015), and web3.js 1.x's typed `getTransaction`
 * throws on it either way, because its response schema only admits 'legacy' and 0.
 */
function mockConnection(leaves: bigint[], counters: Counters, opts: MockOptions = {}) {
  const pool = POOL.toBase58();
  const account = poolAccountFor(leaves);

  const entries: { signature: string; tx: RawTx | 'v1' }[] = [];
  leaves.forEach((leaf, i) => {
    const sig = `sig${String(i).padStart(4, '0')}`;
    const shape = opts.shapes?.[i] ?? {};
    entries.push({ signature: sig, tx: depositTx(pool, leaf, i, sig, shape.slot ?? 1000 + i, shape) });
    for (const n of opts.noise ?? []) {
      if (n.afterDeposit === i) entries.push({ signature: n.signature, tx: n.tx });
    }
  });
  const sigs = entries.map((e) => e.signature);
  const byName = new Map(entries.map((e) => [e.signature, e.tx]));

  const v1Error = {
    code: -32015,
    message:
      'Transaction version (1) is not supported by the requesting client. Please try the ' +
      'request again with the following configuration parameter: "maxSupportedTransactionVersion": 1',
  };

  return {
    getAccountInfo: vi.fn(async () => account),
    getSignaturesForAddress: vi.fn(
      async (
        _addr: PublicKey,
        o: { before?: string; until?: string; limit?: number }
      ) => {
        counters.getSignaturesForAddress++;
        // Newest first, like the real RPC.
        let list = [...sigs].reverse();
        if (o.until) {
          const stop = list.indexOf(o.until);
          if (stop >= 0) list = list.slice(0, stop);
        }
        if (o.before) {
          const from = list.indexOf(o.before);
          list = from >= 0 ? list.slice(from + 1) : [];
        }
        return list.slice(0, o.limit ?? 1000).map((signature) => ({ signature, err: null }));
      }
    ),
    // What web3.js 1.98 does with each response. Kept so a regression to the typed call is
    // caught for the reason it would fail in production.
    getTransaction: vi.fn(async (signature: string) => {
      counters.getTransaction++;
      const tx = byName.get(signature);
      if (!tx) return null;
      if (tx === 'v1') throw new Error(`failed to get transaction: ${v1Error.message}`);
      return { slot: tx.slot, meta: tx.meta, transaction: tx.transaction };
    }),
    _rpcRequest: vi.fn(async (method: string, args: unknown[]) => {
      if (method !== 'getTransaction') throw new Error(`unexpected RPC method ${method}`);
      counters.getTransaction++;
      const [signature, config] = args as [string, { maxSupportedTransactionVersion?: number; encoding?: string }];
      expect(config.encoding).toBe('json');
      const tx = byName.get(signature);
      if (!tx) return { result: null };
      if (tx === 'v1') {
        if ((config.maxSupportedTransactionVersion ?? -1) < 1) return { error: v1Error };
        return {
          result: {
            slot: 1,
            version: 1,
            transaction: {
              signatures: [signature],
              message: { accountKeys: [PAYER, pool], instructions: [] },
            },
            meta: { err: null, logMessages: [] },
          },
        };
      }
      return { result: tx };
    }),
    getBlockSignatures: vi.fn(async (slot: number) => {
      counters.getBlockSignatures = (counters.getBlockSignatures ?? 0) + 1;
      const order = opts.blockOrder?.[slot];
      if (!order) throw new Error(`no block order configured for slot ${slot}`);
      return { signatures: order };
    }),
  };
}

// Parse our synthetic log lines instead of real Anchor event encoding: this test is about
// cache behaviour and RPC volume, not Borsh decoding, which the SDK tests already cover.
vi.mock('@coral-xyz/anchor', () => ({
  BorshCoder: class {},
  EventParser: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    *parseLogs(logs: string[]): Generator<any> {
      for (const log of logs) {
        if (!log.startsWith('__EVENT__:DepositEvent:')) continue;
        const [, , idx, hex] = log.split(':');
        const bytes = hex.padStart(64, '0').match(/.{2}/g)!.map((b) => parseInt(b, 16));
        // snake_case, exactly as Anchor's EventParser yields it. Using camelCase here is why
        // the suite stayed green through a live "recovered 0 of N deposits" failure: the mock
        // spoke a field name the real parser never emits.
        yield { name: 'DepositEvent', data: { leaf: bytes, leaf_index: BigInt(idx) } };
      }
    }
  },
}));

const LEAVES = Array.from({ length: 40 }, (_, i) => BigInt(1000 + i) * 7919n);

describe('rebuildMerkleTree leaf cache', () => {
  beforeEach(async () => {
    await initPoseidon();
    localStorage.clear();
    clearCache(PROGRAM_ID, POOL.toBase58());
  });

  it('scans every deposit on a cold cache and verifies against the chain', async () => {
    const counters = { getTransaction: 0, getSignaturesForAddress: 0 };
    const conn = mockConnection(LEAVES, counters);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree = await rebuildMerkleTree(conn as any, POOL);

    expect(tree.nextIndex).toBe(LEAVES.length);
    expect(counters.getTransaction).toBe(LEAVES.length);

    const expected = new MerkleTree(20);
    for (const l of LEAVES) expected.insert(l);
    expect(tree.root).toBe(expected.root);
  });

  it('fetches NOTHING when the cache is current — the point of the cache', async () => {
    const counters = { getTransaction: 0, getSignaturesForAddress: 0 };
    const conn = mockConnection(LEAVES, counters);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await rebuildMerkleTree(conn as any, POOL);
    expect(counters.getTransaction).toBe(LEAVES.length);

    const second = { getTransaction: 0, getSignaturesForAddress: 0 };
    const conn2 = mockConnection(LEAVES, second);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree = await rebuildMerkleTree(conn2 as any, POOL);

    expect(second.getTransaction).toBe(0);
    expect(second.getSignaturesForAddress).toBe(0);
    expect(tree.nextIndex).toBe(LEAVES.length);
  });

  it('fetches only the new deposits when the pool grew', async () => {
    const counters = { getTransaction: 0, getSignaturesForAddress: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await rebuildMerkleTree(mockConnection(LEAVES, counters) as any, POOL);

    const grown = [...LEAVES, 99991n, 99992n, 99993n];
    const second = { getTransaction: 0, getSignaturesForAddress: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree = await rebuildMerkleTree(mockConnection(grown, second) as any, POOL);

    expect(second.getTransaction).toBe(3); // not 43
    expect(tree.nextIndex).toBe(grown.length);
    const expected = new MerkleTree(20);
    for (const l of grown) expected.insert(l);
    expect(tree.root).toBe(expected.root);
  });

  it('recovers a correct tree from a TAMPERED cache instead of trusting it', async () => {
    // An attacker (or a bug) writes a plausible but wrong leaf. If this were trusted, the
    // user would generate a proof against a root the chain never had.
    const bad = [...LEAVES];
    bad[7] = 424242n;
    saveCache(PROGRAM_ID, POOL.toBase58(), bad, 'sig0039');

    const counters = { getTransaction: 0, getSignaturesForAddress: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree = await rebuildMerkleTree(mockConnection(LEAVES, counters) as any, POOL);

    const expected = new MerkleTree(20);
    for (const l of LEAVES) expected.insert(l);
    expect(tree.root).toBe(expected.root);
    expect(counters.getTransaction).toBeGreaterThan(0); // it rescanned
  });

  it('recovers when the cache holds MORE leaves than the chain reports', async () => {
    // Plausible after a pool is redeployed at a reused address, or a cache carried across a
    // network switch. The stale surplus must not survive into the tree.
    saveCache(PROGRAM_ID, POOL.toBase58(), LEAVES, 'sig0039');
    const shorter = LEAVES.slice(0, 12);

    const counters = { getTransaction: 0, getSignaturesForAddress: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree = await rebuildMerkleTree(mockConnection(shorter, counters) as any, POOL);

    expect(tree.nextIndex).toBe(shorter.length);
    const expected = new MerkleTree(20);
    for (const l of shorter) expected.insert(l);
    expect(tree.root).toBe(expected.root);
  });

  it('still succeeds when the cached signature is unknown to the RPC (pruned)', async () => {
    // getSignaturesForAddress ignores an `until` it cannot find, so the scan returns full
    // history. The merge must cope rather than double-count or leave a gap.
    saveCache(PROGRAM_ID, POOL.toBase58(), LEAVES.slice(0, 20), 'sig-that-no-longer-exists');

    const counters = { getTransaction: 0, getSignaturesForAddress: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree = await rebuildMerkleTree(mockConnection(LEAVES, counters) as any, POOL);

    expect(tree.nextIndex).toBe(LEAVES.length);
    const expected = new MerkleTree(20);
    for (const l of LEAVES) expected.insert(l);
    expect(tree.root).toBe(expected.root);
  });

  it('recovers when the cache has a signature bound but NO leaves (live bug)', async () => {
    // Reported from live use: "Merkle tree is incomplete: recovered 0 of 2 on-chain deposits".
    // A cache holding a lastSignature with an empty leaf array makes the incremental scan skip
    // everything at or before that signature, so the merge sees only later leaf indices, the
    // dense prefix starts at a gap, and the tree ends up empty. The old code only fell back to a
    // full rescan when the cache had leaves, so this state could never heal itself.
    saveCache(PROGRAM_ID, POOL.toBase58(), [], 'sig0000');

    const counters = { getTransaction: 0, getSignaturesForAddress: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree = await rebuildMerkleTree(mockConnection(LEAVES, counters) as any, POOL);

    expect(tree.nextIndex).toBe(LEAVES.length);
    const expected = new MerkleTree(20);
    for (const l of LEAVES) expected.insert(l);
    expect(tree.root).toBe(expected.root);
  });

  it('recovers from a cache with a hole rather than building a short tree', async () => {
    // Truncated cache with a signature bound implying everything is known.
    saveCache(PROGRAM_ID, POOL.toBase58(), LEAVES.slice(0, 10), 'sig0039');
    const counters = { getTransaction: 0, getSignaturesForAddress: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tree = await rebuildMerkleTree(mockConnection(LEAVES, counters) as any, POOL);

    expect(tree.nextIndex).toBe(LEAVES.length);
    const expected = new MerkleTree(20);
    for (const l of LEAVES) expected.insert(l);
    expect(tree.root).toBe(expected.root);
  });
});

describe('rebuildMerkleTree does not depend on logs (H-2)', () => {
  beforeEach(async () => {
    await initPoseidon();
    localStorage.clear();
    clearCache(PROGRAM_ID, POOL.toBase58());
  });

  const expectedRoot = (leaves: bigint[]) => {
    const t = new MerkleTree(20);
    for (const l of leaves) t.insert(l);
    return t.root;
  };
  const rebuild = (conn: unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rebuildMerkleTree(conn as any, POOL);

  it('recovers a deposit whose DepositEvent was cut by the log limit', async () => {
    // The attack: a transaction that floods the 10 KB log buffer and then deposits. The deposit
    // is applied, its event line is dropped, and a tree built from events can never reach
    // next_index again, so every later withdrawal from the pool fails.
    const counters = { getTransaction: 0, getSignaturesForAddress: 0 };
    const conn = mockConnection(LEAVES, counters, { shapes: { 17: { noEvent: true } } });
    const tree = await rebuild(conn);
    expect(tree.nextIndex).toBe(LEAVES.length);
    expect(tree.root).toBe(expectedRoot(LEAVES));
  });

  it('recovers when EVERY event is missing, ordering deposits by slot', async () => {
    const shapes = Object.fromEntries(LEAVES.map((_, i) => [i, { noEvent: true }]));
    const conn = mockConnection(LEAVES, { getTransaction: 0, getSignaturesForAddress: 0 }, { shapes });
    const tree = await rebuild(conn);
    expect(tree.root).toBe(expectedRoot(LEAVES));
  });

  it('recovers a truncated deposit made through another program (inner instruction)', async () => {
    const conn = mockConnection(LEAVES, { getTransaction: 0, getSignaturesForAddress: 0 }, {
      shapes: { 3: { via: 'cpi', noEvent: true }, 4: { via: 'cpi' } },
    });
    const tree = await rebuild(conn);
    expect(tree.root).toBe(expectedRoot(LEAVES));
  });

  it('recovers a truncated deposit whose pool key came from an address lookup table', async () => {
    const conn = mockConnection(LEAVES, { getTransaction: 0, getSignaturesForAddress: 0 }, {
      shapes: { 30: { via: 'lookup', noEvent: true }, 31: { via: 'lookup' } },
    });
    const tree = await rebuild(conn);
    expect(tree.root).toBe(expectedRoot(LEAVES));
  });

  it('fills a truncated deposit during an INCREMENTAL scan', async () => {
    await rebuild(mockConnection(LEAVES, { getTransaction: 0, getSignaturesForAddress: 0 }));
    const grown = [...LEAVES, 99991n, 99992n, 99993n];
    const counters = { getTransaction: 0, getSignaturesForAddress: 0 };
    const tree = await rebuild(
      mockConnection(grown, counters, { shapes: { 41: { noEvent: true } } })
    );
    expect(counters.getTransaction).toBe(3);
    expect(tree.root).toBe(expectedRoot(grown));
  });

  it('ignores the DepositEvent of ANOTHER pool in a transaction that lists this one', async () => {
    // DepositEvent carries no pool. A transaction that deposits into a pool the attacker owns and
    // merely lists this pool as an extra account appears in this pool's history, and its event
    // used to be merged here at the other pool's index, overwriting a real leaf.
    const OTHER_POOL = 'Pooi2222222222222222222222222222222222222222';
    const crossPool: RawTx = {
      slot: 1005,
      version: 'legacy',
      transaction: {
        signatures: ['cross'],
        message: {
          accountKeys: [PAYER, OTHER_POOL, VAULT, SYSTEM, PROGRAM_ID, POOL.toBase58()],
          instructions: [{ programIdIndex: 4, accounts: [1, 2, 0, 3, 5], data: depositData(424242n) }],
        },
      },
      meta: {
        err: null,
        logMessages: [`Program ${PROGRAM_ID} invoke [1]`, `__EVENT__:DepositEvent:0:${(424242n).toString(16)}`],
      },
    };
    const conn = mockConnection(LEAVES, { getTransaction: 0, getSignaturesForAddress: 0 }, {
      noise: [{ signature: 'cross', slot: 1005, tx: crossPool, afterDeposit: 5 }],
    });
    const tree = await rebuild(conn);
    expect(tree.root).toBe(expectedRoot(LEAVES));
  });

  it('ignores non-deposit instructions and failed transactions', async () => {
    const pool = POOL.toBase58();
    const withdrawTx: RawTx = {
      slot: 1010,
      version: 'legacy',
      transaction: {
        signatures: ['withdraw'],
        message: {
          accountKeys: [PAYER, pool, VAULT, SYSTEM, PROGRAM_ID],
          // Same length and pool position as a deposit, different discriminator.
          instructions: [{ programIdIndex: 4, accounts: [1, 2, 0, 3], data: depositData(777n, WITHDRAW_DISC) }],
        },
      },
      meta: { err: null, logMessages: [] },
    };
    const failedDeposit: RawTx = {
      slot: 1011,
      version: 'legacy',
      transaction: {
        signatures: ['failed'],
        message: {
          accountKeys: [PAYER, pool, VAULT, SYSTEM, PROGRAM_ID],
          instructions: [{ programIdIndex: 4, accounts: [1, 2, 0, 3], data: depositData(888n) }],
        },
      },
      meta: { err: { InstructionError: [0, { Custom: 1 }] }, logMessages: [] },
    };
    const conn = mockConnection(LEAVES, { getTransaction: 0, getSignaturesForAddress: 0 }, {
      shapes: { 12: { noEvent: true } },
      noise: [
        { signature: 'withdraw', slot: 1010, tx: withdrawTx, afterDeposit: 10 },
        { signature: 'failed', slot: 1011, tx: failedDeposit, afterDeposit: 11 },
      ],
    });
    const tree = await rebuild(conn);
    expect(tree.root).toBe(expectedRoot(LEAVES));
  });

  it('is not bricked by a v1 transaction that touches the pool', async () => {
    // web3.js 1.x rejects v1 in its getTransaction response schema whatever
    // maxSupportedTransactionVersion says, and the RPC rejects it unless the request allows 1.
    // Either way one v1 transaction listing the pool used to abort every rebuild.
    const conn = mockConnection(LEAVES, { getTransaction: 0, getSignaturesForAddress: 0 }, {
      noise: [{ signature: 'v1tx', slot: 1020, tx: 'v1', afterDeposit: 20 }],
    });
    const tree = await rebuild(conn);
    expect(tree.root).toBe(expectedRoot(LEAVES));
  });

  it('orders two truncated deposits sharing a slot by their position in the block', async () => {
    const counters: Counters = { getTransaction: 0, getSignaturesForAddress: 0 };
    const conn = mockConnection(LEAVES, counters, {
      shapes: { 8: { noEvent: true, slot: 5000 }, 9: { noEvent: true, slot: 5000 } },
      blockOrder: { 5000: ['someoneElse', 'sig0008', 'other', 'sig0009'] },
    });
    const tree = await rebuild(conn);
    expect(counters.getBlockSignatures).toBe(1);
    expect(tree.root).toBe(expectedRoot(LEAVES));
  });

  it('refuses rather than guesses when the block order contradicts the chain', async () => {
    const conn = mockConnection(LEAVES, { getTransaction: 0, getSignaturesForAddress: 0 }, {
      shapes: { 8: { noEvent: true, slot: 5000 }, 9: { noEvent: true, slot: 5000 } },
      blockOrder: { 5000: ['sig0009', 'sig0008'] },
    });
    await expect(rebuild(conn)).rejects.toThrow();
  });

  it('refuses when a same-slot order cannot be established', async () => {
    const conn = mockConnection(LEAVES, { getTransaction: 0, getSignaturesForAddress: 0 }, {
      shapes: { 8: { noEvent: true, slot: 5000 }, 9: { noEvent: true, slot: 5000 } },
      // no blockOrder: getBlockSignatures throws
    });
    await expect(rebuild(conn)).rejects.toThrow();
  });
});

describe('leafCache storage', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips leaves', () => {
    saveCache(PROGRAM_ID, 'poolA', [1n, 2n, 255n], 'sigZ');
    const c = loadCache(PROGRAM_ID, 'poolA');
    expect(c.leaves.map((h) => BigInt(`0x${h}`))).toEqual([1n, 2n, 255n]);
    expect(c.lastSignature).toBe('sigZ');
  });

  it('keeps pools separate', () => {
    saveCache(PROGRAM_ID, 'poolA', [1n], 'sigA');
    expect(loadCache(PROGRAM_ID, 'poolB').leaves).toEqual([]);
  });

  it('discards malformed entries instead of passing them on', () => {
    saveCache(PROGRAM_ID, 'poolA', [1n], 'sigA');
    const key = Object.keys(localStorage).find((k) => k.includes('poolA'))!;
    localStorage.setItem(key, JSON.stringify({ leaves: ['nothex'], lastSignature: 'x' }));
    expect(loadCache(PROGRAM_ID, 'poolA').leaves).toEqual([]);
  });

  it('survives corrupt JSON', () => {
    saveCache(PROGRAM_ID, 'poolA', [1n], 'sigA');
    const key = Object.keys(localStorage).find((k) => k.includes('poolA'))!;
    localStorage.setItem(key, '{not json');
    expect(loadCache(PROGRAM_ID, 'poolA').leaves).toEqual([]);
  });

  it('refuses to persist beyond the size cap rather than filling the quota', () => {
    const many = Array.from({ length: 20_001 }, (_, i) => BigInt(i));
    saveCache(PROGRAM_ID, 'poolBig', many, 'sigX');
    expect(loadCache(PROGRAM_ID, 'poolBig').leaves).toEqual([]);
  });
});