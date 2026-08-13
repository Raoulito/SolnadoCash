import { RELAYER_URL, relayerTransportIsInsecure } from '../config';

export const DEPOSIT_SESSION_KEY = 'solnadocash_deposited_this_session';

/** Record that a deposit was made in this browser session (H-6). */
export function markDepositedThisSession(): void {
  try {
    sessionStorage.setItem(DEPOSIT_SESSION_KEY, '1');
  } catch {
    // sessionStorage unavailable — the warning is best-effort.
  }
}

export function depositedThisSession(): boolean {
  try {
    return sessionStorage.getItem(DEPOSIT_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * States plainly who can observe a withdrawal (H-6).
 *
 * The protocol removes the ON-CHAIN link between deposit and withdrawal. It does
 * not hide anything from the parties the browser talks to: the relayer receives
 * the recipient address and nullifier together with the request's source IP, and
 * the RPC provider sees the same IP for both the deposit and the withdrawal. The
 * UI previously claimed "Nobody can link it to you", which is false against those
 * two parties.
 */
export default function PrivacyNotice({
  sameSession,
}: {
  sameSession: boolean;
}) {
  const insecure = relayerTransportIsInsecure();
  let relayerHost = RELAYER_URL;
  try {
    relayerHost = new URL(RELAYER_URL).host;
  } catch {
    /* keep raw string */
  }

  return (
    <div className="space-y-3">
      {sameSession && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
          <p className="text-amber-400 text-sm font-medium mb-1">
            You deposited from this browser session
          </p>
          <p className="text-amber-400/70 text-xs leading-relaxed">
            Withdrawing now, from the same IP address and RPC provider, lets those
            parties correlate your deposit with this withdrawal by timing — no
            cryptography required. For meaningful privacy, withdraw later, from a
            different network.
          </p>
        </div>
      )}

      {insecure && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
          <p className="text-red-400 text-sm font-medium mb-1">
            Relayer connection is not encrypted
          </p>
          <p className="text-red-400/70 text-xs leading-relaxed">
            {relayerHost} is reached over plaintext HTTP, so anyone on the network
            path can read your recipient address. Use an https:// relayer.
          </p>
        </div>
      )}

      <details className="bg-zinc-800/30 rounded-xl p-4">
        <summary className="text-zinc-400 text-xs cursor-pointer select-none">
          Who can see this withdrawal?
        </summary>
        <div className="text-zinc-500 text-xs leading-relaxed mt-3 space-y-2">
          <p>
            <strong className="text-zinc-400">On-chain:</strong> there is no link
            between your deposit and this withdrawal. That is what the ZK proof
            guarantees.
          </p>
          <p>
            <strong className="text-zinc-400">The relayer ({relayerHost}):</strong>{' '}
            receives your recipient address and nullifier along with your IP
            address. It cannot take your funds or change the recipient, but it can
            log who asked for what.
          </p>
          <p>
            <strong className="text-zinc-400">Your RPC provider:</strong> sees the
            same IP for your deposit and your withdrawal requests.
          </p>
          <p>
            To reduce both: wait before withdrawing, use a different network path
            than the one you deposited from, and prefer a relayer you trust or run
            your own.
          </p>
        </div>
      </details>
    </div>
  );
}
