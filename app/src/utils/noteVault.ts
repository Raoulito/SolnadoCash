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

/**
 * Where notes live (L-8). Each note is its own localStorage entry, `PREFIX + note`.
 *
 * They used to share one JSON array under ARRAY_KEY, and every write rewrote the whole array. Two tabs
 * of the app share localStorage, so two tabs staging notes at about the same moment each wrote back a
 * copy of the array without the other's note, and one note was silently gone. Reproduced in two tabs
 * of one Chromium profile: with one note staged in each at the same instant, a note was lost in 83 of
 * 100 trials (security/notevault_tabs.mjs). localStorage has no compare-and-set, and a lock would make
 * staging asynchronous, which its callers must not be.
 *
 * With one key per note, a write only ever touches its own note, so tabs cannot overwrite each other.
 * The remaining race is two tabs updating the SAME note's status at once, which loses a status
 * update, never a note.
 */
const PREFIX = 'sornadocash_note_v2:';

/** The previous single-array format. Migrated into per-note keys on first read, then removed. */
const ARRAY_KEY = 'sornadocash_pending_notes_v1';

/**
 * Pre-rebrand key. A staged note is the only way to recover a deposit that may have landed, so
 * renaming the key without carrying the contents across would silently orphan any note left by
 * the previous build. Migration runs on first read and then removes the old key.
 */
const LEGACY_KEY = 'solnadocash_pending_notes_v1';

/**
 * Carry notes from both array formats into per-note keys. A note already present under its own key
 * is left as it is, since it is the newer copy. The array is removed only once every note in it has
 * been written, so a failure part-way leaves it to be retried on the next read.
 */
function migrateArrays(): void {
  for (const key of [LEGACY_KEY, ARRAY_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        localStorage.removeItem(key);
        continue;
      }
      for (const n of parsed) {
        if (!isNote(n)) continue;
        if (localStorage.getItem(PREFIX + n.note) === null) {
          localStorage.setItem(PREFIX + n.note, JSON.stringify(n));
        }
      }
      localStorage.removeItem(key);
    } catch {
      // Never let a migration failure stop the app from reading current notes.
    }
  }
}

function isNote(n: unknown): n is PendingNote {
  return typeof (n as { note?: unknown })?.note === 'string' && (n as { note: string }).note.startsWith('sndo_');
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
    if (e.key === null || e.key.startsWith(PREFIX) || e.key === ARRAY_KEY) handler();
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
  /**
   * When the deposit was actually handed to `sendTransaction`, as opposed to when the note was
   * staged. Absent while the status is 'unsent'.
   *
   * These are not the same instant and the difference is security-relevant (SEC-03). A note is
   * written to storage BEFORE the wallet is asked to sign, so `createdAt` starts a clock that has
   * nothing to do with whether a transaction exists. A hardware wallet approval, a mobile handoff,
   * or a user who simply walks away can put minutes between the two. Reconciliation judges a note
   * by whether its deposit had time to land, which is a question about broadcast time only — so it
   * reads this field and refuses to judge a note that does not have one.
   */
  sentAt?: number;
  /**
   * Which page load staged this note (M-3). The recovery banner shows every pending note,
   * including the one for a deposit in progress in this tab, and used to label all of them "from an
   * earlier session", which invited discarding the note of the deposit being made. Absent on notes
   * stored before this field existed, which are therefore treated as earlier-session notes.
   */
  session?: string;
}

/** Identifies this page load. Not a secret: it only tells notes staged now from older ones. */
const SESSION_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

/** True if the note was staged during this page load. */
export function stagedThisSession(note: PendingNote): boolean {
  return note.session === SESSION_ID;
}

function readAll(): PendingNote[] {
  const notes: PendingNote[] = [];
  try {
    migrateArrays();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      try {
        const n = JSON.parse(localStorage.getItem(key) ?? 'null');
        if (isNote(n) && PREFIX + n.note === key) notes.push(n);
      } catch {
        // One corrupt entry must not hide the others.
      }
    }
  } catch {
    // Storage unavailable: nothing can be read.
  }
  return notes;
}

function readOne(note: string): PendingNote | null {
  try {
    migrateArrays();
    const n = JSON.parse(localStorage.getItem(PREFIX + note) ?? 'null');
    return isNote(n) ? n : null;
  } catch {
    return null;
  }
}

/** Write one note under its own key. Other notes are never read or rewritten. */
function writeOne(entry: PendingNote): boolean {
  try {
    localStorage.setItem(PREFIX + entry.note, JSON.stringify(entry));
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
export function stageNote(
  entry: Omit<PendingNote, 'status' | 'createdAt' | 'session'>
): boolean {
  return writeOne({ ...entry, status: 'unsent', createdAt: Date.now(), session: SESSION_ID });
}

export function markNoteStatus(
  note: string,
  status: PendingNote['status'],
  signature?: string
): void {
  const n = readOne(note);
  if (!n) return;
  writeOne({
    ...n,
    status,
    signature: signature ?? n.signature,
    // Stamp the first transition out of 'unsent'. Reconciliation measures its grace period from
    // this, never from createdAt (SEC-03). Preserved once set so a later 'confirmed' transition
    // does not push the clock forward.
    sentAt: status === 'unsent' ? n.sentAt : (n.sentAt ?? Date.now()),
  });
}

/** Called only when the user has confirmed the note is saved elsewhere. */
export function clearNote(note: string): void {
  try {
    localStorage.removeItem(PREFIX + note);
    notifyChanged();
  } catch {
    // Storage unavailable: nothing to remove.
  }
}

/**
 * Tests only: overwrite fields of a stored note, bypassing the normal transitions, so tests can
 * describe a note's history without depending on how notes are stored.
 */
export function __patchNoteForTest(note: string, fields: Partial<PendingNote>): void {
  const n = readOne(note);
  if (n) writeOne({ ...n, ...fields });
}

/** Tests only: store a note exactly as given, as an earlier build or page load would have. */
export function __putNoteForTest(entry: PendingNote): void {
  writeOne(entry);
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
