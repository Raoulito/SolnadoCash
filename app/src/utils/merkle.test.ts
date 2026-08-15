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
import { initPoseidon, MerkleTree } from '@solnadocash/sdk';
import { rebuildMerkleTree } from './merkle';
import { clearCache, loadCache, saveCache } from './leafCache';
import { PROGRAM_ID } from '../config';

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
}

/**
 * Mock connection backed by a synthetic deposit history. One signature per deposit, so a
 * getTransaction count equals the number of deposits actually re-fetched.
 */
function mockConnection(leaves: bigint[], counters: Counters) {
  const sigs = leaves.map((_, i) => `sig${String(i).padStart(4, '0')}`);
  const account = poolAccountFor(leaves);

  return {
    getAccountInfo: vi.fn(async () => account),
    getSignaturesForAddress: vi.fn(
      async (
        _addr: PublicKey,
        opts: { before?: string; until?: string; limit?: number }
      ) => {
        counters.getSignaturesForAddress++;
        // Newest first, like the real RPC.
        let list = [...sigs].reverse();
        if (opts.until) {
          const stop = list.indexOf(opts.until);
          if (stop >= 0) list = list.slice(0, stop);
        }
        if (opts.before) {
          const from = list.indexOf(opts.before);
          list = from >= 0 ? list.slice(from + 1) : [];
        }
        return list.slice(0, opts.limit ?? 1000).map((signature) => ({ signature, err: null }));
      }
    ),
    getTransaction: vi.fn(async (signature: string) => {
      counters.getTransaction++;
      const index = sigs.indexOf(signature);
      if (index < 0) return null;
      return {
        meta: {
          logMessages: [`__EVENT__:DepositEvent:${index}:${leaves[index].toString(16)}`],
        },
      };
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