// app/src/utils/noteVault.test.ts
//
// FE-1 was a fund-loss bug: the note reached React state only after
// confirmTransaction resolved, so a confirmation timeout on a landed deposit destroyed the
// only key to it. These tests pin the property that makes that impossible — a note is
// durable from before broadcast until the user explicitly acknowledges it — and check the
// failure paths rather than just the happy one.

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import {
  stageNote, markNoteStatus, clearNote, pendingNotes, hasPendingNotes,
} from './noteVault';

const NOTE = 'sndo_pool_1000000000_abcdef0123456789';
const NOTE2 = 'sndo_pool_100000000_9876543210fedcba';

describe('noteVault', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('survives the window between staging and acknowledgement', () => {
    expect(hasPendingNotes()).toBe(false);
    expect(
      stageNote({ note: NOTE, poolAddress: 'pool', denominationSol: 1 })
    ).toBe(true);

    // This is the state a crashed or timed-out session leaves behind: still recoverable.
    expect(hasPendingNotes()).toBe(true);
    expect(pendingNotes()[0].note).toBe(NOTE);
    expect(pendingNotes()[0].status).toBe('unsent');
  });

  it('records broadcast and confirmation without dropping the note', () => {
    stageNote({ note: NOTE, poolAddress: 'pool', denominationSol: 1 });
    markNoteStatus(NOTE, 'sent', 'sig123');
    expect(pendingNotes()[0]).toMatchObject({ status: 'sent', signature: 'sig123' });

    markNoteStatus(NOTE, 'confirmed', 'sig123');
    // Still present: confirmation is not acknowledgement. Only the user saying "I saved it"
    // may remove it.
    expect(pendingNotes()[0]).toMatchObject({ status: 'confirmed', signature: 'sig123' });
    expect(hasPendingNotes()).toBe(true);
  });

  it('removes the note only on explicit acknowledgement', () => {
    stageNote({ note: NOTE, poolAddress: 'pool', denominationSol: 1 });
    clearNote(NOTE);
    expect(hasPendingNotes()).toBe(false);
  });

  it('keeps multiple stranded notes and clears them independently', () => {
    stageNote({ note: NOTE, poolAddress: 'pool', denominationSol: 1 });
    stageNote({ note: NOTE2, poolAddress: 'pool2', denominationSol: 0.1 });
    expect(pendingNotes()).toHaveLength(2);

    clearNote(NOTE);
    const left = pendingNotes();
    expect(left).toHaveLength(1);
    expect(left[0].note).toBe(NOTE2);
  });

  it('does not duplicate a note staged twice', () => {
    stageNote({ note: NOTE, poolAddress: 'pool', denominationSol: 1 });
    stageNote({ note: NOTE, poolAddress: 'pool', denominationSol: 1 });
    expect(pendingNotes()).toHaveLength(1);
  });

  it('returns newest first, so the most recent deposit is shown first', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    stageNote({ note: NOTE, poolAddress: 'pool', denominationSol: 1 });
    vi.spyOn(Date, 'now').mockReturnValue(2000);
    stageNote({ note: NOTE2, poolAddress: 'pool2', denominationSol: 0.1 });
    expect(pendingNotes()[0].note).toBe(NOTE2);
  });

  it('reports failure when storage is unavailable, so the caller can refuse to deposit', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(
      stageNote({ note: NOTE, poolAddress: 'pool', denominationSol: 1 })
    ).toBe(false);
  });

  it('ignores corrupt storage rather than throwing during render', () => {
    localStorage.setItem('solnadocash_pending_notes_v1', '{not an array');
    expect(pendingNotes()).toEqual([]);
    localStorage.setItem('solnadocash_pending_notes_v1', '{"a":1}');
    expect(pendingNotes()).toEqual([]);
  });

  it('drops entries that are not notes', () => {
    localStorage.setItem(
      'solnadocash_pending_notes_v1',
      JSON.stringify([{ note: 'not-a-note' }, { note: NOTE, createdAt: 1 }])
    );
    const got = pendingNotes();
    expect(got).toHaveLength(1);
    expect(got[0].note).toBe(NOTE);
  });
});
