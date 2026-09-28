// @vitest-environment node
//
// app/src/circuitArtifacts.test.ts
//
// The browser proves with public/circuits/withdraw.wasm and withdraw_final.zkey. The program
// verifies with vk.rs. Nothing tied the two together, and they drifted: regenerating the keys for
// the one-multiplication Merkle template (e5dfb2f) updated vk.rs and circuits/build/withdraw_vk.json
// but left the browser on the old proving key. Every proof the app produced was then rejected, while
// every test stayed green, because the relayer, the fixtures and the LiteSVM suite all prove with
// circuits/build, never with the files the app actually ships.
//
// So this pins the chain end to end, against the exact files a user downloads:
//
//   shipped zkey --(VK export)--> withdraw_vk.json --(check_vk_consistency)--> vk.rs --> program
//   shipped wasm + zkey --(real proof)--> verifies under withdraw_vk.json
//
// The VK comparison alone would not catch a wasm from a different circuit than its zkey, because the
// wasm only computes a witness. The real proof does: a witness for another constraint system does not
// satisfy this one, and snarkjs refuses to produce a valid proof from it.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import * as snarkjs from 'snarkjs';
import {
  generateNote,
  generateWithdrawProof,
  initPoseidon,
  MerkleTree,
  poseidonHash,
} from '@solnadocash/sdk';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..');
const SHIPPED_WASM = path.join(APP, 'public/circuits/withdraw.wasm');
const SHIPPED_ZKEY = path.join(APP, 'public/circuits/withdraw_final.zkey');
const ONCHAIN_VK_JSON = path.join(REPO, 'circuits/build/withdraw_vk.json');

const onchainVk = JSON.parse(readFileSync(ONCHAIN_VK_JSON, 'utf8'));

afterAll(async () => {
  // snarkjs keeps a worker pool alive on this global; without terminating it the run never exits.
  const curve = (globalThis as { curve_bn128?: { terminate: () => Promise<void> } }).curve_bn128;
  if (curve) await curve.terminate();
});

describe('shipped proving artifacts match the deployed verifier', () => {
  it('withdraw_vk.json is the key compiled into vk.rs', () => {
    // Throws, failing the test, on any drift between the JSON and the Rust constant.
    execFileSync('node', [path.join(REPO, 'scripts/check_vk_consistency.js')], {
      stdio: 'pipe',
    });
  });

  it('the shipped zkey carries exactly the on-chain verification key', async () => {
    const shippedVk = await snarkjs.zKey.exportVerificationKey(SHIPPED_ZKEY);
    // Compared field by field so a failure names what moved. delta and IC are what change when a
    // key is regenerated for a new circuit; alpha/beta/gamma can survive a regeneration unchanged.
    for (const field of ['protocol', 'curve', 'nPublic', 'vk_alpha_1', 'vk_beta_2', 'vk_gamma_2', 'vk_delta_2', 'IC']) {
      expect(shippedVk[field], `vk field ${field}`).toEqual(onchainVk[field]);
    }
  });

  it(
    'a proof built with the shipped wasm and zkey verifies under the on-chain key',
    async () => {
      await initPoseidon();
      const denomination = 100_000_000n;
      const pool = Keypair.generate().publicKey;
      const note = generateNote(denomination, pool);

      // A tree with neighbours on both sides, so the path exercises both child directions.
      const tree = new MerkleTree(20);
      tree.insert(poseidonHash(1n, 2n, denomination));
      tree.insert(poseidonHash(note.nullifier, note.secret, note.denomination));
      tree.insert(poseidonHash(3n, 4n, denomination));

      const quote = {
        relayerAddress: Keypair.generate().publicKey,
        relayerFeeMax: 2_000_000n,
        validUntil: Date.now() + 30_000,
        estimatedUserReceives: denomination - denomination / 500n - 2_000_000n,
      };

      const { proof, publicSignals } = await generateWithdrawProof(
        note,
        quote,
        Keypair.generate().publicKey,
        tree,
        { wasmPath: SHIPPED_WASM, zkeyPath: SHIPPED_ZKEY }
      );

      const ok = await snarkjs.groth16.verify(
        onchainVk,
        publicSignals.map((s) => s.toString()),
        proof
      );
      expect(ok).toBe(true);
    },
    120_000
  );
});
