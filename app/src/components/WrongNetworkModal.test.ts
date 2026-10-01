// app/src/components/WrongNetworkModal.test.ts
//
// G12. The deposit form, and with it this modal, render inside a card with an entry animation. An
// element with a transform, even an animated or identity one, is the containing block of every
// position:fixed element inside it, so the "full-screen" modal was confined to the card: measured in
// the built page, at 1280x800 it covered 1074x200 px starting 951 px down the page, entirely below the
// viewport, instead of the whole screen. That is the modal shown to wallets with no devnet SOL, which
// is most first-time visitors. It now renders into document.body, outside any such ancestor.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import WrongNetworkModal from './WrongNetworkModal';

describe('WrongNetworkModal', () => {
  afterEach(() => cleanup());

  it('renders directly into document.body, outside the component that uses it', () => {
    // Stand-in for the animated card the deposit form lives in.
    const card = document.createElement('div');
    card.style.transform = 'translateY(4px)';
    document.body.appendChild(card);
    try {
      render(createElement(WrongNetworkModal, { message: 'No devnet SOL at this address.', onRetry: () => {} }), {
        container: card,
      });
      const modal = screen.getByTestId('wrong-network-modal');
      expect(card.contains(modal)).toBe(false);
      expect(modal.parentElement).toBe(document.body);
    } finally {
      card.remove();
    }
  });

  it('is still a labelled modal dialog with its message and retry button', () => {
    render(createElement(WrongNetworkModal, { message: 'No devnet SOL at this address.', onRetry: () => {} }));
    const modal = screen.getByRole('dialog', { name: /switch your wallet/i });
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.textContent).toContain('No devnet SOL at this address.');
    expect(screen.getByRole('button', { name: /check again/i })).toBeTruthy();
  });
});
