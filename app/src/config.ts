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

export const POOLS: PoolConfig[] = [
  {
    label: '0.1 SOL',
    denominationSol: 0.1,
    denominationLamports: 100_000_000n,
    address: '',
  },
  {
    label: '1 SOL',
    denominationSol: 1,
    denominationLamports: 1_000_000_000n,
    address: '',
  },
  {
    label: '10 SOL',
    denominationSol: 10,
    denominationLamports: 10_000_000_000n,
    address: '',
  },
];
