// app/src/utils/noteVault.ts
//
// Durable storage for a secret note across the window where losing it is unrecoverable.
//
// The bug this exists for (FE-1): the note was generated in a local variable, the deposit
// was broadcast, and the note reached React state only AFTER
// `connection.confirmTransaction` resolved. That call rejects on RPC timeout — routine
// under congestion, and the reason the single-argument form is deprecated — while the
// transaction itself lands. The catch block then returned the user to the confirm screen
// and the only copy of the note was garbage-collected. The SOL is in the pool, the
// commitment is in the tree, and nobody can ever withdraw it. A browser refresh or crash
// while the note was on screen had the same effect.
//
// So the note is written to localStorage BEFORE the transaction is broadcast, and removed
// only once the user has confirmed they saved it.
//
// The tradeoff, stated plainly: this puts a spendable secret on disk. That is a real cost
// and it is why the window is kept as tight as possible — the entry is created moments
// before broadcast and deleted the moment the user ticks "I saved it". During that window
// the note is already rendered in plaintext on screen, so the marginal exposure is small,
// while the alternative is silent permanent loss of the deposit. Anyone who cannot accept a
// secret touching disk should note that the alternative is not "no secret on disk", it is
// "no way to recover the deposit".

const KEY = 'sornadocash_pending_notes_v1';

/**
 * Pre-rebrand key. A staged note is the only way to recover a deposit that may have landed, so
 * renaming the key without carrying the contents across would silently orphan any note left by
 * the previous build. Migration runs on first read and then removes the old key.
 */
const LEGACY_KEY = 'solnadocash_pending_notes_v1';

function migrateLegacy(): void {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return;
    const current = localStorage.getItem(KEY);
    if (!current || current === '[]') {
      localStorage.setItem(KEY, legacy);
    } else {
      // Both present: keep every note rather than choosing one side.
      const merged = [...JSON.parse(current), ...JSON.parse(legacy)];
      const unique = merged.filter(
        (n, i) => merged.findIndex((m) => m?.note === n?.note) === i
      );
      localStorage.setItem(KEY, JSON.stringify(unique));
    }
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Never let a migration failure stop the app from reading current notes.
  }
}

/**
 * Notified whenever the set of pending notes changes, so the recovery banner reflects
 * storage instead of a snapshot taken at mount. Without this, a note stranded during the
 * current session stays invisible until a reload — and the deposit error message points the
 * user at that banner, so it has to be there.
 */
const CHANGE_EVENT = 'solnadocash:pending-notes-changed';

function notifyChanged(): void {
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Non-browser context (tests, SSR): nothing is listening.
  }
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function onPendingNotesChanged(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(CHANGE_EVENT, handler);
  // 'storage' fires for changes made in OTHER tabs, which matters if the user has the app
  // open twice.
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === KEY) handler();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener('storage', onStorage);
  };
}

export interface PendingNote {
  /** The encoded sndo_ note. */
  note: string;
  /** Pool the deposit was made into, for display. */
  poolAddress: string;
  denominationSol: number;
  /** Set once the transaction has been broadcast and we have a signature. */
  signature?: string;
  /** 'unsent' until broadcast, 'sent' after, 'confirmed' once seen on-chain. */
  status: 'unsent' | 'sent' | 'confirmed';
  createdAt: number;
}

function readAll(): PendingNote[] {
  try {
    migrateLegacy();
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (n): n is PendingNote =>
        typeof n?.note === 'string' && n.note.startsWith('sndo_')
    );
  } catch {
    return [];
  }
}

function writeAll(notes: PendingNote[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(notes));
    notifyChanged();
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a note before its deposit is broadcast.
 *
 * Returns false if storage is unavailable (private browsing, quota, disabled). The caller
 * must treat that as a blocking condition rather than proceeding, because proceeding is
 * exactly the situation this module exists to prevent.
 */
export function stageNote(entry: Omit<PendingNote, 'status' | 'createdAt'>): boolean {
  const notes = readAll().filter((n) => n.note !== entry.note);
  notes.push({ ...entry, status: 'unsent', createdAt: Date.now() });
  return writeAll(notes);
}

export function markNoteStatus(
  note: string,
  status: PendingNote['status'],
  signature?: string
): void {
  const notes = readAll().map((n) =>
    n.note === note ? { ...n, status, signature: signature ?? n.signature } : n
  );
  writeAll(notes);
}

/** Called only when the user has confirmed the note is saved elsewhere. */
export function clearNote(note: string): void {
  writeAll(readAll().filter((n) => n.note !== note));
}

/**
 * Notes that were staged but never acknowledged — i.e. a previous session ended between
 * generating a note and the user confirming they had saved it. These are what the recovery
 * banner shows.
 */
export function pendingNotes(): PendingNote[] {
  return readAll().sort((a, b) => b.createdAt - a.createdAt);
}

export function hasPendingNotes(): boolean {
  return readAll().length > 0;
}
