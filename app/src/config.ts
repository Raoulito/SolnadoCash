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

export interface PoolConfig {
  label: string;
  denominationSol: number;
  denominationLamports: bigint;
  address: string; // Pool PDA base58 — fill after deployment
}

// Pool addresses are derived from admin + denomination + version via PDA.
// Admin: 4PLXgVX9MumeLLjcyvYFNoKq1dECdEneiFA8StLCnf1c, Version: 0
// Deploy with: node scripts/deploy_pools.js
export const POOLS: PoolConfig[] = [
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
    address: '6PW8Wj3wGLKniRSM9rJAVSsDfY3EJPMfzxXotrvdNx6E',
  },
  {
    label: '10 SOL',
    denominationSol: 10,
    denominationLamports: 10_000_000_000n,
    address: '8WAo38JwTXFQ2hUgXs6Bh3sH6SepqLxYr5fVuaCVcTme',
  },
];
