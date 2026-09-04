// app/src/utils/clusterGate.ts
//
// Anti-mainnet gate. Nothing that moves value runs until the cluster this app transacts on has
// been POSITIVELY identified as the allowed one — devnet by default.
//
// Why this exists separately from NetworkGuard's old check:
//
//  - The old check compared the RPC's genesis hash against `NETWORK`, which is itself
//    configuration. Setting VITE_SOLANA_NETWORK=mainnet-beta made mainnet the expected value and
//    the check passed. It verified internal consistency, not safety.
//  - It failed OPEN. An unreachable or rate-limited RPC hit a `.catch()` that deliberately did
//    nothing, so "we could not determine the cluster" was treated the same as "the cluster is
//    fine". That is the wrong default for a guard: unknown must mean blocked.
//  - It rendered a banner and gated nothing. Every action path remained callable.
//
// What is actually being verified, stated precisely, because it is easy to overclaim here:
//
// The genesis hash identifies the cluster THIS APP'S RPC CONNECTION serves. That is the cluster a
// transaction lands on, because the wallet adapter submits through the `Connection` the app hands
// it — so this is the check that determines where funds go, and it is sufficient to prevent a
// mainnet deposit.
//
// It is NOT a check on which network the user's wallet has selected. The wallet-standard adapter
// exposes no reliable way to read that, and vendor-specific hooks are not worth building a safety
// rail on. A wallet pointed at mainnet while the app is on devnet still transacts on devnet; it
// may refuse to sign or show its own warning, which surfaces as a signing failure the deposit flow
// already handles. So "wallet is on devnet" is unverifiable, "the money will move on devnet" is
// verifiable, and the second is the one that matters.

import type { Connection } from '@solana/web3.js';

/** Immutable per-cluster genesis hashes. */
export const GENESIS_HASHES: Record<string, string> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
};

const env = import.meta.env as Record<string, string | undefined>;

/**
 * The only cluster on which this build will act. Defaults to devnet, so a build that forgets to
 * set anything is safe rather than permissive.
 *
 * Deliberately its own variable rather than reusing VITE_SOLANA_NETWORK: that one selects an RPC
 * endpoint and explorer links, and a guard whose bound is set by the thing it is guarding is not a
 * guard. Unlocking mainnet has to be a separate, explicit act — and `fatalConfigProblems()` in
 * config.ts still has to pass as well.
 */
export const ALLOWED_CLUSTER = env.VITE_ALLOWED_CLUSTER ?? 'devnet';

export type ClusterVerdict =
  | { ok: true; cluster: string; genesisHash: string }
  | {
      ok: false;
      /** `wrong-cluster`: identified, and not permitted. `unverified`: could not identify. */
      code: 'wrong-cluster' | 'unverified';
      /** Identified cluster name, or null when identification itself failed. */
      cluster: string | null;
      message: string;
    };

export class ClusterBlockedError extends Error {
  readonly code: 'wrong-cluster' | 'unverified';
  readonly cluster: string | null;

  constructor(verdict: Extract<ClusterVerdict, { ok: false }>) {
    super(verdict.message);
    this.name = 'ClusterBlockedError';
    this.code = verdict.code;
    this.cluster = verdict.cluster;
  }
}

/**
 * Successful identifications only, keyed by endpoint. A cluster's genesis hash never changes, so
 * caching a hit is sound and keeps the gate off the critical path after first use.
 *
 * Failures are never cached: a rate-limited RPC must not latch the app into a blocked state, and
 * more importantly a cached failure could be confused for a cached verdict.
 */
const identified = new Map<string, string>();

/** Test seam. */
export function resetClusterCache(): void {
  identified.clear();
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no response within ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export interface VerifyOptions {
  /** Override the permitted cluster. Tests only; production reads ALLOWED_CLUSTER. */
  allowed?: string;
  timeoutMs?: number;
}

type MinimalConnection = Pick<Connection, 'getGenesisHash'> & { rpcEndpoint: string };

/**
 * Identify the cluster behind `connection` and decide whether acting on it is permitted.
 *
 * Never throws. Any failure to identify returns `ok: false` with code `unverified`, which callers
 * must treat as blocking.
 */
export async function verifyCluster(
  connection: MinimalConnection,
  options: VerifyOptions = {}
): Promise<ClusterVerdict> {
  const allowed = options.allowed ?? ALLOWED_CLUSTER;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const expected = GENESIS_HASHES[allowed];
  if (!expected) {
    return {
      ok: false,
      code: 'unverified',
      cluster: null,
      message:
        `This build is configured to allow the cluster "${allowed}", which it cannot verify. ` +
        `Known clusters: ${Object.keys(GENESIS_HASHES).join(', ')}. All actions are blocked.`,
    };
  }

  let genesisHash = identified.get(connection.rpcEndpoint);
  if (!genesisHash) {
    try {
      genesisHash = await withTimeout(connection.getGenesisHash(), timeoutMs);
      identified.set(connection.rpcEndpoint, genesisHash);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: 'unverified',
        cluster: null,
        message:
          `Could not confirm which Solana cluster this app is connected to (${detail}). ` +
          `Actions are blocked until it is confirmed, because an unidentified network could ` +
          `be mainnet. Check your connection and reload.`,
      };
    }
  }

  if (genesisHash === expected) {
    return { ok: true, cluster: allowed, genesisHash };
  }

  const actual =
    Object.entries(GENESIS_HASHES).find(([, h]) => h === genesisHash)?.[0] ?? null;

  const what = actual === null ? 'an unrecognised cluster' : actual;
  const mainnet = actual === 'mainnet-beta';

  return {
    ok: false,
    code: 'wrong-cluster',
    cluster: actual,
    message: mainnet
      ? `Blocked: this app is connected to mainnet-beta, and this build only acts on ` +
        `${allowed}. SornadoCash has not been audited and its trusted setup is single-party, ` +
        `so it must not be used with real funds. No action was taken.`
      : `Blocked: this app is connected to ${what}, but it only acts on ${allowed}. ` +
        `No action was taken.`,
  };
}

/**
 * Gate for every value-moving path. Call this FIRST — before generating a note, staging anything
 * to storage, requesting a quote or building a transaction — so a block leaves no residue.
 *
 * @throws ClusterBlockedError unless the cluster is positively confirmed as permitted.
 */
export async function assertClusterAllowed(
  connection: MinimalConnection,
  options: VerifyOptions = {}
): Promise<void> {
  const verdict = await verifyCluster(connection, options);
  if (!verdict.ok) throw new ClusterBlockedError(verdict);
}
