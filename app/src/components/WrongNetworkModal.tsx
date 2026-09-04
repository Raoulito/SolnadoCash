import { ALLOWED_CLUSTER } from '../utils/clusterGate';

interface Props {
  /** Why the deposit is blocked, already phrased for the user. */
  message: string;
  /** Re-run the check without a page reload. */
  onRetry: () => void;
  retrying?: boolean;
}

/**
 * Blocking modal shown when the connected wallet cannot fund a deposit on {@link ALLOWED_CLUSTER}.
 *
 * The honesty of the copy matters here. It does NOT claim to have detected the wallet's network,
 * because that is not readable (see utils/walletCluster.ts). It reports what was actually measured
 * — no usable balance on this cluster — and names the switch as the likely fix, which is both true
 * and actionable.
 *
 * Deliberately not dismissible. A dismissible warning on the one screen that spends money is a
 * warning users learn to click through.
 */
export default function WrongNetworkModal({ message, onRetry, retrying = false }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wrong-network-title"
      data-testid="wrong-network-modal"
    >
      <div className="w-full max-w-md bg-zinc-900 border border-amber-500/30 rounded-2xl p-6 space-y-4">
        <div className="flex items-start gap-3">
          <span className="text-amber-400 text-xl shrink-0" aria-hidden="true">
            &#9888;
          </span>
          <div>
            <h2 id="wrong-network-title" className="text-base font-semibold text-amber-300">
              Switch your wallet to {ALLOWED_CLUSTER}
            </h2>
            <p className="text-zinc-400 text-sm mt-1.5 leading-relaxed">{message}</p>
          </div>
        </div>

        <div className="bg-zinc-800/50 rounded-xl p-4 space-y-2">
          <p className="text-zinc-300 text-xs font-medium">Phantom</p>
          <ol className="text-zinc-400 text-xs space-y-1 list-decimal pl-4 leading-relaxed">
            <li>Settings → Developer Settings</li>
            <li>Enable Testnet Mode</li>
            <li>Select Solana {ALLOWED_CLUSTER}</li>
            <li>
              Fund it:{' '}
              <code className="text-zinc-300">solana airdrop 1 &lt;address&gt; --url {ALLOWED_CLUSTER}</code>{' '}
              or use faucet.solana.com
            </li>
          </ol>
        </div>

        <p className="text-zinc-500 text-xs leading-relaxed">
          Your mainnet funds are not at risk either way: this app builds transactions against the{' '}
          {ALLOWED_CLUSTER} program with a {ALLOWED_CLUSTER} blockhash and submits them to a{' '}
          {ALLOWED_CLUSTER} endpoint, so mainnet lamports cannot be spent here. Deposits stay
          blocked until this wallet can pay on {ALLOWED_CLUSTER}.
        </p>

        <button
          onClick={onRetry}
          disabled={retrying}
          className="w-full py-3 btn-primary text-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {retrying ? 'Checking…' : 'I switched — check again'}
        </button>
      </div>
    </div>
  );
}
