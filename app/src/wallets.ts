// app/src/wallets.ts
//
// The wallets the app offers. Phantom and Solflare's extension are Wallet Standard wallets, and for
// those the network comes from the RPC URL (see assertWalletChainMatches in vite.config.ts). The
// Solflare adapter below is what runs when Solflare has no extension (its web wallet, and mobile),
// and it signs for whatever network it is constructed with, which defaults to mainnet. So it is told
// the app's network explicitly.

import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import type { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { NETWORK } from './config';

export function createWallets() {
  return [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter({ network: NETWORK as WalletAdapterNetwork }),
  ];
}
