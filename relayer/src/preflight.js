// relayer/src/preflight.js
// M-4 — validate a submission against on-chain state BEFORE paying for a
// transaction.
//
// The relayer previously verified only the Groth16 proof, then submitted. A proof
// can be perfectly valid yet doomed: the withdrawal commitment may not match the
// (relayer, feeMax, recipient) triple this relayer would submit, or the root may
// have rotated out of the pool's 256-entry history. Each such submission cost the
// relayer a transaction fee, so any client could drain a relayer's balance within
// the rate limit — and the on-chain failure is far less legible to the user than a
// specific error here.

import { buildPoseidon } from "circomlibjs";

const ROOT_HISTORY_SIZE = 256;
const POOL_ROOT_HISTORY_OFFSET = 8 + 136;

let _poseidon = null;
let _F = null;

async function poseidon(...inputs) {
  if (!_poseidon) {
    _poseidon = await buildPoseidon();
    _F = _poseidon.F;
  }
  return BigInt(_F.toObject(_poseidon(inputs.map((x) => _F.e(x)))));
}

/**
 * Map a pubkey to a field element. MUST match pubkey_to_field in
 * programs/solnadocash/src/withdraw.rs and pubkeyToField in sdk/src/proof.ts:
 * split into two 128-bit halves and hash them (H-2).
 */
export async function pubkeyToField(pubkey) {
  const b = pubkey.toBytes();
  let hi = 0n;
  let lo = 0n;
  for (let i = 0; i < 16; i++) hi = (hi << 8n) | BigInt(b[i]);
  for (let i = 16; i < 32; i++) lo = (lo << 8n) | BigInt(b[i]);
  return poseidon(hi, lo);
}

/** Extract the 256-entry root ring from raw Pool account data. */
export function readRootHistory(poolData) {
  const roots = [];
  for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
    const start = POOL_ROOT_HISTORY_OFFSET + i * 32;
    let v = 0n;
    for (let j = 0; j < 32; j++) v = (v << 8n) | BigInt(poolData[start + j]);
    roots.push(v);
  }
  return roots;
}

/**
 * Check that a submission can actually succeed on-chain.
 *
 * @returns {Promise<{ok: true} | {ok: false, error: string, message: string}>}
 */
export async function preflight({
  poolData,
  publicSignals, // [nullifierHash, root, withdrawalCommitment] as decimal strings
  relayerPubkey,
  recipientPubkey,
  relayerFeeMax,
}) {
  const [, rootStr, wcStr] = publicSignals;

  // 1. The root must be in the pool's on-chain history, or the program rejects
  //    the withdrawal with RootNotFound.
  const root = BigInt(rootStr);
  const roots = readRootHistory(poolData);
  if (root === 0n || !roots.includes(root)) {
    return {
      ok: false,
      error: "StaleRoot",
      message:
        "The Merkle root in this proof is not among the pool's recent roots. " +
        "Rebuild the tree from current state and generate a fresh proof.",
    };
  }

  // 2. The withdrawal commitment must equal Poseidon(relayer, feeMax, recipient)
  //    for THIS relayer, this fee ceiling and this recipient — otherwise the
  //    program rejects it with InvalidWithdrawalCommitment.
  const expected = await poseidon(
    await pubkeyToField(relayerPubkey),
    BigInt(relayerFeeMax),
    await pubkeyToField(recipientPubkey)
  );
  if (expected !== BigInt(wcStr)) {
    return {
      ok: false,
      error: "InvalidWithdrawalCommitment",
      message:
        "The withdrawal commitment does not match this relayer, fee ceiling and " +
        "recipient. Request a fee quote from this relayer and prove against it.",
    };
  }

  return { ok: true };
}
