#!/usr/bin/env node
// app/security/prove_timing.mjs
//
// G13. How long a withdrawal proof takes in a real browser: the app's production build and CSP, the
// real circuit files, Chromium.
//
// It builds once, measures this machine, then emulates CPUs 2, 4 and 6 times slower. snarkjs proves in
// Web Workers (one per CPU thread) with some work on the page's main thread, and no single throttle
// slows both: Chrome's CPU throttling (CDP) acts on the main thread only (measured: at 4x it slowed
// Poseidon 3.9x but proofs only 2x), and a CPU quota slows threads only when they compete for it, so
// not a lone main thread. Each setting therefore applies both with the same factor k: CDP throttling k
// for the main thread, and a systemd CPU quota of 1/k of the machine over the whole run (browser and
// workers). That approximates every core being k times slower. It is an emulation, not a phone.
//
// Per setting it reports: Poseidon (fetched and built once per visit, before a deposit), the first
// proof (also loads snarkjs, the circuit files from a local server and the workers) and the median of
// the next three. Downloading the circuit files over a real network and rebuilding the deposit tree
// are not included.
//
// Usage: node security/prove_timing.mjs        (the slower settings need `systemd-run --user`)
import { build } from 'vite';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const APP = path.resolve(path.dirname(SELF), '..');
const args = process.argv.slice(2);

async function measure(dist, rate) {
  const csp = readFileSync(path.join(dist, 'index.html'), 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const types = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(dist, url);
    if (url === '/' || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('content-security-policy', csp);
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let workers = 0;
    page.on('worker', () => workers++);
    if (rate > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 300_000 });
    const poseidon = await page.evaluate(() => window.poseidon());
    const proofs = [];
    for (let i = 0; i < 4; i++) proofs.push(await page.evaluate(() => window.prove()));
    const warm = proofs.slice(1).sort((a, b) => a - b)[1];
    return { poseidon, first: proofs[0], warm, workers };
  } finally {
    await browser.close();
    server.close();
  }
}

if (args[0] === '--measure') {
  // Child: measure under the CPU limits this process runs with; print one JSON line.
  console.log(JSON.stringify(await measure(args[1], Number(args[2] ?? 1))));
  process.exit(0);
}

// Parent: build the probe page once, with the app's own Vite config.
const work = mkdtempSync(path.join(APP, '.tmp-timing-'));
const dist = path.join(work, 'dist');
mkdirSync(path.join(work, 'src'));
writeFileSync(path.join(work, 'index.html'), '<!doctype html><html><head><title>timing</title></head><body><script type="module" src="/src/probe.ts"></script></body></html>');
writeFileSync(path.join(work, 'src/probe.ts'), `
import { initPoseidon, poseidonHash, generateNote, MerkleTree, generateWithdrawProof } from '@solnadocash/sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
const w = window as any;
w.poseidon = async () => { const t = performance.now(); await initPoseidon(); return Math.round(performance.now() - t); };
w.prove = async () => {
  const note = generateNote(100_000_000n, new PublicKey('FWQkYzmNz74VSffemu9tphYX1TSSfTBo9JYgKRWRWcoY'));
  const tree = new MerkleTree();
  tree.insert(poseidonHash(note.nullifier, note.secret, note.denomination));
  const quote = { relayerAddress: Keypair.generate().publicKey, relayerFeeMax: 1_592_460n, validUntil: Date.now() + 30_000, estimatedUserReceives: 98_207_540n };
  const t = performance.now();
  await generateWithdrawProof(note, quote, Keypair.generate().publicKey, tree, { wasmPath: '/circuits/withdraw.wasm', zkeyPath: '/circuits/withdraw_final.zkey' });
  return Math.round(performance.now() - t);
};
w.ready = true;
`);
const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VITE_')));
for (const k of Object.keys(saved)) delete process.env[k];
const cores = os.availableParallelism();
const cpu = (readFileSync('/proc/cpuinfo', 'utf8').match(/model name\s*:\s*(.+)/) ?? [])[1] ?? 'unknown CPU';
const s = (ms) => (ms / 1000).toFixed(1).padStart(5) + ' s';
try {
  await build({ configFile: path.join(APP, 'vite.config.ts'), root: work, logLevel: 'silent', mode: 'production', build: { outDir: dist, emptyOutDir: true } });
  cpSync(path.join(APP, 'public/circuits'), path.join(dist, 'circuits'), { recursive: true });
  console.log(`  Withdrawal proof in Chromium, production build and CSP. ${cpu}, ${cores} threads.`);
  console.log('  CPU                       Poseidon   first proof   later proofs   workers');
  for (const k of [1, 2, 4, 6]) {
    const cmd = k === 1
      ? [process.execPath, [SELF, '--measure', dist, '1']]
      : ['systemd-run', ['--user', '--scope', '-q', '-p', `CPUQuota=${Math.round((100 * cores) / k)}%`, process.execPath, SELF, '--measure', dist, String(k)]];
    const r = spawnSync(cmd[0], cmd[1], { encoding: 'utf8', timeout: 1_800_000 });
    const label = k === 1 ? 'this machine' : `${k}x slower (emulated)`;
    let m;
    try {
      m = JSON.parse((r.stdout ?? '').trim().split('\n').pop());
    } catch {
      console.log(`  ${label.padEnd(25)} could not measure: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}`);
      continue;
    }
    console.log(`  ${label.padEnd(25)}${s(m.poseidon)}     ${s(m.first)}       ${s(m.warm)}       ${m.workers}`);
  }
  console.log('  Not included: downloading the circuit files (about 3.7 MB compressed) and rebuilding the tree.');
} finally {
  Object.assign(process.env, saved);
  rmSync(work, { recursive: true, force: true });
}
