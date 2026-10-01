// app/src/utils/warmup.ts
//
// The SDK loads circomlibjs (Poseidon) on first use rather than at startup, so the landing page no
// longer waits for it. A deposit needs Poseidon the moment the user confirms, though, and a cold load
// is about 1.3 MB of compressed JavaScript plus building the hasher. So it is fetched and built in
// the background before it is needed: when the app section (#try) comes within about two screens of
// the viewport. A visitor who only reads the landing page never downloads it. A page without that
// section (the app on its own) warms it as soon as the browser is idle after load.
//
// Nothing depends on this for correctness: every path that hashes calls initPoseidon() itself, and
// gets its own error if loading fails. So any failure here is ignored.
//
// snarkjs is not warmed. It is only used to prove a withdrawal, which already downloads 7.8 MB of
// circuit files, so prefetching it would cost more than it saves.

import { initPoseidon } from '@solnadocash/sdk';

type WarmWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
};

/** How far ahead of the app section the download starts. */
export const WARM_AHEAD = '1500px 0px';

/** Run `fn` once the page has loaded and the browser is idle, so it never competes with first paint. */
function whenIdle(win: WarmWindow, fn: () => void): void {
  const start = () => {
    if (typeof win.requestIdleCallback === 'function') win.requestIdleCallback(fn, { timeout: 5000 });
    else win.setTimeout(fn, 1500);
  };
  if (win.document.readyState === 'complete') start();
  else win.addEventListener('load', start, { once: true });
}

export function warmPoseidon(
  win: WarmWindow = window,
  init: () => Promise<void> = initPoseidon,
  selector = '#try'
): void {
  const run = () => {
    init().catch(() => {});
  };
  // Looked up after load and idle, when React has certainly rendered the section.
  whenIdle(win, () => {
    const target = win.document.querySelector?.(selector);
    const Observer = (win as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    if (!target || typeof Observer !== 'function') {
      run();
      return;
    }
    const observer = new Observer(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        run();
      },
      { rootMargin: WARM_AHEAD }
    );
    observer.observe(target);
  });
}
