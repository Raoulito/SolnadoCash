// app/src/components/AnonymitySet.test.ts
//
// This component used to display the pool's live deposit count as the anonymity set size. That
// number is now deliberately withheld, so these tests pin the decision in both directions: the
// advice is present, and no count leaks back in. A count reappearing here would be a silent
// product change, not a cosmetic one, because "0 deposits" is what discourages the first
// depositors a pool needs before it can protect anybody.

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import AnonymitySet from './AnonymitySet';

function renderFor(context: 'deposit' | 'withdraw') {
  return render(createElement(AnonymitySet, { context }));
}

describe('AnonymitySet', () => {
  afterEach(() => cleanup());

  it('states that waiting increases anonymity', () => {
    renderFor('deposit');
    expect(
      screen.getByText(/longer you wait before withdrawing, the higher your anonymity/i)
    ).toBeTruthy();
  });

  it('explains why, so the advice is not arbitrary', () => {
    renderFor('withdraw');
    expect(screen.getByText(/linked by timing alone/i)).toBeTruthy();
  });

  it('shows no deposit count in either context', () => {
    for (const context of ['deposit', 'withdraw'] as const) {
      const { container } = renderFor(context);
      const text = container.textContent ?? '';
      expect(text).not.toMatch(/\d+\s*deposits?/i);
      expect(text).not.toMatch(/anonymity set/i);
      // No bare numbers at all: the point is that no figure invites over-reading.
      expect(text).not.toMatch(/\d/);
      cleanup();
    }
  });

  it('tailors the follow-up advice to the stage the user is at', () => {
    renderFor('deposit');
    expect(screen.getByText(/leave your funds in the pool for a while/i)).toBeTruthy();
    cleanup();

    renderFor('withdraw');
    expect(screen.getByText(/waiting longer will do more for your privacy/i)).toBeTruthy();
  });

  it('takes no depositCount prop, so a count cannot be passed back in by accident', () => {
    // Type-level intent, asserted structurally: the rendered output is identical whether or not
    // a stray count is handed to it.
    const withExtra = render(
      createElement(AnonymitySet, {
        context: 'withdraw',
        // @ts-expect-error deliberately passing a removed prop
        depositCount: 12345,
      })
    );
    expect(withExtra.container.textContent).not.toContain('12345');
  });
});
