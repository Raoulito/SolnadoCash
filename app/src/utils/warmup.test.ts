// app/src/utils/warmup.test.ts
//
// The background Poseidon warm-up must not compete with the first render (it waits for the load event
// and idle time), must run exactly once, must never surface an error (a deposit calls initPoseidon()
// itself and gets its own error), and must not make a visitor who only reads the landing page download
// the hashing library: on a page with the app section it starts only as that section approaches.

import { describe, expect, it, vi } from 'vitest';
import { WARM_AHEAD, warmPoseidon } from './warmup';

type Entry = { isIntersecting: boolean };

/** A fake window. `section` adds a #try element; `observer` adds an IntersectionObserver. */
function fakeWindow(readyState: string, opts: { idle?: boolean; section?: boolean; observer?: boolean } = {}) {
  const { idle: withIdle = true, section = false, observer = false } = opts;
  const listeners: Record<string, () => void> = {};
  const idle: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const observers: Array<{ cb: (e: Entry[]) => void; options: { rootMargin?: string }; observed: unknown[]; disconnected: boolean }> = [];
  const el = { id: 'try' };
  class FakeObserver {
    rec: (typeof observers)[number];
    constructor(cb: (e: Entry[]) => void, options: { rootMargin?: string }) {
      this.rec = { cb, options, observed: [], disconnected: false };
      observers.push(this.rec);
    }
    observe(t: unknown) {
      this.rec.observed.push(t);
    }
    disconnect() {
      this.rec.disconnected = true;
    }
  }
  const win = {
    document: {
      readyState,
      ...(section ? { querySelector: (s: string) => (s === '#try' ? el : null) } : {}),
    },
    addEventListener: (type: string, cb: () => void) => (listeners[type] = cb),
    setTimeout: (cb: () => void) => (timers.push(cb), 1),
    ...(withIdle ? { requestIdleCallback: (cb: () => void) => (idle.push(cb), 1) } : {}),
    ...(observer ? { IntersectionObserver: FakeObserver } : {}),
  };
  return { win: win as never, listeners, idle, timers, observers, el };
}

describe('warmPoseidon on a page without the app section (the app on its own)', () => {
  it('waits for the load event, then for idle time, then builds Poseidon once', () => {
    const init = vi.fn(() => Promise.resolve());
    const w = fakeWindow('interactive');
    warmPoseidon(w.win, init);
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
    const w = fakeWindow('complete');
    warmPoseidon(w.win, init);
    w.idle[0]();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('falls back to a short timer where requestIdleCallback does not exist (Safari)', () => {
    const init = vi.fn(() => Promise.resolve());
    const w = fakeWindow('complete', { idle: false });
    warmPoseidon(w.win, init);
    expect(w.timers).toHaveLength(1);
    w.timers[0]();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('never lets a failed load become an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const w = fakeWindow('complete');
      warmPoseidon(w.win, () => Promise.reject(new Error('offline')));
      w.idle[0]();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('warmPoseidon on the landing page (app section below)', () => {
  it('does not download anything for a visitor who stays on the landing page', () => {
    const init = vi.fn(() => Promise.resolve());
    const w = fakeWindow('complete', { section: true, observer: true });
    warmPoseidon(w.win, init);
    w.idle[0]();
    expect(w.observers).toHaveLength(1);
    expect(w.observers[0].observed).toEqual([w.el]);
    w.observers[0].cb([{ isIntersecting: false }]); // the initial report: far below the viewport
    expect(init).not.toHaveBeenCalled();
  });

  it('starts ahead of the section, once, when it approaches the viewport', () => {
    const init = vi.fn(() => Promise.resolve());
    const w = fakeWindow('complete', { section: true, observer: true });
    warmPoseidon(w.win, init);
    w.idle[0]();
    const ahead = parseInt(w.observers[0].options.rootMargin ?? '0', 10);
    expect(ahead).toBeGreaterThanOrEqual(1000); // starts well before the section is on screen
    expect(w.observers[0].options.rootMargin).toBe(WARM_AHEAD);
    w.observers[0].cb([{ isIntersecting: true }]);
    expect(init).toHaveBeenCalledTimes(1);
    expect(w.observers[0].disconnected).toBe(true);
  });

  it('builds on idle, as before, where IntersectionObserver does not exist', () => {
    const init = vi.fn(() => Promise.resolve());
    const w = fakeWindow('complete', { section: true, observer: false });
    warmPoseidon(w.win, init);
    w.idle[0]();
    expect(init).toHaveBeenCalledTimes(1);
  });
});
