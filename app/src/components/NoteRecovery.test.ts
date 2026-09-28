// app/src/components/NoteRecovery.test.ts
//
// M-3. The recovery banner is the one place a user can permanently destroy the only key to a
// deposit, and it made that easy: Discard removed the note on a single click with no confirmation,
// even for a note whose deposit was confirmed on-chain; the note of the deposit being made in this
// very tab was labelled "from an earlier session"; and a note whose broadcast was simply not recorded
// was labelled "never broadcast", which reads as "safe to throw away".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import NoteRecovery from './NoteRecovery';
import { __putNoteForTest, markNoteStatus, pendingNotes, stageNote } from '../utils/noteVault';

vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection: {} }),
}));
// Cluster not confirmed, so reconciliation never runs: these tests are about the banner alone.
vi.mock('../utils/clusterGate', () => ({
  verifyCluster: async () => ({ ok: false }),
}));

const POOL = 'Ftjp3fRkHE8wiJvQxcqkLSLoBt1fcpaAkPopfDmJ4G2Y';
const NOTE = `sndo_${POOL}_0000000005f5e100_${'ab'.repeat(64)}`;
const OLD_NOTE = `sndo_${POOL}_0000000005f5e100_${'cd'.repeat(64)}`;
/** A note left behind by a previous page load: stored without this session's marker. */
function stageEarlier(note: string) {
  __putNoteForTest({ note, poolAddress: POOL, denominationSol: 0.1, status: 'sent', signature: 'x', createdAt: 1, sentAt: 1 });
}

const show = () => render(createElement(NoteRecovery));

describe('NoteRecovery (M-3)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('does not discard on a single click', () => {
    stageNote({ note: NOTE, poolAddress: POOL, denominationSol: 0.1 });
    show();
    fireEvent.click(screen.getByText('Discard'));
    expect(pendingNotes()).toHaveLength(1);
    expect(within(screen.getByRole('alertdialog')).getByText(/only way to withdraw/i)).toBeTruthy();
  });

  it('keeps the note when the user backs out of the confirmation', () => {
    stageNote({ note: NOTE, poolAddress: POOL, denominationSol: 0.1 });
    show();
    fireEvent.click(screen.getByText('Discard'));
    fireEvent.click(screen.getByText('Keep it'));
    expect(pendingNotes()).toHaveLength(1);
    expect(screen.queryByText('Discard permanently')).toBeNull();
  });

  it('discards only after an explicit second confirmation', () => {
    stageNote({ note: NOTE, poolAddress: POOL, denominationSol: 0.1 });
    show();
    fireEvent.click(screen.getByText('Discard'));
    fireEvent.click(screen.getByText('Discard permanently'));
    expect(pendingNotes()).toHaveLength(0);
  });

  it('warns that funds exist when discarding a note confirmed on-chain', () => {
    stageNote({ note: NOTE, poolAddress: POOL, denominationSol: 0.1 });
    markNoteStatus(NOTE, 'confirmed', 'sig');
    show();
    fireEvent.click(screen.getByText('Discard'));
    expect(within(screen.getByRole('alertdialog')).getByText(/confirmed on-chain/i)).toBeTruthy();
  });

  it('does not label the note of a deposit made in this tab as from an earlier session', () => {
    stageNote({ note: NOTE, poolAddress: POOL, denominationSol: 0.1 });
    const { container } = show();
    expect(container.textContent).not.toMatch(/earlier session/i);
    expect(container.textContent).toMatch(/this session/i);
  });

  it('labels a note left by a previous page load as from an earlier session', () => {
    stageEarlier(OLD_NOTE);
    const { container } = show();
    expect(container.textContent).toMatch(/earlier session/i);
  });

  it('never tells the user an unconfirmed broadcast "never" happened', () => {
    stageNote({ note: NOTE, poolAddress: POOL, denominationSol: 0.1 });
    const { container } = show();
    expect(container.textContent).not.toMatch(/never broadcast/i);
    expect(container.textContent).toMatch(/not recorded as sent/i);
  });
});
