import { clusterApiUrl } from '@solana/web3.js';

export const NETWORK = 'devnet' as const;
export const RPC_ENDPOINT = clusterApiUrl('devnet');
export const RELAYER_URL = 'http://localhost:3000';
export const PROGRAM_ID = 'DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59';

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
