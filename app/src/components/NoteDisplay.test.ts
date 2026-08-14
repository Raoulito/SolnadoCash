// app/src/components/NoteDisplay.test.ts
//
// FE-5: losing the note loses the deposit, so the copy button must never fail silently. Both
// failure modes are covered: the Clipboard API missing entirely (HTTP origin), and writeText
// rejecting (permission denied).

import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import NoteDisplay from './NoteDisplay';

const NOTE = 'sndo_pool_1000000000_deadbeef';

function renderNote() {
  return render(createElement(NoteDisplay, { note: NOTE, onDone: () => {} }));
}

describe('NoteDisplay copy', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('reports success when the clipboard works', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderNote();

    fireEvent.click(screen.getByText('Copy to clipboard'));
    await waitFor(() => expect(screen.getByText('Copied!')).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(NOTE);
  });

  it('tells the user when the Clipboard API is unavailable', async () => {
    // A page served over plaintext HTTP from a non-localhost origin.
    vi.stubGlobal('navigator', {});
    renderNote();

    fireEvent.click(screen.getByText('Copy to clipboard'));
    await waitFor(() => expect(screen.getByText('Copy failed')).toBeTruthy());
    expect(screen.getByText(/Could not copy automatically/)).toBeTruthy();
    expect(screen.getByText(/only way to withdraw/)).toBeTruthy();
  });

  it('tells the user when the clipboard write is denied', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('NotAllowedError');
        }),
      },
    });
    renderNote();

    fireEvent.click(screen.getByText('Copy to clipboard'));
    await waitFor(() => expect(screen.getByText('Copy failed')).toBeTruthy());
  });

  it('keeps Done disabled until the user confirms they saved the note', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
    renderNote();

    const done = screen.getByText('Done') as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect((screen.getByText('Done') as HTMLButtonElement).disabled).toBe(false);
  });
});
