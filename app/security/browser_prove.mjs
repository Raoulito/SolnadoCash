// app/security/browser_prove.mjs
//
// End-to-end check of the proving path in a real browser, the part no unit test reaches: the SDK loads
// circomlibjs and snarkjs on first use, so whether Vite splits, resolves and runs them correctly under
// the production CSP can only be seen in a browser.
//
// It builds a tiny page with the app's real Vite config (plugins, aliases, polyfills, CSP), serves it
// with that CSP and the real circuit files, and in Chromium: builds Poseidon, inserts a note's leaf in a
// Merkle tree, and generates a withdrawal proof. The proof is then verified off-chain with
// circuits/build/withdraw_vk.json, the verification key the deployed program was built from, and its
// public signals are checked against the inputs. Exits non-zero on any failure.
//
// Usage: node security/browser_prove.mjs
import { build } from 'vite';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VK = JSON.parse(readFileSync(path.join(APP, '../circuits/build/withdraw_vk.json'), 'utf8'));
// Inside app/, so the probe resolves @solnadocash/sdk and the other packages exactly as the app does.
const work = mkdtempSync(path.join(APP, '.tmp-prove-'));
const out = path.join(work, 'dist');

// The probe page. It imports from the SDK exactly as the app's pages do.
mkdirSync(path.join(work, 'src'));
writeFileSync(path.join(work, 'index.html'), '<!doctype html><html><head><title>prove</title></head><body><script type="module" src="/src/probe.ts"></script></body></html>');
writeFileSync(path.join(work, 'src/probe.ts'), `
import { initPoseidon, poseidonHash, generateNote, MerkleTree, generateWithdrawProof } from '@solnadocash/sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
(window as any).run = async () => {
  const t0 = performance.now();
  await initPoseidon();
  const tPoseidon = performance.now() - t0;
  const note = generateNote(100_000_000n, new PublicKey('FWQkYzmNz74VSffemu9tphYX1TSSfTBo9JYgKRWRWcoY'));
  const tree = new MerkleTree();
  tree.insert(poseidonHash(note.nullifier, note.secret, note.denomination));
  const quote = { relayerAddress: Keypair.generate().publicKey, relayerFeeMax: 1_592_460n, validUntil: Date.now() + 30_000, estimatedUserReceives: 98_207_540n };
  const t1 = performance.now();
  const { proof, publicSignals } = await generateWithdrawProof(note, quote, Keypair.generate().publicKey, tree,
    { wasmPath: '/circuits/withdraw.wasm', zkeyPath: '/circuits/withdraw_final.zkey' });
  return {
    tPoseidon: Math.round(tPoseidon), tProof: Math.round(performance.now() - t1), proof,
    publicSignals: publicSignals.map(String), root: tree.root.toString(), nullifierHash: poseidonHash(note.nullifier).toString(),
  };
};
(window as any).ready = true;
`);

let failed = false;
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };
const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VITE_')));
for (const k of Object.keys(saved)) delete process.env[k];
let browser, server;
try {
  // The app's own config, pointed at the probe page. configFile keeps every plugin, alias and the CSP.
  await build({ configFile: path.join(APP, 'vite.config.ts'), root: work, logLevel: 'silent', mode: 'production',
    build: { outDir: out, emptyOutDir: true } });
  cpSync(path.join(APP, 'public/circuits'), path.join(out, 'circuits'), { recursive: true });
  const csp = readFileSync(path.join(out, 'index.html'), 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  check(Boolean(csp), 'the build carries the production CSP');

  const types = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
  server = createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(out, url);
    if (url === '/' || !existsSync(file) || statSync(file).isDirectory()) file = path.join(out, 'index.html');
    res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('content-security-policy', csp);
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch();
  const page = await browser.newPage();
  const problems = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) problems.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => problems.push('page error: ' + e.message.slice(0, 160)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 60_000 });
  const r = await page.evaluate(() => window.run());

  console.log(`  Poseidon loaded and built in ${r.tPoseidon} ms; proof generated in ${r.tProof} ms (headless Chromium)`);
  check(await snarkjs.groth16.verify(VK, r.publicSignals, r.proof), 'the proof verifies with the deployed verification key');
  check(r.publicSignals[0] === r.nullifierHash, 'public signal 0 is the note\'s nullifier hash');
  check(r.publicSignals[1] === r.root, 'public signal 1 is the Merkle root of the tree the note is in');
  check(problems.length === 0, `no CSP violations or page errors${problems.length ? ': ' + problems.join(' | ') : ''}`);
} catch (e) {
  check(false, `unexpected error: ${e.message}`);
} finally {
  await browser?.close();
  server?.close();
  Object.assign(process.env, saved);
  rmSync(work, { recursive: true, force: true });
  await globalThis.curve_bn128?.terminate();
}
console.log(failed ? '  browser proving check FAILED' : '  browser proving check passed');
process.exit(failed ? 1 : 0);
