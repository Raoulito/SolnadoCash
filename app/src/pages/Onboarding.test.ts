// app/src/pages/Onboarding.test.ts
//
// The splash screen is the only place a first-time user is told that the secret note is the
// sole way to recover a deposit. It gates on two independent conditions, and both must hold:
// a countdown so the screen cannot be clicked through instantly, and an explicit
// acknowledgement. Either one alone must not be enough.

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { createElement } from 'react';
import Onboarding from './Onboarding';

const LOCK_SECONDS = 10;

function renderOnboarding(onDismiss = () => {}) {
  return render(createElement(Onboarding, { onDismiss }));
}

const button = () => screen.getByRole('button') as HTMLButtonElement;
const checkbox = () => screen.getByRole('checkbox');

/** Advance the countdown by n seconds. */
function tick(seconds: number) {
  act(() => {
    vi.advanceTimersByTime(seconds * 1000);
  });
}

describe('Onboarding gate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('starts locked, showing the remaining seconds', () => {
    renderOnboarding();
    expect(button().disabled).toBe(true);
    expect(button().textContent).toMatch(/Please read \(10s\)/);
  });

  it('counts down visibly', () => {
    renderOnboarding();
    tick(3);
    expect(button().textContent).toMatch(/\(7s\)/);
  });

  it('stays locked after the countdown if the box is not ticked', () => {
    renderOnboarding();
    tick(LOCK_SECONDS);
    expect(button().textContent).toMatch(/Get Started/);
    expect(button().disabled).toBe(true);
    expect(screen.getByText(/Tick the box above to continue/)).toBeTruthy();
  });

  it('stays locked if the box is ticked before the countdown finishes', () => {
    renderOnboarding();
    fireEvent.click(checkbox());
    tick(LOCK_SECONDS - 2);
    expect(button().disabled).toBe(true);
  });

  it('unlocks only when the countdown has finished AND the box is ticked', () => {
    renderOnboarding();
    tick(LOCK_SECONDS);
    fireEvent.click(checkbox());
    expect(button().disabled).toBe(false);
    expect(button().textContent).toMatch(/Get Started/);
  });

  it('re-locks if the box is un-ticked', () => {
    renderOnboarding();
    tick(LOCK_SECONDS);
    fireEvent.click(checkbox());
    expect(button().disabled).toBe(false);
    fireEvent.click(checkbox());
    expect(button().disabled).toBe(true);
  });

  it('does not dismiss while locked, even if the button is clicked', () => {
    const onDismiss = vi.fn();
    renderOnboarding(onDismiss);
    fireEvent.click(button());
    tick(5);
    fireEvent.click(button());
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses once both conditions are met', () => {
    const onDismiss = vi.fn();
    renderOnboarding(onDismiss);
    tick(LOCK_SECONDS);
    fireEvent.click(checkbox());
    fireEvent.click(button());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('offers no other way out: no close control anywhere on the dialog', () => {
    renderOnboarding();
    // Exactly one button, the gated CTA. No dismiss, no skip, no X.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByLabelText(/dismiss|close/i)).toBeNull();
  });

  it('states the thing that actually loses people money', () => {
    renderOnboarding();
    expect(screen.getByText(/only way to withdraw your funds/i)).toBeTruthy();
    expect(screen.getByText(/I understand how to use SolnadoCash/)).toBeTruthy();
  });

  it('contains no em dashes in any visible text', () => {
    const { container } = renderOnboarding();
    expect(container.textContent).not.toContain('\u2014');
  });
});
