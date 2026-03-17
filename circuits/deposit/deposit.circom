pragma circom 2.0.0;

include "../lib/poseidon.circom";

// Deposit circuit — proves that commitment = Poseidon(nullifier, secret, denomination).
//
// Public inputs (2):
//   commitment  — the value inserted into the on-chain Merkle tree
//   denomination — the pool's fixed deposit amount (public so the Anchor program can
//                  verify it matches pool.denomination before inserting the commitment)
//
// Private inputs (2):
//   nullifier   — 254-bit random value (half of the secret note)
//   secret      — 254-bit random value (other half of the secret note)
//
// Bug fix 12 — denomination is PUBLIC here so the commitment cannot be fabricated
// for a different pool denomination. The Anchor program verifies denomination ==
// pool.denomination before inserting. Both deposit and withdraw circuits must use
// the identical Poseidon(nullifier, secret, denomination) formula.
template Deposit() {
    // ── PUBLIC inputs ──────────────────────────────────────────────────────
    signal input commitment;    // Poseidon(nullifier, secret, denomination)
    signal input denomination;  // Pool's fixed amount — public, not user-chosen (BF-12)

    // ── PRIVATE inputs ────────────────────────────────────────────────────
    signal input nullifier;     // 254-bit random
    signal input secret;        // 254-bit random

    // ── Constraint ────────────────────────────────────────────────────────
    // commitment must equal Poseidon(nullifier, secret, denomination).
    component hasher = PoseidonHash(3);
    hasher.inputs[0] <== nullifier;
    hasher.inputs[1] <== secret;
    hasher.inputs[2] <== denomination;

    commitment === hasher.out;
}

component main {public [commitment, denomination]} = Deposit();
