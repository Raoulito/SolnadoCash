import { clusterApiUrl, type Cluster } from '@solana/web3.js';

// ── Environment-driven configuration (H-6) ──────────────────────────────────
// Previously devnet, an http:// relayer and the pool list were hardcoded, so a
// build could not be pointed at another network without editing source, and a
// production deployment would silently ship a localhost relayer.

const env = import.meta.env as Record<string, string | undefined>;

export const NETWORK = (env.VITE_SOLANA_NETWORK ?? 'devnet') as Cluster;

export const RPC_ENDPOINT = env.VITE_RPC_ENDPOINT ?? clusterApiUrl(NETWORK);

export const RELAYER_URL = (env.VITE_RELAYER_URL ?? 'http://localhost:3000').replace(
  /\/+$/,
  ''
);

export const PROGRAM_ID =
  env.VITE_PROGRAM_ID ?? 'DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59';

/** Explorer link for a transaction on the configured network. */
export function explorerTxUrl(signature: string): string {
  const suffix = NETWORK === 'mainnet-beta' ? '' : `?cluster=${NETWORK}`;
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

/**
 * True when the relayer would be reached over plaintext HTTP from a non-local
 * origin. In that case the network path — and anyone on it — sees the recipient
 * address and nullifier alongside the user's IP.
 */
export function relayerTransportIsInsecure(): boolean {
  if (!RELAYER_URL.startsWith('http://')) return false;
  try {
    const host = new URL(RELAYER_URL).hostname;
    return !(host === 'localhost' || host === '127.0.0.1' || host === '[::1]');
  } catch {
    return true;
  }
}

/** True when this build is pointed at a real-money network. */
export const IS_MAINNET = NETWORK === 'mainnet-beta';

/**
 * Configuration that must never ship to a real-money network (M-8).
 * Returns a list of problems; the app refuses to operate while any exist rather
 * than silently pointing mainnet funds at a development relayer.
 */
export function fatalConfigProblems(): string[] {
  if (!IS_MAINNET) return [];
  const problems: string[] = [];
  if (relayerTransportIsInsecure() || RELAYER_URL.includes('localhost')) {
    problems.push(
      `VITE_RELAYER_URL is ${RELAYER_URL}. A plaintext or local relayer must not be used on mainnet.`
    );
  }
  if (!env.VITE_RELAYER_URL) {
    problems.push('VITE_RELAYER_URL is unset. It defaults to a local development relayer.');
  }
  if (!env.VITE_RPC_ENDPOINT) {
    problems.push(
      'VITE_RPC_ENDPOINT is unset. The default public endpoint prunes history and breaks withdrawals.'
    );
  }
  if (!env.VITE_POOLS) {
    problems.push(
      'VITE_POOLS is unset. The built-in pool addresses are devnet deployments.'
    );
  }
  return problems;
}

export interface PoolConfig {
  label: string;
  denominationSol: number;
  denominationLamports: bigint;
  address: string; // Pool PDA base58 — fill after deployment
}

/**
 * Pool list. Override with VITE_POOLS as JSON:
 *   [{"label":"1 SOL","denominationSol":1,"address":"<pool PDA>"}]
 * The built-in defaults are devnet deployments and are wrong on any other network.
 *
 * Pool addresses are derived from admin + denomination + version via PDA.
 * Admin: 4PLXgVX9MumeLLjcyvYFNoKq1dECdEneiFA8StLCnf1c, Version: 0
 * Deploy with: node scripts/deploy_pools.js
 */
function loadPools(): PoolConfig[] {
  const raw = env.VITE_POOLS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Array<{
        label: string;
        denominationSol: number;
        address: string;
      }>;
      return parsed.map((p) => ({
        label: p.label,
        denominationSol: p.denominationSol,
        denominationLamports: BigInt(Math.round(p.denominationSol * 1e9)),
        address: p.address,
      }));
    } catch (err) {
      // Fail loudly: a malformed pool list would otherwise silently fall back to
      // devnet addresses.
      throw new Error(
        `VITE_POOLS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  // Devnet deployments. FOUR rungs: 0.1, 1, 10, 100.
  //
  // These pools were created with the mainnet role keys as a rehearsal: admin PooLKrrU...,
  // treasury TREAANHx.... The admin is part of the pool PDA seeds, so a different admin yields
  // different addresses; the earlier pools (admin 4PLXgVX9...) still exist on devnet and are
  // deliberately unadvertised.
  //
  // Each pool is an independent anonymity set and sets never merge, so every rung added
  // divides the same liquidity further. A rung only starts hiding anyone once it holds
  // roughly 50+ deposits, which caps the useful number of rungs at about
  // (total deposits / 50). A wide ladder also makes users
  // MORE identifiable, because an unusual combination of denominations is itself a
  // fingerprint across the deposit/withdraw boundary, whereas repeats of a common rung are
  // not. Tornado Cash shipped four ETH rungs for the same reason.
  //
  // Powers of ten, which is the ladder Tornado Cash shipped for ETH and the only one with
  // real usage data behind it. 100 SOL is roughly $7.6k at the time of writing: a normal
  // amount to want private, unlike the 250/500/1000 rungs that were tried and withdrawn.
  //
  // Next, gated on the neighbouring rungs being deep:
  //   +0.3/3/30  when each neighbour passes ~100 deposits (3 is the geometric mid-decade)
  //   +1000      only with sustained demand at 100; a $76k deposit will not fill a pool
  //
  // Pools for 0.5, 2, 3, 5, 20, 50, 250, 500 and 1000 SOL exist on devnet from an
  // earlier wide-ladder deployment and are deliberately NOT listed: there is no close
  // instruction, so they cannot be removed, only left unadvertised. Do not advertise a rung
  // that cannot be filled — someone will use it and believe they are private.
  return [
    {
      label: '0.1 SOL',
      denominationSol: 0.1,
      denominationLamports: 100_000_000n,
      address: 'FWQkYzmNz74VSffemu9tphYX1TSSfTBo9JYgKRWRWcoY',
    },
    {
      label: '1 SOL',
      denominationSol: 1,
      denominationLamports: 1_000_000_000n,
      address: '2MgQTtJGed9eR9itPk9nUChYbvCTpfmNhKTxpnUA2S3d',
    },
    {
      label: '10 SOL',
      denominationSol: 10,
      denominationLamports: 10_000_000_000n,
      address: 'GhbShsZipzgpRxZSihAkn1Bmstzoq9CgpDrbGXz3bNFE',
    },
    {
      label: '100 SOL',
      denominationSol: 100,
      denominationLamports: 100_000_000_000n,
      address: 'F5Qkfpw57KCXB8uXam1p3wAkf5YazSURPJWb1WVqfs7n',
    },
  ];
}

export const POOLS: PoolConfig[] = loadPools();
