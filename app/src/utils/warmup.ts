// app/src/utils/warmup.ts
//
// The SDK loads circomlibjs (Poseidon) on first use rather than at startup, so the landing page no
// longer waits for it. Deposits need Poseidon the moment the user confirms, though, and a cold load is
// about 1.4 MB of compressed JavaScript plus building the hasher. So once the page has rendered and
// the browser is idle, it is fetched and built in the background, and a deposit almost always finds it
// ready. A failure here is harmless: initPoseidon() is called again, and retried, where it is needed.
//
// snarkjs is not warmed. It is only used to prove a withdrawal, which already downloads 7.8 MB of
// circuit files, so prefetching it for every visitor would cost more than it saves.

import { initPoseidon } from '@solnadocash/sdk';

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
};

export function warmPoseidonWhenIdle(win: IdleWindow = window, init: () => Promise<void> = initPoseidon): void {
  const run = () => {
    init().catch(() => {});
  };
  const start = () => {
    if (typeof win.requestIdleCallback === 'function') win.requestIdleCallback(run, { timeout: 5000 });
    else win.setTimeout(run, 1500);
  };
  if (win.document.readyState === 'complete') start();
  else win.addEventListener('load', start, { once: true });
}
