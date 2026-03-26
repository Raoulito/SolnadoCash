import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';

/**
 * Attempts to switch Phantom (or compatible wallets) to devnet on connect.
 * Shows a warning banner with instructions if auto-switch fails.
 */
export default function NetworkGuard() {
  const { connected, wallet } = useWallet();
  const [showWarning, setShowWarning] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!connected || !wallet) {
      setShowWarning(false);
      setDismissed(false);
      return;
    }

    // Try to auto-switch Phantom to devnet
    const phantom = (window as unknown as Record<string, unknown>).phantom as
      | { solana?: { request?: (args: { method: string; params?: unknown }) => Promise<unknown> } }
      | undefined;

    if (phantom?.solana?.request) {
      phantom.solana
        .request({ method: 'disconnect' })
        .then(() =>
          phantom.solana!.request!({
            method: 'connect',
            params: { onlyIfTrusted: true },
          })
        )
        .catch(() => {
          // Auto-switch not supported — show manual instructions
          setShowWarning(true);
        });

      // Always show the reminder on first connect so users double-check
      setShowWarning(true);
    } else {
      setShowWarning(true);
    }
  }, [connected, wallet]);

  if (!connected || !showWarning || dismissed) return null;

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-3">
      <div className="max-w-md mx-auto flex items-start gap-3">
        <span className="text-amber-400 shrink-0 mt-0.5">&#9888;</span>
        <div className="flex-1">
          <p className="text-amber-300 text-sm font-medium">
            Make sure your wallet is on Devnet
          </p>
          <p className="text-amber-400/70 text-xs mt-1 leading-relaxed">
            Phantom: Settings → Developer Settings → Testnet Mode → enable, then select <strong>Solana Devnet</strong>.
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-amber-400/50 hover:text-amber-400 text-lg leading-none shrink-0"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
