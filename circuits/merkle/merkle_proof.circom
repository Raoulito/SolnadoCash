pragma circom 2.0.0;

include "../lib/poseidon.circom";

// MerkleProof(levels) — verifies that `leaf` is a member of an incremental
// Merkle tree rooted at `root`, using the supplied Merkle path.
//
// Conventions:
//   pathIndices[i] = 0  → the current node is the LEFT child at level i
//   pathIndices[i] = 1  → the current node is the RIGHT child at level i
//
// The root is recomputed bottom-up from the leaf. If the recomputed root
// matches the public `root` signal, the membership proof is valid.
//
// R1CS constraint note:
//   Each constraint can contain at most ONE multiplication, and the left/right selection needs
//   only one. Writing it as two products was the obvious form and cost one constraint per level
//   more than necessary:
//
//     tmp_left  = idx * (sibling - current)     ← quadratic
//     tmp_right = idx * (current - sibling)     ← quadratic, and exactly -tmp_left
//
//   Since the second product is the negation of the first, `right` follows from the same product
//   with no further multiplication:
//
//     sel   = idx * (sibling - current)         ← the only quadratic constraint
//     left  = current + sel                     ← linear
//     right = sibling - sel                     ← linear
//
//   By cases, with d = sibling - current:
//     idx = 0 → sel = 0 → left = current,             right = sibling
//     idx = 1 → sel = d → left = current + d = sibling, right = sibling - d = current
//
//   Identical semantics, 20 constraints saved on a depth-20 tree, 40 once the association-set
//   proof adds a second tree. That is only ~0.17% of the circuit, so it is not a performance
//   change; it is done because it is free and correct, and because altering this template
//   invalidates the proving key — so it can only ride along with a change that already requires a
//   new ceremony rather than justify one of its own.
//
//   Equivalence was checked by instantiating the previous and current templates over the same
//   signals in one circuit: a valid mixed-direction path is accepted, and a corrupted root,
//   corrupted sibling and non-binary index are each rejected.
template MerkleProof(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];  // Sibling hash at each level
    signal input pathIndices[levels];   // 0 = left child, 1 = right child

    // levelHashes[0] = leaf, levelHashes[levels] = recomputed root
    signal levelHashes[levels + 1];
    levelHashes[0] <== leaf;

    // One product per level: sel[i] = pathIndices[i] * (pathElements[i] - levelHashes[i])
    signal sel[levels];
    signal lefts[levels];
    signal rights[levels];

    component hashers[levels];

    for (var i = 0; i < levels; i++) {
        // pathIndices[i] must be binary (0 or 1).
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        hashers[i] = PoseidonHash(2);

        sel[i]    <== pathIndices[i] * (pathElements[i] - levelHashes[i]);
        lefts[i]  <== levelHashes[i] + sel[i];
        rights[i] <== pathElements[i] - sel[i];

        hashers[i].inputs[0] <== lefts[i];
        hashers[i].inputs[1] <== rights[i];

        levelHashes[i + 1] <== hashers[i].out;
    }

    // The recomputed root must equal the claimed root.
    root === levelHashes[levels];
}
