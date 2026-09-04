import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useClusterGate } from '../hooks/useClusterGate';
import { ALLOWED_CLUSTER } from '../utils/clusterGate';

/**
 * Anti-mainnet banner (L-9, hardened).
 *
 * The previous version of this component verified the RPC's genesis hash against `NETWORK` and
 * showed a warning. Three things were wrong with that as a safety measure:
 *
 *  - It compared configuration against configuration. `VITE_SOLANA_NETWORK=mainnet-beta` made
 *    mainnet the expected value and the check passed, so it caught misconfiguration but not the
 *    thing worth catching.
 *  - It failed open. The `.catch()` on `getGenesisHash()` was empty by design, so an unreachable
 *    or rate-limited RPC produced silence — identical to success.
 *  - It gated nothing. Every action stayed callable behind the warning.
 *
 * Now the cluster must be positively identified as {@link ALLOWED_CLUSTER} (devnet unless
 * explicitly overridden), unknown counts as blocked, and the pages disable their actions from the
 * same hook while each handler independently re-checks before moving anything.
 *
 * The wallet reminder below is kept, and kept honest: the wallet-standard adapter exposes no way
 * to read which network the user's wallet has selected, so that part is advice, not verification.
 * It is not load-bearing — a transaction goes to the cluster behind the app's own connection,
 * which is what the gate checks.
 */
const REMINDER_DISMISSED_KEY = 'sornadocash_network_reminder_dismissed';

export default function NetworkGuard() {
  const { connected } = useWallet();
  const cluster = useClusterGate();
  const [showReminder, setShowReminder] = useState(false);

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

  // Blocked: not dismissible, and the pages refuse to act while this is showing.
  if (cluster.status === 'blocked') {
    const isMainnet = cluster.cluster === 'mainnet-beta';
    return (
      <div
        role="alert"
        className="bg-red-500/10 border-b border-red-500/30 px-4 py-3"
        data-testid="cluster-blocked"
      >
        <div className="max-w-md mx-auto flex items-start gap-3">
          <span className="text-red-400 shrink-0 mt-0.5" aria-hidden="true">
            &#9888;
          </span>
          <div className="flex-1">
            <p className="text-red-300 text-sm font-medium">
              {isMainnet
                ? 'Mainnet detected — everything is disabled'
                : cluster.code === 'unverified'
                  ? 'Network not confirmed — everything is disabled'
                  : 'Wrong network — everything is disabled'}
            </p>
            <p className="text-red-400/70 text-xs mt-1 leading-relaxed">{cluster.message}</p>
            <p className="text-red-400/60 text-xs mt-2 leading-relaxed">
              This build only acts on <strong>{ALLOWED_CLUSTER}</strong>. Deposits and
              withdrawals stay blocked until it is confirmed. Any secret notes already saved in
              this browser are untouched.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (cluster.status === 'checking') {
    return (
      <div className="bg-zinc-800/40 border-b border-zinc-700/40 px-4 py-2">
        <div className="max-w-md mx-auto">
          <p className="text-zinc-400 text-xs" data-testid="cluster-checking">
            Confirming network…
          </p>
        </div>
      </div>
    );
  }

  if (!showReminder) return null;

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-3">
      <div className="max-w-md mx-auto flex items-start gap-3">
        <span className="text-amber-400 shrink-0 mt-0.5" aria-hidden="true">
          &#9888;
        </span>
        <div className="flex-1">
          <p className="text-amber-300 text-sm font-medium">
            Check your wallet is on {cluster.cluster}
          </p>
          <p className="text-amber-400/70 text-xs mt-1 leading-relaxed">
            This app is confirmed on {cluster.cluster}, so that is where funds move. Your wallet
            may still be set elsewhere, which the adapter cannot read — if it is, signing will
            fail or your wallet will warn you. Phantom: Settings → Developer Settings → Testnet
            Mode, then pick {cluster.cluster}.
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
