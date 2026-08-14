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
      `VITE_RELAYER_URL is ${RELAYER_URL} — a plaintext or local relayer must not be used on mainnet.`
    );
  }
  if (!env.VITE_RELAYER_URL) {
    problems.push('VITE_RELAYER_URL is unset — it defaults to a local development relayer.');
  }
  if (!env.VITE_RPC_ENDPOINT) {
    problems.push(
      'VITE_RPC_ENDPOINT is unset — the default public endpoint prunes history and breaks withdrawals.'
    );
  }
  if (!env.VITE_POOLS) {
    problems.push(
      'VITE_POOLS is unset — the built-in pool addresses are devnet deployments.'
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
  return [
    {
      label: '0.1 SOL',
      denominationSol: 0.1,
      denominationLamports: 100_000_000n,
      address: '8SQqZoyaH8w8GPqBkW556Kyi5hY7YoTmwMSMA4wFuW6X',
    },
    {
      label: '1 SOL',
      denominationSol: 1,
      denominationLamports: 1_000_000_000n,
      address: 'Dg7qsi5Xjsh3k6vTBrXTHnsL4iEq4eMUbEzYNMDWaexY',
    },
    {
      label: '10 SOL',
      denominationSol: 10,
      denominationLamports: 10_000_000_000n,
      address: '8WAo38JwTXFQ2hUgXs6Bh3sH6SepqLxYr5fVuaCVcTme',
    },
  ];
}

export const POOLS: PoolConfig[] = loadPools();
