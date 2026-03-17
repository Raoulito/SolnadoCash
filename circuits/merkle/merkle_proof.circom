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
//   Each constraint can contain at most ONE multiplication.
//   The selection "if idx=0: left=current, else left=sibling" is implemented as:
//     tmp[i] = idx * (sibling - current)    ← ONE multiplication (quadratic)
//     left   = tmp[i] + current             ← linear (no multiplication)
//   Equivalent to: left = current + idx*(sibling - current)
//     When idx=0: left = current   ✓
//     When idx=1: left = sibling   ✓
template MerkleProof(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];  // Sibling hash at each level
    signal input pathIndices[levels];   // 0 = left child, 1 = right child

    // levelHashes[0] = leaf, levelHashes[levels] = recomputed root
    signal levelHashes[levels + 1];
    levelHashes[0] <== leaf;

    // Intermediate signals — one set per level.
    // tmp_left[i]  = pathIndices[i] * (pathElements[i] - levelHashes[i])
    // tmp_right[i] = pathIndices[i] * (levelHashes[i]  - pathElements[i])
    signal tmp_left[levels];
    signal tmp_right[levels];
    signal lefts[levels];
    signal rights[levels];

    component hashers[levels];

    for (var i = 0; i < levels; i++) {
        // pathIndices[i] must be binary (0 or 1).
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        hashers[i] = PoseidonHash(2);

        // Left selection: current when idx=0, sibling when idx=1
        tmp_left[i]  <== pathIndices[i] * (pathElements[i] - levelHashes[i]);
        lefts[i]     <== tmp_left[i] + levelHashes[i];

        // Right selection: sibling when idx=0, current when idx=1
        tmp_right[i] <== pathIndices[i] * (levelHashes[i] - pathElements[i]);
        rights[i]    <== tmp_right[i] + pathElements[i];

        hashers[i].inputs[0] <== lefts[i];
        hashers[i].inputs[1] <== rights[i];

        levelHashes[i + 1] <== hashers[i].out;
    }

    // The recomputed root must equal the claimed root.
    root === levelHashes[levels];
}
