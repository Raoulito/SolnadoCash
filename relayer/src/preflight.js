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

import { PublicKey } from "@solana/web3.js";
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
 * Convert a decimal field-element string into the 32-byte big-endian form used as a PDA seed.
 * Must match `bigIntToBytes32` in tx.js and `args.nullifier_hash` on-chain.
 */
function fieldToBytes32(decimal) {
  return Buffer.from(BigInt(decimal).toString(16).padStart(64, "0"), "hex");
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
  // Required for the spent-note check (SEC-05). api.js always supplies all three.
  connection,
  programId,
  poolPubkey,
}) {
  const [nullifierStr, rootStr, wcStr] = publicSignals;

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

  // 3. SEC-05: the note must not already be spent on-chain.
  //
  // A spent proof stays valid arithmetic forever, and its root remains in the 256-entry ring for as
  // long as it takes 256 further deposits to rotate out. Anyone can lift a completed withdrawal's
  // payload off the chain and resubmit it. Checks 1 and 2 both pass for such a replay — the root is
  // still live and the commitment still names this relayer — so without this step the request went
  // on to the Groth16 pairing check, which is the single most expensive thing the relayer does and
  // runs on the same thread as everything else. Enough concurrent replays starve honest requests,
  // and each one that clears verification also costs a doomed transaction's fees.
  //
  // The condition mirrors the program exactly: on-chain the guard is `data_is_empty()`, and a PDA
  // holding lamports but no data is deliberately NOT treated as spent, because pre-funding it is a
  // griefing vector the withdrawal path already absorbs by allocating and assigning explicitly
  // (H-1). Rejecting on mere existence here would hand that griefing vector straight back, one layer
  // up, where the program's defence cannot reach it.
  //
  // Ordering: this is the last check in preflight because it is the only one that needs the network.
  // The two above are local, so obviously-malformed traffic is rejected without an RPC round trip.
  if (connection && programId && poolPubkey) {
    let nullifierAccount;
    try {
      const [nullifierPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier"), poolPubkey.toBytes(), fieldToBytes32(nullifierStr)],
        programId
      );
      nullifierAccount = await connection.getAccountInfo(nullifierPda);
    } catch {
      // Deliberately fail OPEN. This check is a cost and liveness optimisation, not a security
      // boundary: the program enforces double-spending regardless, so a proof that gets past a
      // failed lookup still cannot spend a note twice. Failing closed would convert an RPC hiccup
      // into a total withdrawal outage — a self-inflicted denial of service strictly worse than the
      // one being defended against.
      return { ok: true };
    }

    if (nullifierAccount !== null && nullifierAccount.data.length > 0) {
      return {
        ok: false,
        error: "NullifierSpent",
        message:
          "This note has already been withdrawn. Its nullifier is recorded on-chain, " +
          "so no further withdrawal against it can succeed.",
      };
    }
  }

  return { ok: true };
}
