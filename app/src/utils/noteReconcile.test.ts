// app/src/utils/noteReconcile.test.ts
//
// The asymmetry is the whole point: keeping a worthless note is a UX annoyance, discarding a real
// one loses the deposit forever. So these tests care much more about the cases where it must NOT
// discard than the case where it should.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { reconcilePendingNotes } from './noteReconcile';
import { pendingNotes, stageNote } from './noteVault';

const POOL = 'Ftjp3fRkHE8wiJvQxcqkLSLoBt1fcpaAkPopfDmJ4G2Y';
const NOTE = `sndo_${POOL}_0000000005f5e100_${'ab'.repeat(64)}`;
const OLD = Date.now() - 10 * 60 * 1000; // comfortably past the grace period

const hasLeaf = vi.fn();
const rebuild = vi.fn();
const poseidon = vi.fn(() => 12345n);

vi.mock('./merkle', () => ({
  rebuildMerkleTree: (...a: unknown[]) => rebuild(...a),
}));

vi.mock('@solnadocash/sdk', () => ({
  initPoseidon: async () => {},
  poseidonHash: (...a: unknown[]) => poseidon(...a),
  decodeNote: (raw: string) => {
    const [, pool, denomHex, pre] = raw.split('_');
    return {
      encoded: raw,
      poolAddress: new PublicKey(pool),
      denomination: BigInt('0x' + denomHex),
      nullifier: BigInt('0x' + pre.slice(0, 64)),
      secret: BigInt('0x' + pre.slice(64)),
    };
  },
}));

/** Stage a note with a chosen age. */
function stageAged(note: string, createdAt: number) {
  stageNote({ note, poolAddress: POOL, denominationSol: 0.1 });
  const raw = JSON.parse(localStorage.getItem('sornadocash_pending_notes_v1') ?? '[]');
  localStorage.setItem(
    'sornadocash_pending_notes_v1',
    JSON.stringify(raw.map((n: { note: string }) => (n.note === note ? { ...n, createdAt } : n)))
  );
}

const fakeConnection = {} as never;

describe('reconcilePendingNotes', () => {
  beforeEach(() => {
    localStorage.clear();
    rebuild.mockReset();
    hasLeaf.mockReset();
    rebuild.mockResolvedValue({ hasLeaf });
  });
  afterEach(() => vi.restoreAllMocks());

  it('discards a note whose commitment is absent from a verified tree', async () => {
    stageAged(NOTE, OLD);
    hasLeaf.mockReturnValue(false);

    const r = await reconcilePendingNotes(fakeConnection);
    expect(r.discarded).toBe(1);
    expect(pendingNotes()).toHaveLength(0);
  });

  it('keeps and confirms a note whose deposit did land', async () => {
    stageAged(NOTE, OLD);
    hasLeaf.mockReturnValue(true);

    const r = await reconcilePendingNotes(fakeConnection);
    expect(r.confirmed).toBe(1);
    expect(pendingNotes()).toHaveLength(1);
    expect(pendingNotes()[0].status).toBe('confirmed');
  });

  it('NEVER discards when the chain cannot be read', async () => {
    stageAged(NOTE, OLD);
    rebuild.mockRejectedValue(new Error('429 Too Many Requests'));

    const r = await reconcilePendingNotes(fakeConnection);
    expect(r.unresolved).toBe(1);
    expect(r.discarded).toBe(0);
    expect(pendingNotes()).toHaveLength(1);
  });

  it('NEVER discards when the tree could not be verified complete', async () => {
    stageAged(NOTE, OLD);
    // This is what rebuildMerkleTree throws when it recovered fewer leaves than the pool reports.
    rebuild.mockRejectedValue(new Error('Merkle tree is incomplete: recovered 2 of 5 deposits'));

    const r = await reconcilePendingNotes(fakeConnection);
    expect(r.discarded).toBe(0);
    expect(pendingNotes()).toHaveLength(1);
  });

  it('NEVER judges a note that is still within the grace period', async () => {
    stageAged(NOTE, Date.now() - 5_000); // 5 seconds old
    hasLeaf.mockReturnValue(false);

    const r = await reconcilePendingNotes(fakeConnection);
    expect(r.unresolved).toBe(1);
    expect(r.discarded).toBe(0);
    expect(pendingNotes()).toHaveLength(1);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('NEVER discards a note it cannot decode', async () => {
    stageAged('sndo_not-a-real-note', OLD);
    hasLeaf.mockReturnValue(false);

    const r = await reconcilePendingNotes(fakeConnection);
    expect(r.discarded).toBe(0);
    expect(pendingNotes()).toHaveLength(1);
  });

  it('handles a mix, judging each note independently', async () => {
    const landed = `sndo_${POOL}_0000000005f5e100_${'cd'.repeat(64)}`;
    stageAged(NOTE, OLD);
    stageAged(landed, OLD);
    // First call absent, second present.
    hasLeaf.mockReturnValueOnce(false).mockReturnValueOnce(true);

    const r = await reconcilePendingNotes(fakeConnection);
    expect(r.discarded + r.confirmed).toBe(2);
    expect(pendingNotes()).toHaveLength(1);
  });

  it('does nothing, and touches no RPC, when there are no notes', async () => {
    const r = await reconcilePendingNotes(fakeConnection);
    expect(r).toEqual({ confirmed: 0, discarded: 0, unresolved: 0 });
    expect(rebuild).not.toHaveBeenCalled();
  });
});
