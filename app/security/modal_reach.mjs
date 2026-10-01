// app/security/modal_reach.mjs
//
// G12. The onboarding popup and the wrong-network modal cover the page and block it until they are
// dealt with, so every part of them must be reachable on a small screen. Both were laid out as a
// full-screen flex container that centres its card. When the card is taller than the screen, a centred
// flex item overflows on BOTH sides, and the part above the top of the container can never be scrolled
// to: on a phone the popup's heading was cut off, and the wrong-network modal (which had no scrolling at
// all) lost its button below the bottom edge.
//
// This renders the real components in Chromium at phone and short-laptop sizes, scrolls the overlay to
// its start and to its end, and requires the card's top edge and its last button to be fully inside the
// viewport at those positions. Exits non-zero if any modal fails at any size.
//
// Usage: node security/modal_reach.mjs
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The app's Tailwind CSS, built from its own config, so the layout is exactly what ships.
const css = execFileSync(
  process.execPath,
  [path.join(APP, 'node_modules/tailwindcss/lib/cli.js'), '-c', path.join(APP, 'tailwind.config.js'),
   '-i', path.join(APP, 'src/index.css'), '--content', path.join(APP, 'src/**/*.{ts,tsx}')],
  { cwd: APP, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
);

const js = (await build({
  stdin: {
    contents: `
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import Onboarding from './src/pages/Onboarding';
      import WrongNetworkModal from './src/components/WrongNetworkModal';
      const which = new URLSearchParams(location.search).get('m');
      const el = which === 'onboarding'
        ? createElement(Onboarding, { onDismiss: () => {} })
        : createElement(WrongNetworkModal, {
            message: 'Your wallet holds no devnet SOL at this address. It is probably set to mainnet. '.repeat(3),
            onRetry: () => {},
          });
      createRoot(document.getElementById('root')).render(el);`,
    resolveDir: APP,
    loader: 'tsx',
  },
  bundle: true,
  format: 'iife',
  write: false,
  logLevel: 'error',
  jsx: 'automatic',
  define: { 'import.meta.env': JSON.stringify({ VITE_SOLANA_NETWORK: 'devnet' }), 'process.env.NODE_ENV': '"production"' },
})).outputFiles[0].text;

const server = createServer((req, res) => {
  if (req.url.startsWith('/app.js')) { res.setHeader('content-type', 'text/javascript'); res.end(js); return; }
  if (req.url.startsWith('/app.css')) { res.setHeader('content-type', 'text/css'); res.end(css); return; }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const SIZES = [
  ['iPhone SE', 375, 667],
  ['small Android', 360, 640],
  ['short laptop', 1280, 600],
  ['landscape phone', 740, 360],
];
const MODALS = [
  ['onboarding', '[role=dialog]', '#onboarding-title'],
  ['wrong-network', '[data-testid=wrong-network-modal]', '#wrong-network-title'],
];

const browser = await chromium.launch();
let failed = 0;
try {
  for (const [name, overlaySel, titleSel] of MODALS) {
    for (const [label, width, height] of SIZES) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(`${base}?m=${name}`);
      await page.waitForSelector(titleSel);
      const r = await page.evaluate(async ([overlaySel, titleSel]) => {
        const overlay = document.querySelector(overlaySel);
        const title = document.querySelector(titleSel);
        const card = title.closest('div[class*="max-w"]');
        const buttons = card.querySelectorAll('button');
        const last = buttons[buttons.length - 1];
        const scroller = [overlay, ...overlay.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 1 &&
          /(auto|scroll)/.test(getComputedStyle(el).overflowY)) ?? overlay;
        const vh = innerHeight;
        const inView = (el) => { const b = el.getBoundingClientRect(); return b.top >= -0.5 && b.bottom <= vh + 0.5; };
        scroller.scrollTop = 0;
        await new Promise((r) => requestAnimationFrame(r));
        const cardTop = card.getBoundingClientRect().top;
        const topOk = cardTop >= -0.5 && inView(title);
        scroller.scrollTop = scroller.scrollHeight;
        await new Promise((r) => requestAnimationFrame(r));
        const bottomOk = inView(last);
        return { topOk, bottomOk, cardTop: Math.round(cardTop), cardH: Math.round(card.getBoundingClientRect().height), vh };
      }, [overlaySel, titleSel]);
      const ok = r.topOk && r.bottomOk;
      if (!ok) failed++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${label.padEnd(16)} ${width}x${height}  card ${r.cardH}px` +
        `${r.topOk ? '' : `, top out of reach (card top ${r.cardTop}px)`}${r.bottomOk ? '' : ', last button out of reach'}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `  modal reach check FAILED (${failed})` : '  modal reach check passed');
process.exit(failed ? 1 : 0);
