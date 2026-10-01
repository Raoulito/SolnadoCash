// app/src/utils/warmup.test.ts
//
// The background Poseidon warm-up must not compete with the first render (it waits for the load event
// and idle time), must run exactly once, and must never surface an error: a deposit calls
// initPoseidon() itself and gets its own error if loading really fails.

import { describe, expect, it, vi } from 'vitest';
import { warmPoseidonWhenIdle } from './warmup';

function fakeWindow(readyState: string, withIdle: boolean) {
  const listeners: Record<string, () => void> = {};
  const idle: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const win = {
    document: { readyState },
    addEventListener: (type: string, cb: () => void) => (listeners[type] = cb),
    setTimeout: (cb: () => void) => (timers.push(cb), 1),
    ...(withIdle ? { requestIdleCallback: (cb: () => void) => (idle.push(cb), 1) } : {}),
  };
  return { win: win as never, listeners, idle, timers };
}

describe('warmPoseidonWhenIdle', () => {
  it('waits for the load event, then for idle time, then builds Poseidon once', () => {
    const init = vi.fn(() => Promise.resolve());
    const w = fakeWindow('interactive', true);
    warmPoseidonWhenIdle(w.win, init);
    expect(init).not.toHaveBeenCalled();
    expect(w.idle).toHaveLength(0);
    w.listeners.load();
    expect(init).not.toHaveBeenCalled();
    expect(w.idle).toHaveLength(1);
    w.idle[0]();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('starts straight away (on idle) when the page has already loaded', () => {
    const init = vi.fn(() => Promise.resolve());
    const w = fakeWindow('complete', true);
    warmPoseidonWhenIdle(w.win, init);
    w.idle[0]();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('falls back to a short timer where requestIdleCallback does not exist (Safari)', () => {
    const init = vi.fn(() => Promise.resolve());
    const w = fakeWindow('complete', false);
    warmPoseidonWhenIdle(w.win, init);
    expect(w.timers).toHaveLength(1);
    w.timers[0]();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('never lets a failed load become an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const w = fakeWindow('complete', true);
      warmPoseidonWhenIdle(w.win, () => Promise.reject(new Error('offline')));
      w.idle[0]();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
