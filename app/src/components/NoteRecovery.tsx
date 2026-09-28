// app/src/components/NoteRecovery.tsx
//
// Surfaces notes that were staged for a deposit but never acknowledged (FE-1).
//
// Reaching this screen means a previous session ended between generating a note and the
// user confirming they had saved it: a crash, a closed tab, a refresh, or a confirmation
// timeout. Before the note was persisted, all of those silently destroyed the only key to a
// deposit that may well have landed on-chain. The whole point is that the note is still here.
//
// A staged note whose deposit never actually landed is harmless — it simply cannot be
// withdrawn — so the wording never asserts that funds exist, it tells the user how to check.

import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import {
  clearNote,
  onPendingNotesChanged,
  pendingNotes,
  stagedThisSession,
  type PendingNote,
} from '../utils/noteVault';
import { reconcilePendingNotes } from '../utils/noteReconcile';
import { verifyCluster } from '../utils/clusterGate';
import { EXPLORER_PRIVACY_NOTE } from './PrivacyNotice';
import { explorerTxUrl } from '../config';

export default function NoteRecovery() {
  const [notes, setNotes] = useState<PendingNote[]>(() => pendingNotes());
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  // M-3: the note awaiting its second, confirming click on Discard, if any.
  const [confirming, setConfirming] = useState<string | null>(null);

  const { connection } = useConnection();

  // Track storage rather than a mount-time snapshot: a note stranded mid-session must appear
  // without a reload, because the deposit error message tells the user to look here.
  useEffect(() => onPendingNotesChanged(() => setNotes(pendingNotes())), []);

  // Ask the chain which of these notes' deposits landed, so the banner can say so. Notes that did
  // land are marked confirmed. Reconciliation never removes a note (H-4): only the user can, below,
  // and only after confirming (M-3).
  useEffect(() => {
    let cancelled = false;

    // Confirm the cluster before reconciling. Reconciliation no longer deletes anything (H-4), but
    // marking a note 'confirmed' against the wrong chain would still be a false statement to the
    // user, so it only runs against the chain the notes belong to.
    verifyCluster(connection)
      .then((verdict) => {
        if (cancelled || !verdict.ok) return;
        return reconcilePendingNotes(connection).then(() => {
          if (!cancelled) setNotes(pendingNotes());
        });
      })
      .catch(() => {
        // Reconciliation is an optimisation, never a gate. If it fails the banner still shows
        // every note, which is the safe direction.
      });

    return () => {
      cancelled = true;
    };
  }, [connection]);

  if (notes.length === 0) return null;

  const copy = async (note: string) => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(note);
      setCopied(note);
      setCopyFailed(false);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Never leave the user believing a copy worked when it did not — this is the one
      // screen where that costs them the deposit.
      setCopyFailed(true);
    }
  };

  // M-3: removing a note is irreversible and destroys the only key to its deposit. It used to take a
  // single click, with no confirmation, even for a note whose deposit was confirmed on-chain. It now
  // takes two, and the second is offered only after saying what is at stake.
  const discard = (note: string) => {
    clearNote(note);
    setConfirming(null);
    setNotes(pendingNotes());
  };

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-4 space-y-3">
      <div>
        <p className="text-amber-400 text-sm font-medium mb-1">
          Unsaved secret {notes.length === 1 ? 'note' : 'notes'}
        </p>
        <p className="text-amber-400/70 text-xs leading-relaxed">
          A deposit was started but you never confirmed saving the note. If that deposit
          went through, this is the only way to withdraw it. Save it somewhere safe, then
          check the transaction before discarding.
        </p>
      </div>

      {notes.map((n) => (
        <div key={n.note} className="bg-zinc-900/60 rounded-lg p-3 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-zinc-500">
              {n.denominationSol} SOL · {new Date(n.createdAt).toLocaleString()} ·{' '}
              {/* M-3: this banner also shows the note of a deposit made in this tab, which used to
                  be labelled "from an earlier session". */}
              {stagedThisSession(n) ? 'this session' : 'earlier session'}
            </span>
            <span className="text-zinc-500">
              {n.status === 'confirmed'
                ? 'confirmed on-chain'
                : n.status === 'sent'
                  ? 'sent, not yet confirmed'
                  : // 'unsent' means the broadcast was not RECORDED. A crash or reload between the
                    // wallet sending and this app writing the status looks exactly the same, so
                    // "never broadcast" invited discarding a deposit that may have landed (M-3).
                    'not recorded as sent'}
            </span>
          </div>

          <p className="font-mono text-[10px] text-zinc-300 break-all select-all leading-relaxed">
            {n.note}
          </p>

          {copyFailed && (
            <p className="text-red-400 text-xs">
              Could not copy automatically. Select the text above and copy it manually.
            </p>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => copy(n.note)}
              className="flex-1 py-2 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              {copied === n.note ? 'Copied!' : 'Copy note'}
            </button>
            {n.signature && (
              <a
                href={explorerTxUrl(n.signature)}
                title={EXPLORER_PRIVACY_NOTE}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 py-2 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors text-center"
              >
                Check transaction
              </a>
            )}
            <button
              onClick={() => setConfirming(n.note)}
              className="px-3 py-2 rounded-lg text-xs font-medium text-zinc-500 hover:text-red-400 transition-colors"
              title="Remove this note from browser storage"
            >
              Discard
            </button>
          </div>

          {confirming === n.note && (
            <div
              role="alertdialog"
              aria-label="Confirm discarding this note"
              className="border border-red-500/40 bg-red-500/10 p-3 space-y-2"
            >
              <p className="text-red-300 text-xs leading-relaxed">
                {n.status === 'confirmed'
                  ? 'This deposit is confirmed on-chain. Unless you have saved this note somewhere ' +
                    'else, discarding it destroys the only way to withdraw those funds, permanently.'
                  : 'If this deposit went through, this note is the only way to withdraw it. ' +
                    'Discarding cannot be undone: save the note or check the transaction first.'}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirming(null)}
                  className="flex-1 py-2 text-xs font-medium bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors"
                >
                  Keep it
                </button>
                <button
                  onClick={() => discard(n.note)}
                  className="flex-1 py-2 text-xs font-medium bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors"
                >
                  Discard permanently
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
