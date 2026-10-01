// app/security/wrong_network_e2e.mjs
//
// G12, in the real page. A first-time visitor whose wallet has no devnet SOL connects and picks a pool;
// the app then shows the wrong-network modal, which blocks the deposit until they switch. This drives
// exactly that in the built app: a Wallet Standard wallet registered in the page (named Phantom, so the
// app's Phantom adapter picks it up through the real wallet libraries), connected through the real
// wallet picker, with every RPC call answered locally as devnet and the wallet's balance at zero.
//
// It then requires the modal to cover the whole viewport, its heading to be visible at the top, and
// its button to be reachable by scrolling, on a desktop screen and on a landscape phone. The modal used
// to be confined to the deposit card (its entry animation leaves a transform, which captures fixed
// descendants), so it sat inside the page, mostly off screen.
//
// Usage: node security/wrong_network_e2e.mjs
import { build } from 'vite';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = mkdtempSync(path.join(APP, '.tmp-wn-'));
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

// Registers a Wallet Standard wallet named "Phantom" before the app loads. It only connects; this
// check never signs anything.
const WALLET = `(() => {
  const address = '4PLXgVX9MumeLLjcyvYFNoKq1dECdEneiFA8StLCnf1c';
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const c of address) n = n * 58n + BigInt(A.indexOf(c));
  const publicKey = new Uint8Array(32); for (let i = 31; i >= 0; i--) { publicKey[i] = Number(n & 255n); n >>= 8n; }
  const chains = ['solana:mainnet', 'solana:devnet', 'solana:testnet'];
  const account = { address, publicKey, chains, features: ['solana:signTransaction', 'solana:signAndSendTransaction'] };
  const wallet = {
    version: '1.0.0', name: 'Phantom', chains,
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
    accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { wallet.accounts = [account]; return { accounts: wallet.accounts }; } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { wallet.accounts = []; } },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async () => { throw new Error('not in this test'); } },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signAndSendTransaction: async () => { throw new Error('not in this test'); } },
    },
  };
  const register = (api) => api.register(wallet);
  window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register })); } catch {}
  localStorage.setItem('sornadocash_onboarded', '1');
})();`;

// A pool account the app accepts: right size and discriminator, denomination 0.1 SOL.
const pool = Buffer.alloc(8976);
Buffer.from('f19a6d0411b16dbc', 'hex').copy(pool, 0);
pool.writeBigUInt64LE(100_000_000n, 8 + 64);
pool.writeBigUInt64LE(6n, 8 + 80);
const rpcResult = (method) => {
  const ctx = { context: { slot: 1 } };
  switch (method) {
    case 'getGenesisHash': return DEVNET_GENESIS;
    case 'getBalance': return { ...ctx, value: 0 };
    case 'getAccountInfo': return { ...ctx, value: { data: [pool.toString('base64'), 'base64'], executable: false, lamports: 1e9, owner: 'DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59', rentEpoch: 0, space: pool.length } };
    case 'getLatestBlockhash': return { ...ctx, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 } };
    case 'getMinimumBalanceForRentExemption': return 890880;
    case 'getSlot': return 1;
    case 'getVersion': return { 'solana-core': '2.0.0' };
    default: return null;
  }
};

const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VITE_')));
for (const k of Object.keys(saved)) delete process.env[k];
process.env.VITE_SOLANA_NETWORK = 'devnet';
process.env.VITE_RPC_ENDPOINT = 'http://127.0.0.1:1/rpc/devnet'; // every RPC call is answered by page.route below
let failed = 0, browser, server;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
try {
  await build({ root: APP, configFile: path.join(APP, 'vite.config.ts'), logLevel: 'silent', mode: 'production',
    build: { outDir: OUT, emptyOutDir: true } });
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.html': 'text/html' };
  server = createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(OUT, url);
    if (url === '/' || !existsSync(file) || statSync(file).isDirectory()) file = path.join(OUT, 'index.html');
    res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch();

  for (const [label, width, height] of [['desktop', 1280, 800], ['landscape phone', 740, 360]]) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    await ctx.addInitScript(WALLET);
    await ctx.route('http://127.0.0.1:1/**', async (route) => {
      const body = route.request().postDataJSON();
      const reply = (one) => ({ jsonrpc: '2.0', id: one.id, result: rpcResult(one.method) });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)) });
    });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    // With the landing page the app lives in #try; the app on its own has no such section.
    const app = (await page.locator('#try').count()) ? page.locator('#try') : page.locator('body');
    await page.evaluate(() => document.getElementById('try')?.scrollIntoView());
    await app.getByRole('button', { name: /select wallet/i }).first().click();
    await page.locator('.wallet-adapter-modal').getByRole('button', { name: /^Phantom/ }).first().click();
    await app.getByRole('button', { name: /^\s*0\.1\s*SOL/ }).first().click({ timeout: 20_000 });
    const modal = page.getByTestId('wrong-network-modal');
    await modal.waitFor({ timeout: 20_000 });
    await page.waitForTimeout(400);
    const r = await page.evaluate(async () => {
      const m = document.querySelector('[data-testid=wrong-network-modal]');
      const b = m.getBoundingClientRect();
      const inView = (el) => { const x = el.getBoundingClientRect(); return x.top >= -0.5 && x.bottom <= innerHeight + 0.5; };
      m.scrollTop = 0; await new Promise((r) => requestAnimationFrame(r));
      const title = inView(document.getElementById('wrong-network-title'));
      m.scrollTop = m.scrollHeight; await new Promise((r) => requestAnimationFrame(r));
      const buttons = m.querySelectorAll('button');
      return { rect: [b.left, b.top, b.width, b.height].map(Math.round), vw: innerWidth, vh: innerHeight,
        title, button: inView(buttons[buttons.length - 1]), inBody: m.parentElement === document.body };
    });
    const covers = r.rect.join(',') === `0,0,${r.vw},${r.vh}`;
    check(covers, `${label} ${width}x${height}: the modal covers the viewport (got ${r.rect.join(',')})`);
    check(r.title && r.button, `${label}: its heading is visible at the top and its button is reachable by scrolling`);
    check(r.inBody, `${label}: it is rendered into document.body`);
    await ctx.close();
  }
} catch (e) {
  check(false, `unexpected error: ${e.message.split('\n')[0]}`);
} finally {
  await browser?.close();
  server?.close();
  for (const k of Object.keys(process.env)) if (k.startsWith('VITE_')) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(OUT, { recursive: true, force: true });
}
console.log(failed ? `  wrong-network modal check FAILED (${failed})` : '  wrong-network modal check passed');
process.exit(failed ? 1 : 0);
