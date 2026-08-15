// app/src/pages/Faq.test.ts
//
// The FAQ is the only place a newcomer is told, in plain language, the three things that actually
// cost people money: losing the note is unrecoverable, withdrawing immediately defeats the point,
// and this software is unaudited with a single-party setup. Marketing copy tends to lose exactly
// those sentences over time, so they are pinned here.
//
// Also pinned: the page must not contradict the rest of the app. It is easy to write "completely
// anonymous" in a FAQ and forget that the withdraw screen admits the relayer sees your IP.

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
import Faq from './Faq';

function renderFaq(onGoToDeposit = () => {}) {
  return render(createElement(Faq, { onGoToDeposit }));
}

describe('FAQ page', () => {
  afterEach(() => cleanup());

  it('answers why, how, and the steps', () => {
    renderFaq();
    expect(screen.getByText(/Why would I want this/i)).toBeTruthy();
    expect(screen.getByText(/How does it work/i)).toBeTruthy();
    expect(screen.getByText(/Step by step/i)).toBeTruthy();
    expect(screen.getByText(/What does it cost/i)).toBeTruthy();
  });

  it('explains the mechanism without requiring cryptography knowledge', () => {
    renderFaq();
    // The coat-check analogy carries the explanation; jargon is introduced only after it.
    expect(screen.getByText(/coat check/i)).toBeTruthy();
    expect(screen.getByText(/without revealing which deposit it belongs to/i)).toBeTruthy();
  });

  it('numbers the steps in order', () => {
    const { container } = renderFaq();
    const numbers = [...container.querySelectorAll('span')]
      .map((s) => s.textContent)
      .filter((t) => /^[1-7]$/.test(t ?? ''));
    expect(numbers).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('states that a lost note cannot be recovered', () => {
    renderFaq();
    expect(screen.getByText(/Nobody can recover it for you/i)).toBeTruthy();
    expect(screen.getByText(/cannot be recovered, by you or by anyone else/i)).toBeTruthy();
  });

  it('tells the user to wait, and says why', () => {
    renderFaq();
    expect(screen.getByText(/anyone comparing the\s+two lists can guess they belong together/i)).toBeTruthy();
  });

  it('discloses that the software is unaudited and the setup single-party', () => {
    renderFaq();
    expect(screen.getByText(/has not been audited/i)).toBeTruthy();
    expect(screen.getByText(/create fake proofs/i)).toBeTruthy();
    expect(screen.getByText(/Read this before using real money/i)).toBeTruthy();
  });

  it('does not claim more privacy than the withdraw screen admits', () => {
    const { container } = renderFaq();
    const text = (container.textContent ?? '').toLowerCase();
    // The app tells users elsewhere that the relayer and RPC provider see their IP. The FAQ must
    // not contradict that with an absolute claim.
    expect(text).not.toContain('untraceable');
    expect(text).not.toContain('completely anonymous');
    expect(text).not.toContain('nobody can link it to you');
    // And it must state the IP limitation itself.
    expect(text).toContain('does not hide your ip');
  });

  it('routes the user to a deposit', () => {
    let clicked = 0;
    renderFaq(() => clicked++);
    fireEvent.click(screen.getByText('Start a deposit'));
    expect(clicked).toBe(1);
  });

  it('uses no em dashes', () => {
    const { container } = renderFaq();
    expect(container.textContent).not.toContain('\u2014');
  });

  it('keeps answers collapsed until asked for, so the page is skimmable', () => {
    const { container } = renderFaq();
    const details = [...container.querySelectorAll('details')];
    expect(details.length).toBeGreaterThanOrEqual(8);
    expect(details.every((d) => !(d as HTMLDetailsElement).open)).toBe(true);
  });
});
