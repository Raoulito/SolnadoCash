// @vitest-environment node
//
// app/src/bundleSplit.test.ts
//
// The proving and hashing libraries are the bulk of the app's JavaScript: circomlibjs (Poseidon, with
// 1.7 MB of round constants), snarkjs and ffjavascript were 3.7 MB of the 4 MB the browser parsed
// before the page could do anything. The landing page, the deposit form and the wallet connection need
// none of them; Poseidon is needed when a deposit is built and snarkjs only when a withdrawal is
// proved. So the SDK loads them on first use, and they live in their own chunks.
//
// This builds the real app and reads the chunks the HTML loads at startup (the entry script and its
// modulepreloads). It fails if either library is back in them, which an innocent static import
// anywhere in the app would do.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'vite';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Fingerprints that survive minification. The first Poseidon round constant is data, not code, so no
// minifier can rename it; "Invalid witness length" is a snarkjs error string.
const require = createRequire(import.meta.url);
const constants = require(path.join(APP, 'node_modules/circomlibjs/src/poseidon_constants_opt.js'));
const POSEIDON_C0 = String((constants.default ?? constants).C[0][0]).slice(2, 26);
const SNARKJS = 'Invalid witness length';

describe('startup bundle', () => {
  it('does not contain the proving or hashing libraries', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'split-'));
    const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('VITE_')));
    for (const k of Object.keys(saved)) delete process.env[k];
    try {
      await build({ root: APP, logLevel: 'silent', mode: 'production', build: { outDir: out, emptyOutDir: true } });
      const html = readFileSync(path.join(out, 'index.html'), 'utf8');
      const startup = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
      expect(startup.length).toBeGreaterThan(0);
      const startupCode = startup.map((f) => readFileSync(path.join(out, f), 'utf8')).join('\n');
      const all = readdirSync(path.join(out, 'assets')).filter((f) => f.endsWith('.js'));
      const allCode = all.map((f) => readFileSync(path.join(out, 'assets', f), 'utf8')).join('\n');

      // Sanity: the fingerprints really are in the build, so their absence below means something.
      expect(allCode).toContain(POSEIDON_C0);
      expect(allCode).toContain(SNARKJS);

      expect(startupCode, 'circomlibjs (Poseidon) is loaded at startup').not.toContain(POSEIDON_C0);
      expect(startupCode, 'snarkjs is loaded at startup').not.toContain(SNARKJS);

      // Only circomlibjs's Poseidon is used. Its other primitives (EdDSA, MiMC, the sparse Merkle
      // tree...) used to ship in the Poseidon chunk, 480 KB compressed (vite.config.ts alias).
      for (const unused of ['buildEddsa', 'buildMimc7', 'SMTMemDb']) {
        expect(allCode, `unused circomlibjs code (${unused}) is in the bundle`).not.toContain(unused);
      }
    } finally {
      Object.assign(process.env, saved);
      rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);
});
