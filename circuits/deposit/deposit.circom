pragma circom 2.0.0;

include "../lib/poseidon.circom";

// Deposit circuit — proves that commitment = Poseidon(nullifier, secret, denomination).
//
// ⚠ NOT USED ON-CHAIN (M-9). The `deposit` instruction verifies no proof: it accepts
// any 32-byte commitment and inserts it into the Merkle tree, exactly like Tornado
// Cash. This circuit is kept only as an off-chain aid for testing that a commitment
// was formed correctly. It is NOT part of the trusted setup and no proving key is
// generated for it — see scripts/trusted_setup.sh.
//
// Consequently there is no on-chain binding between a commitment and the pool's
// denomination. That costs nothing: a withdrawal must present a Merkle proof for a
// leaf that exists in THIS pool's tree, and inserting a leaf costs exactly one
// denomination, so a commitment formed with the wrong denomination is simply
// unspendable by its creator.
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
// Bug fix 12 — denomination is a PUBLIC input here so that a caller of this circuit
// cannot claim a commitment belongs to a different denomination than the one it was
// built from.
//
// CORRECTION (M-9): earlier revisions of this comment claimed "The Anchor program
// verifies denomination == pool.denomination before inserting." That is false — the
// program verifies no deposit proof at all. The claim has been removed rather than
// left as a security property nobody enforces. What must hold is that this file and
// withdraw.circom use the identical Poseidon(nullifier, secret, denomination)
// formula, so a note built at deposit time is spendable at withdrawal time.
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
