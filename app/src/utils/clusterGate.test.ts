// app/src/utils/clusterGate.test.ts
//
// The point of these tests is the BLOCKING direction. A gate that permits when it should not is
// worse than no gate, because the banner implies a check happened.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  verifyCluster,
  assertClusterAllowed,
  ClusterBlockedError,
  GENESIS_HASHES,
  resetClusterCache,
} from './clusterGate';

const DEVNET = GENESIS_HASHES.devnet;
const MAINNET = GENESIS_HASHES['mainnet-beta'];
const TESTNET = GENESIS_HASHES.testnet;

/** A Connection stub exposing only what the gate uses. */
function conn(
  behaviour: string | Error | 'hang',
  endpoint = `https://rpc.test/${Math.random()}`
) {
  let calls = 0;
  return {
    rpcEndpoint: endpoint,
    get calls() {
      return calls;
    },
    getGenesisHash: () => {
      calls += 1;
      if (behaviour === 'hang') return new Promise<string>(() => {});
      if (behaviour instanceof Error) return Promise.reject(behaviour);
      return Promise.resolve(behaviour);
    },
  };
}

beforeEach(() => {
  resetClusterCache();
});

describe('clusterGate', () => {
  it('permits devnet', async () => {
    const v = await verifyCluster(conn(DEVNET), { allowed: 'devnet' });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.cluster).toBe('devnet');
  });

  // ── The reason this file exists ──────────────────────────────────────────────

  it('blocks mainnet and says why', async () => {
    const v = await verifyCluster(conn(MAINNET), { allowed: 'devnet' });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('wrong-cluster');
      expect(v.cluster).toBe('mainnet-beta');
      expect(v.message).toMatch(/mainnet-beta/);
      expect(v.message).toMatch(/No action was taken/);
    }
  });

  it('blocks testnet — the gate is an allowlist, not a mainnet denylist', async () => {
    const v = await verifyCluster(conn(TESTNET), { allowed: 'devnet' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.cluster).toBe('testnet');
  });

  it('blocks an unrecognised genesis hash', async () => {
    const v = await verifyCluster(conn('SomeOtherChainGenesisHash11111'), {
      allowed: 'devnet',
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('wrong-cluster');
      expect(v.cluster).toBeNull();
      expect(v.message).toMatch(/unrecognised/);
    }
  });

  // ── Fail closed: unknown must never mean allowed ─────────────────────────────

  it('blocks when the RPC errors', async () => {
    const v = await verifyCluster(conn(new Error('429 Too Many Requests')), {
      allowed: 'devnet',
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('unverified');
      expect(v.message).toMatch(/429/);
      expect(v.message).toMatch(/could be mainnet/i);
    }
  });

  it('blocks when the RPC hangs, rather than waiting forever', async () => {
    const v = await verifyCluster(conn('hang'), { allowed: 'devnet', timeoutMs: 20 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('unverified');
  });

  it('blocks when the allowed cluster is not one it can verify', async () => {
    const v = await verifyCluster(conn(DEVNET), { allowed: 'localnet' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('unverified');
  });

  it('does not cache a failure, so a transient error is recoverable', async () => {
    const endpoint = 'https://rpc.test/flaky';
    const bad = await verifyCluster(conn(new Error('offline'), endpoint), {
      allowed: 'devnet',
    });
    expect(bad.ok).toBe(false);
    const good = await verifyCluster(conn(DEVNET, endpoint), { allowed: 'devnet' });
    expect(good.ok).toBe(true);
  });

  it('caches a success, so the gate is not a per-action round trip', async () => {
    const endpoint = 'https://rpc.test/stable';
    const c = conn(DEVNET, endpoint);
    await verifyCluster(c, { allowed: 'devnet' });
    await verifyCluster(c, { allowed: 'devnet' });
    expect(c.calls).toBe(1);
  });

  it('a cached hash is still re-judged against the allowed cluster', async () => {
    // Caching must memoise the identification, never the verdict.
    const endpoint = 'https://rpc.test/mainnet';
    const c = conn(MAINNET, endpoint);
    const first = await verifyCluster(c, { allowed: 'mainnet-beta' });
    expect(first.ok).toBe(true);
    const second = await verifyCluster(c, { allowed: 'devnet' });
    expect(second.ok).toBe(false);
    expect(c.calls).toBe(1);
  });

  // ── assertClusterAllowed ─────────────────────────────────────────────────────

  it('assert resolves on devnet', async () => {
    await expect(
      assertClusterAllowed(conn(DEVNET), { allowed: 'devnet' })
    ).resolves.toBeUndefined();
  });

  it('assert throws ClusterBlockedError on mainnet', async () => {
    await expect(
      assertClusterAllowed(conn(MAINNET), { allowed: 'devnet' })
    ).rejects.toThrow(ClusterBlockedError);
  });

  it('assert throws on an unverifiable cluster', async () => {
    await expect(
      assertClusterAllowed(conn(new Error('dns failure')), { allowed: 'devnet' })
    ).rejects.toThrow(/blocked until it is confirmed/i);
  });

  it('defaults to devnet when no allowed cluster is passed', async () => {
    // The shipped default must be the safe one even with no configuration at all.
    const v = await verifyCluster(conn(MAINNET));
    expect(v.ok).toBe(false);
  });
});
