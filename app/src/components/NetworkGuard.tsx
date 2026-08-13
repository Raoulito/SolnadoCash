import { useEffect, useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { NETWORK } from '../config';

/**
 * Network sanity checks (L-9).
 *
 * The previous version called phantom.solana.request({ method: 'disconnect' }) on
 * every connect — forcibly dropping the user's wallet session as a side effect of
 * rendering — and then showed its warning banner unconditionally, whether or not
 * anything was wrong. An always-on warning is noise, and users learn to dismiss it
 * without reading, which is worse than no warning.
 *
 * Now two real checks:
 *  1. Does the RPC endpoint actually serve the cluster the app is configured for?
 *     Verified by genesis hash. A mismatch is a hard configuration error (e.g.
 *     VITE_SOLANA_NETWORK=devnet with a mainnet VITE_RPC_ENDPOINT) and is shown
 *     as an error that cannot be dismissed.
 *  2. A one-time-per-session reminder to check the wallet's own network, because
 *     the wallet adapter exposes no reliable way to read it. Dismissible, and it
 *     stays dismissed.
 */
const GENESIS_HASHES: Record<string, string> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
};

const REMINDER_DISMISSED_KEY = 'solnadocash_network_reminder_dismissed';

export default function NetworkGuard() {
  const { connected } = useWallet();
  const { connection } = useConnection();

  const [clusterMismatch, setClusterMismatch] = useState<string | null>(null);
  const [showReminder, setShowReminder] = useState(false);

  // Check 1: the RPC endpoint must serve the configured cluster.
  useEffect(() => {
    let cancelled = false;
    const expected = GENESIS_HASHES[NETWORK];
    if (!expected) return; // unknown/custom cluster — nothing to compare against

    connection
      .getGenesisHash()
      .then((actual) => {
        if (cancelled) return;
        if (actual !== expected) {
          const actualNetwork =
            Object.entries(GENESIS_HASHES).find(([, h]) => h === actual)?.[0] ??
            'an unknown cluster';
          setClusterMismatch(
            `This app is configured for ${NETWORK}, but its RPC endpoint serves ${actualNetwork}. ` +
              `Fix VITE_RPC_ENDPOINT or VITE_SOLANA_NETWORK — deposits made now may be unrecoverable.`
          );
        }
      })
      .catch(() => {
        // Endpoint unreachable: NetworkGuard is not the right place to report that;
        // the deposit/withdraw flows surface RPC failures with context.
      });

    return () => {
      cancelled = true;
    };
  }, [connection]);

  // Check 2: one-time wallet-network reminder, only once the user has connected.
  useEffect(() => {
    if (!connected) return;
    try {
      if (sessionStorage.getItem(REMINDER_DISMISSED_KEY) !== '1') {
        setShowReminder(true);
      }
    } catch {
      setShowReminder(true);
    }
  }, [connected]);

  const dismissReminder = () => {
    try {
      sessionStorage.setItem(REMINDER_DISMISSED_KEY, '1');
    } catch {
      /* best effort */
    }
    setShowReminder(false);
  };

  if (clusterMismatch) {
    return (
      <div className="bg-red-500/10 border-b border-red-500/30 px-4 py-3">
        <div className="max-w-md mx-auto flex items-start gap-3">
          <span className="text-red-400 shrink-0 mt-0.5">&#9888;</span>
          <div className="flex-1">
            <p className="text-red-300 text-sm font-medium">Wrong network configured</p>
            <p className="text-red-400/70 text-xs mt-1 leading-relaxed">
              {clusterMismatch}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!showReminder) return null;

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-3">
      <div className="max-w-md mx-auto flex items-start gap-3">
        <span className="text-amber-400 shrink-0 mt-0.5">&#9888;</span>
        <div className="flex-1">
          <p className="text-amber-300 text-sm font-medium">
            Check your wallet is on {NETWORK}
          </p>
          <p className="text-amber-400/70 text-xs mt-1 leading-relaxed">
            Phantom: Settings → Developer Settings → Testnet Mode, then select the
            matching cluster. Transactions will fail if your wallet is elsewhere.
          </p>
        </div>
        <button
          onClick={dismissReminder}
          className="text-amber-400/50 hover:text-amber-400 text-lg leading-none shrink-0"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
