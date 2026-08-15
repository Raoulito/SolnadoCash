import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
// Imported from the individual adapter packages rather than @solana/wallet-adapter-wallets.
// The meta-package depends on every adapter it knows about — Trezor, Ledger, WalletConnect and
// the rest — which pulled in ethers, axios and protobufjs and 133 advisories including two
// critical (protobufjs arbitrary code execution, via @trezor/transport). Tree-shaking kept most
// of it out of the bundle, but it was still installed and executing postinstall scripts on every
// npm install, which is the wrong attack surface for an app that holds secret notes.
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';

import '@solana/wallet-adapter-react-ui/styles.css';
import './index.css';

import App from './App';
import { RPC_ENDPOINT } from './config';

function Providers({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
  ], []);

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
