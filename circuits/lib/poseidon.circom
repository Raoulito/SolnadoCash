pragma circom 2.0.0;

// Wrapper around circomlib's Poseidon hash function.
// Compiled with: circom ... -l node_modules
// so includes resolve against node_modules/circomlib/circuits/
include "circomlib/circuits/poseidon.circom";

// PoseidonHash(nInputs) — convenience template that wraps circomlib Poseidon.
// Usage:
//   component h = PoseidonHash(2);
//   h.inputs[0] <== a;
//   h.inputs[1] <== b;
//   out <== h.out;
template PoseidonHash(nInputs) {
    signal input inputs[nInputs];
    signal output out;

    component hasher = Poseidon(nInputs);
    for (var i = 0; i < nInputs; i++) {
        hasher.inputs[i] <== inputs[i];
    }
    out <== hasher.out;
}
