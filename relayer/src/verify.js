// relayer/src/verify.js
// T26 — Off-chain proof validation using snarkjs
//
// The relayer verifies the Groth16 proof BEFORE submitting any on-chain
// transaction. This prevents wasting SOL on invalid proof submissions.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VK_PATH = join(__dirname, "../../circuits/build/withdraw_vk.json");

let _vk = null;

/**
 * Load the verification key (cached after first load).
 * @returns {object} snarkjs-format verification key
 */
export function loadVerificationKey() {
  if (!_vk) {
    _vk = JSON.parse(readFileSync(VK_PATH, "utf8"));
  }
  return _vk;
}

/**
 * Verify a Groth16 proof off-chain using snarkjs.
 *
 * @param {object} proof - snarkjs-format proof { pi_a, pi_b, pi_c, protocol, curve }
 * @param {string[]} publicSignals - [nullifierHash, root, withdrawalCommitment] as decimal strings
 * @returns {Promise<boolean>} true if proof is valid
 */
export async function verifyProofOffChain(proof, publicSignals) {
  // Dynamic import snarkjs (ESM)
  const snarkjs = await import("snarkjs");
  const vk = loadVerificationKey();
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}
