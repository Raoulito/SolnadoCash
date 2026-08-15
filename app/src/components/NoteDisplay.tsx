import { useState } from 'react';

interface NoteDisplayProps {
  note: string;
  onDone: () => void;
}

export default function NoteDisplay({ note, onDone }: NoteDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  /**
   * FE-5: this used to be a bare `await navigator.clipboard.writeText(note)`. On a page served
   * over plaintext HTTP from anything but localhost the Clipboard API is unavailable, so
   * `navigator.clipboard` is undefined and the click threw a TypeError that went nowhere —
   * the button did nothing, silently. A denied permission produced the same silence via an
   * unhandled rejection. This is the one screen in the app where believing a copy worked when
   * it did not costs the user their deposit, so a failure has to be visible and has to point
   * at the manual route.
   */
  const handleCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(note);
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
      setCopied(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Warning */}
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
        <p className="text-amber-400 text-sm font-semibold mb-1">
          Save this secret note!
        </p>
        <p className="text-amber-300 text-[15px] sm:text-base font-bold leading-snug mb-2">
          This note is the only way to withdraw your funds.
        </p>
        <p className="text-amber-400/70 text-xs leading-relaxed">
          If you lose it, your deposit is gone forever. No one can recover it.
        </p>
      </div>

      {/* Note */}
      <div
        className="bg-zinc-800 rounded-xl p-4 font-mono text-xs text-zinc-300 break-all leading-relaxed cursor-pointer hover:bg-zinc-750 transition-colors select-all"
        onClick={handleCopy}
      >
        {note}
      </div>

      {/* Copy button */}
      <button
        onClick={handleCopy}
        className={`w-full py-3 rounded-xl font-medium text-sm transition-all ${
          copied
            ? 'bg-green-600/20 text-green-400 border border-green-500/30'
            : copyFailed
              ? 'bg-red-500/10 text-red-400 border border-red-500/30'
              : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
        }`}
      >
        {copied ? 'Copied!' : copyFailed ? 'Copy failed' : 'Copy to clipboard'}
      </button>

      {copyFailed && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
          <p className="text-red-400 text-sm font-medium mb-1">
            Could not copy automatically
          </p>
          <p className="text-red-400/70 text-xs leading-relaxed">
            Your browser blocked clipboard access. This happens on pages not served over
            HTTPS. Select the note above and copy it manually, or write it down. Do not
            continue until you have saved it somewhere.
          </p>
        </div>
      )}

      {/* Confirmation checkbox */}
      <label className="flex items-start gap-3 cursor-pointer group">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-1 w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-cyan-500 focus:ring-cyan-500/30"
        />
        <span className="text-zinc-400 text-xs leading-relaxed group-hover:text-zinc-300 transition-colors">
          I have saved my secret note in a safe place. I understand that
          losing it means losing my funds permanently.
        </span>
      </label>

      {/* Done button */}
      <button
        onClick={onDone}
        disabled={!confirmed}
        className={`w-full py-3.5 rounded-xl font-semibold text-sm transition-all ${
          confirmed
            ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
            : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
        }`}
      >
        Done
      </button>
    </div>
  );
}
