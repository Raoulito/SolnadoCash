// app/security/notevault_tabs.mjs
//
// L-8. Two tabs of the app share one localStorage. The note vault kept every note in one JSON array
// and each write was read-modify-write of the whole array, so two tabs staging notes at about the
// same moment each wrote back a copy without the other's note. Reproduced before the fix: with one
// note staged in each of two tabs at the same instant, a note was lost in 73 of 100 trials.
//
// jsdom has one realm and no second tab, so this runs the real noteVault.ts, bundled with esbuild,
// in two pages of one real Chromium context. It exits non-zero if any note is lost.
//
// Usage: node security/notevault_tabs.mjs [trials]
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRIALS = Number(process.argv[2] ?? 100);

const bundle = await build({
  stdin: {
    contents: `import { pendingNotes, stageNote } from './src/utils/noteVault';
      window.stage = (tag) => stageNote({ note: 'sndo_' + tag + '_' + 'a'.repeat(128), poolAddress: 'P', denominationSol: 0.1 });
      window.count = () => pendingNotes().length;`,
    resolveDir: path.join(HERE, '..'),
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  write: false,
  logLevel: 'error',
});
const js = bundle.outputFiles[0].text;
const server = createServer((req, res) => {
  if (req.url === '/vault.js') { res.setHeader('content-type', 'text/javascript'); res.end(js); return; }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><script src="/vault.js"></script>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
let lost = 0;
try {
  const ctx = await browser.newContext();
  const [a, b] = [await ctx.newPage(), await ctx.newPage()];
  for (const p of [a, b]) await p.goto(url);
  for (let t = 0; t < TRIALS; t++) {
    await a.evaluate(() => localStorage.clear());
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all([a.evaluate((t) => window.stage('A' + t), t), b.evaluate((t) => window.stage('B' + t), t)]);
    await new Promise((r) => setTimeout(r, 50));
    const inA = await a.evaluate(() => window.count());
    const inB = await b.evaluate(() => window.count());
    if (inA < 2 || inB < 2) lost++;
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`notevault two-tab test: a note was lost in ${lost} of ${TRIALS} trials`);
process.exit(lost === 0 ? 0 : 1);
