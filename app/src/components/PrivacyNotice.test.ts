// app/src/components/PrivacyNotice.test.ts
//
// L-7. The privacy notice lists who can observe a withdrawal, and named only the relayer and the RPC.
// The app also links to explorer.solana.com for the deposit, the withdrawal and every recovered note.
// Opening both from one browser shows the explorer, and whoever runs its backend, the two signatures
// from the same IP, which links them without breaking any cryptography. The explorer is a third
// observer the user chooses to involve, so the notice must say so.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import PrivacyNotice, { EXPLORER_PRIVACY_NOTE } from './PrivacyNotice';

describe('PrivacyNotice names every observer (L-7)', () => {
  afterEach(() => cleanup());

  it('names the block explorer and what it learns', () => {
    const { container } = render(createElement(PrivacyNotice, { sameSession: false }));
    const text = container.textContent ?? '';
    expect(text).toMatch(/explorer/i);
    expect(text).toContain(EXPLORER_PRIVACY_NOTE);
  });

  it('the shared note says what is linked, not only that a site is visited', () => {
    expect(EXPLORER_PRIVACY_NOTE).toMatch(/both/i);
    expect(EXPLORER_PRIVACY_NOTE).toMatch(/IP/);
  });
});
