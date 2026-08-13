// relayer/src/verify.js
// T26 — Off-chain proof validation using snarkjs
//
// The relayer verifies the Groth16 proof BEFORE submitting any on-chain
// transaction. This prevents wasting SOL on invalid proof submissions.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VK_PATH =
  process.env.WITHDRAW_VK_PATH ||
  join(__dirname, "../../circuits/build/withdraw_vk.json");

let _vk = null;

/**
 * Load the verification key (cached after first load).
 *
 * circuits/build/ is gitignored, so this file used to be absent on a fresh clone
 * and the relayer died on its first submission with an opaque ENOENT (M-7).
 * withdraw_vk.json is now committed as an exception to that ignore rule, and the
 * path is overridable with WITHDRAW_VK_PATH.
 *
 * This key MUST correspond to programs/solnadocash/src/vk.rs — verify with
 * `node scripts/check_vk_consistency.js`. If they drift, the relayer accepts proofs
 * the chain rejects, or rejects proofs the chain would accept.
 *
 * @returns {object} snarkjs-format verification key
 */
export function loadVerificationKey() {
  if (!_vk) {
    try {
      _vk = JSON.parse(readFileSync(VK_PATH, "utf8"));
    } catch (err) {
      throw new Error(
        `Cannot load the withdraw verifying key from ${VK_PATH}: ${err.message}\n` +
          `Set WITHDRAW_VK_PATH, or restore circuits/build/withdraw_vk.json (it is ` +
          `committed to the repo), or regenerate it with scripts/trusted_setup.sh.`
      );
    }
    if (_vk.nPublic !== 3) {
      throw new Error(
        `Verifying key has ${_vk.nPublic} public inputs, expected 3 ` +
          `[nullifierHash, root, withdrawalCommitment] — wrong or stale key.`
      );
    }
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
