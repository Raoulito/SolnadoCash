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
import {
  clearNote,
  onPendingNotesChanged,
  pendingNotes,
  type PendingNote,
} from '../utils/noteVault';
import { explorerTxUrl } from '../config';

export default function NoteRecovery() {
  const [notes, setNotes] = useState<PendingNote[]>(() => pendingNotes());
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  // Track storage rather than a mount-time snapshot: a note stranded mid-session must appear
  // without a reload, because the deposit error message tells the user to look here.
  useEffect(() => onPendingNotesChanged(() => setNotes(pendingNotes())), []);

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

  const discard = (note: string) => {
    clearNote(note);
    setNotes(pendingNotes());
  };

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-4 space-y-3">
      <div>
        <p className="text-amber-400 text-sm font-medium mb-1">
          Unsaved secret {notes.length === 1 ? 'note' : 'notes'} from an earlier session
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
              {n.denominationSol} SOL · {new Date(n.createdAt).toLocaleString()}
            </span>
            <span className="text-zinc-500">
              {n.status === 'confirmed'
                ? 'confirmed on-chain'
                : n.status === 'sent'
                  ? 'sent, not confirmed'
                  : 'never broadcast'}
            </span>
          </div>

          <p className="font-mono text-[10px] text-zinc-300 break-all select-all leading-relaxed">
            {n.note}
          </p>

          {copyFailed && (
            <p className="text-red-400 text-xs">
              Could not copy automatically — select the text above and copy it manually.
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
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 py-2 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors text-center"
              >
                Check transaction
              </a>
            )}
            <button
              onClick={() => discard(n.note)}
              className="px-3 py-2 rounded-lg text-xs font-medium text-zinc-500 hover:text-red-400 transition-colors"
              title="Remove this note from browser storage"
            >
              Discard
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
