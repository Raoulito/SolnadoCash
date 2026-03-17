pragma circom 2.0.0;

include "../lib/poseidon.circom";
include "../merkle/merkle_proof.circom";

// Withdraw circuit — proves ownership of a deposited note and authorises a withdrawal.
//
// ── PUBLIC inputs — EXACTLY 3, in this order ──────────────────────────────────────
// The on-chain groth16_verify syscall receives public inputs in this exact order.
// Any reordering silently causes every proof to fail (see PROJET_enhanced.md Section 12.3).
//
//   [0] nullifierHash        — Poseidon(nullifier): unique anti-double-spend identifier
//   [1] root                 — Merkle root at the time the proof was generated
//   [2] withdrawalCommitment — Poseidon(relayerAddress, relayerFeeMax, recipient)
//
// ── PRIVATE inputs ────────────────────────────────────────────────────────────────
//   nullifier       — 254-bit random, half of the secret note
//   secret          — 254-bit random, other half of the secret note
//   denomination    — pool.denomination (PRIVATE — Bug fix 12: avoids anonymity leak)
//   pathElements[]  — Merkle sibling nodes from leaf to root
//   pathIndices[]   — 0 = current is left child, 1 = current is right child
//   recipient       — user's destination wallet (PRIVATE — Bug fix 20)
//   relayerAddress  — relayer's pubkey as a field element (PRIVATE — bound in commitment)
//   relayerFeeMax   — fee ceiling in lamports (PRIVATE — bound in commitment)
//
// ── Security notes ────────────────────────────────────────────────────────────────
//
// Bug fix 20 — Recipient malleability:
//   `recipient` is PRIVATE, bound inside withdrawalCommitment.
//   The previous design used a squaring trick (recipientSquare <== recipient * recipient)
//   which was a no-op constraint — it produced a value that went nowhere.
//   A malicious relayer could swap recipient in the mempool while the proof validated.
//   The fix: withdrawalCommitment = Poseidon(relayerAddress, relayerFeeMax, recipient).
//   Swapping any of the three invalidates the hash and the proof.
//
// Bug fix 12 — Anonymity leak:
//   denomination is PRIVATE here (unlike deposit where it is public).
//   If denomination were public on withdrawal, on-chain observers could correlate
//   deposits and withdrawals from pools of the same denomination.
//   Private denomination means the Anchor program uses pool.denomination as private
//   input to the prover — never exposed in the transaction data.
template Withdraw(levels) {
    // ── PUBLIC inputs — exactly 3, in this order ──────────────────────────
    signal input nullifierHash;         // Poseidon(nullifier)
    signal input root;                  // Merkle tree root
    signal input withdrawalCommitment;  // Poseidon(relayerAddress, relayerFeeMax, recipient)

    // ── PRIVATE inputs ────────────────────────────────────────────────────
    signal input nullifier;             // 254-bit random
    signal input secret;                // 254-bit random
    signal input denomination;          // pool.denomination — PRIVATE (BF-12)
    signal input pathElements[levels];  // Merkle path siblings
    signal input pathIndices[levels];   // 0 = left, 1 = right
    signal input recipient;             // destination wallet — PRIVATE (BF-20)
    signal input relayerAddress;        // relayer pubkey as field element — PRIVATE
    signal input relayerFeeMax;         // fee ceiling in lamports — PRIVATE

    // ── Constraint C1: nullifierHash === Poseidon(nullifier) ──────────────
    // Proves the prover knows the nullifier without revealing it.
    // The nullifierHash is stored on-chain after withdrawal to prevent double-spend.
    component nullifierHasher = PoseidonHash(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHash === nullifierHasher.out;

    // ── Constraint C2: commitment === Poseidon(nullifier, secret, denomination) ──
    // Reconstructs the commitment that was inserted into the Merkle tree at deposit time.
    // Must use identical formula to deposit.circom (same input order, same hash).
    component commitmentHasher = PoseidonHash(3);
    commitmentHasher.inputs[0] <== nullifier;
    commitmentHasher.inputs[1] <== secret;
    commitmentHasher.inputs[2] <== denomination;

    // ── Constraint C3: commitment is in the Merkle tree ───────────────────
    // Verifies the commitment exists in the on-chain tree rooted at `root`.
    component merkle = MerkleProof(levels);
    merkle.leaf <== commitmentHasher.out;
    merkle.root <== root;
    for (var i = 0; i < levels; i++) {
        merkle.pathElements[i] <== pathElements[i];
        merkle.pathIndices[i]  <== pathIndices[i];
    }

    // ── Constraint C4: withdrawalCommitment === Poseidon(relayerAddress, relayerFeeMax, recipient) ──
    // Atomically binds the relayer, fee ceiling, and destination.
    // This is the core Bug fix 20 constraint — swapping any value changes the hash.
    // The Anchor program recomputes this hash from the transaction arguments and
    // verifies it equals the withdrawalCommitment public input.
    component wcHasher = PoseidonHash(3);
    wcHasher.inputs[0] <== relayerAddress;
    wcHasher.inputs[1] <== relayerFeeMax;
    wcHasher.inputs[2] <== recipient;
    withdrawalCommitment === wcHasher.out;
}

// Public input declaration — must match the signal input order above.
// The groth16_verify syscall receives: [nullifierHash, root, withdrawalCommitment]
component main {public [nullifierHash, root, withdrawalCommitment]} = Withdraw(20);
