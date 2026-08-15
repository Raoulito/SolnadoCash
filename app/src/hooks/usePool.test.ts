// app/src/hooks/usePool.test.ts
//
// FE-3: in the withdraw flow the pool address comes from a note the user pasted, so
// usePoolInfo must not believe an account just because the bytes are in the right places.
// The case that matters is the anonymity set: an impostor account that decodes to a huge
// deposit count tells the user they are hidden in a crowd of thousands, and they may then
// choose to withdraw immediately on the strength of it.
//
// Uses renderHook from @testing-library/react so the real hook runs, rather than
// re-implementing its logic in the test and proving nothing.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { capacityLabel, SATURATION_THRESHOLD, usePoolInfo } from './usePool';
import { PROGRAM_ID } from '../config';

const POOL_MIN_LEN = 8 + 8968;
const NEXT_INDEX_OFFSET = 8 + 80;
const REAL_DISCRIMINATOR = [0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc];
const SOME_POOL = 'Ftjp3fRkHE8wiJvQxcqkLSLoBt1fcpaAkPopfDmJ4G2Y';
const OTHER_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const getAccountInfo = vi.fn();

// The hook takes its connection from the wallet-adapter provider. The returned object must
// keep a stable identity across renders: the hook's effect depends on `connection`, so a
// fresh object per render would re-run and cancel the in-flight read before it resolved. The
// real ConnectionProvider memoises on endpoint + config, so this mirrors production.
const STABLE_CONNECTION = { connection: { getAccountInfo } };
vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => STABLE_CONNECTION,
}));

/** Build account data that decodes to `deposits`, with a chosen discriminator. */
function poolData(deposits: number, discriminator = REAL_DISCRIMINATOR): Buffer {
  const data = Buffer.alloc(POOL_MIN_LEN);
  discriminator.forEach((b, i) => (data[i] = b));
  data.writeBigUInt64LE(BigInt(deposits), NEXT_INDEX_OFFSET);
  return data;
}

describe('usePoolInfo validation', () => {
  beforeEach(() => {
    getAccountInfo.mockReset();
    // A bare mockReset makes the mock return undefined, and a hook effect that outlives its
    // test then fails on `.then`. A resolving default keeps the harness honest about which
    // failures are real.
    getAccountInfo.mockResolvedValue(null);
  });

  // Unmount between tests so no effect from a previous render observes the next mock.
  afterEach(() => cleanup());

  it('accepts a genuine pool account', async () => {
    getAccountInfo.mockResolvedValue({
      owner: new PublicKey(PROGRAM_ID),
      data: poolData(118),
    });
    const { result } = renderHook(() => usePoolInfo(SOME_POOL));
    await waitFor(() => expect(result.current.info).not.toBeNull());
    expect(result.current.info).toEqual({
      nextIndex: 118,
      isPaused: false,
      isSaturated: false,
    });
    expect(result.current.error).toBeNull();
  });

  it('refuses an account owned by another program, however plausible its bytes', async () => {
    // Same layout, same discriminator, 500,000 "deposits" — but not our program.
    getAccountInfo.mockResolvedValue({
      owner: new PublicKey(OTHER_PROGRAM),
      data: poolData(500_000),
    });
    const { result } = renderHook(() => usePoolInfo(SOME_POOL));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.info).toBeNull(); // no anonymity set is rendered from it
    expect(result.current.error).toMatch(/another program/);
  });

  it('refuses an owned account with the wrong discriminator', async () => {
    getAccountInfo.mockResolvedValue({
      owner: new PublicKey(PROGRAM_ID),
      data: poolData(500_000, [1, 2, 3, 4, 5, 6, 7, 8]),
    });
    const { result } = renderHook(() => usePoolInfo(SOME_POOL));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.info).toBeNull();
    expect(result.current.error).toMatch(/not a pool/);
  });

  it('refuses a too-short account instead of throwing RangeError', async () => {
    getAccountInfo.mockResolvedValue({
      owner: new PublicKey(PROGRAM_ID),
      data: Buffer.from(REAL_DISCRIMINATOR),
    });
    const { result } = renderHook(() => usePoolInfo(SOME_POOL));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.info).toBeNull();
    expect(result.current.error).toMatch(/wrong size/);
  });

  it('reports a missing account', async () => {
    getAccountInfo.mockResolvedValue(null);
    const { result } = renderHook(() => usePoolInfo(SOME_POOL));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toMatch(/not found/);
  });

  it('rejects a malformed address without calling the RPC', async () => {
    const { result } = renderHook(() => usePoolInfo('not-an-address'));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(getAccountInfo).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/not a valid Solana address/);
  });

  it('flags a saturated pool', async () => {
    getAccountInfo.mockResolvedValue({
      owner: new PublicKey(PROGRAM_ID),
      data: poolData(950_000),
    });
    const { result } = renderHook(() => usePoolInfo(SOME_POOL));
    await waitFor(() => expect(result.current.info).not.toBeNull());
    expect(result.current.info?.isSaturated).toBe(true);
  });
});

describe('capacityLabel', () => {
  it('reports an empty pool as 0%', () => {
    expect(capacityLabel(0)).toBe('0%');
  });

  it('never describes a pool that is in use as untouched', () => {
    // One deposit is 0.0001% of capacity. Rounding that to "0%" would call a pool with funds in
    // it empty, so anything non-zero but tiny reads as "<1%".
    expect(capacityLabel(1)).toBe('<1%');
    expect(capacityLabel(9_499)).toBe('<1%');
  });

  it('rounds to whole percentages once there is something to round', () => {
    expect(capacityLabel(95_000)).toBe('10%');
    expect(capacityLabel(475_000)).toBe('50%');
  });

  it('reports a saturated pool as 100%', () => {
    expect(capacityLabel(SATURATION_THRESHOLD)).toBe('100%');
    expect(capacityLabel(SATURATION_THRESHOLD + 10)).toBe('100%');
  });

  it('never exposes a raw deposit count', () => {
    // The only meaningful property is that every output is a percentage token and nothing
    // else. A substring check against the input is not: "<1%" unavoidably contains "1".
    for (const n of [0, 1, 42, 118, 9_499, 95_000, 475_000, 950_000]) {
      expect(capacityLabel(n)).toMatch(/^(<1%|\d{1,3}%)$/);
    }
    // A distinctive count must not survive into the output.
    expect(capacityLabel(123_456)).not.toContain('123456');
  });

  it('handles a negative or nonsense count without producing NaN', () => {
    expect(capacityLabel(-5)).toBe('0%');
  });
});
