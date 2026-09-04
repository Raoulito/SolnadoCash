pragma circom 2.0.0;

include "../lib/poseidon.circom";
include "../merkle/merkle_proof.circom";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROTOTYPE — feasibility study for association-set compliance ("proof of innocence").
//
// NOT the production circuit. `circuits/withdraw/withdraw.circom` remains authoritative. This file
// exists to answer one question with a number rather than an opinion: what does adding a compliance
// proof cost in constraints, proving time and on-chain compute?
//
// ── The construction ────────────────────────────────────────────────────────────────────────
//
// Follows Buterin, Illum, Nadler, Schär and Soleimani (2023), "Blockchain Privacy and Regulatory
// Compliance: Towards a Practical Equilibrium", as deployed by 0xbow's Privacy Pools on Ethereum
// mainnet since 31 March 2025.
//
// A withdrawal proves TWO memberships against the same leaf:
//
//   1. commitment ∈ state tree        — "I own an unspent deposit in this pool"   (already shipped)
//   2. commitment ∈ association tree  — "and that deposit was vetted as clean"    (this addition)
//
// Because both proofs are over the same private `commitment`, and the commitment is never revealed,
// the withdrawal demonstrates provenance without identifying which deposit it spends. The
// association root is public, so any observer can check WHICH set was proven against; nobody can
// determine which member.
//
// ── Deviation from 0xbow, and why ───────────────────────────────────────────────────────────
//
// 0xbow's association tree is keyed on a per-deposit `label` rather than the commitment itself.
// That indirection exists to support partial withdrawals: one deposit of arbitrary value can be
// spent across several withdrawals, so approval has to attach to something more stable than a
// single spend. SornadoCash pools are fixed-denomination and a note is spent exactly once, so the
// commitment is already a stable per-deposit identifier and the label adds nothing here. Using the
// commitment directly keeps the existing note format unchanged — deployed notes stay valid.
//
// The association tree contains a public subset of the already-public deposit set, so publishing it
// leaks nothing that the chain does not already show.
//
// ── What this circuit deliberately does NOT solve ───────────────────────────────────────────
//
// A user whose deposit an ASP declines must still be able to recover funds, or the ASP becomes a
// custodian by omission and the protocol stops being non-custodial. 0xbow solves this with
// "ragequit": prove knowledge of the deposit secrets and withdraw to the original depositor,
// forfeiting privacy but never the funds. That is a SEPARATE circuit and instruction, and it is a
// hard requirement for shipping this, not an optional extra. See the accompanying feasibility note.
//
// ── Anonymity-set consequence ───────────────────────────────────────────────────────────────
//
// The effective anonymity set becomes the ASP-approved subset, not the whole pool. On a pool with
// few deposits this is strictly worse than the status quo, which is an argument for sequencing the
// compliance work before liquidity growth rather than after.
// ─────────────────────────────────────────────────────────────────────────────────────────────

template WithdrawCompliant(levels, aspLevels) {
    // ── PUBLIC inputs — FOUR, in this order ──────────────────────────────────
    // One more than production. The on-chain verifying key must be regenerated with
    // nr_pubinputs = 4 and five IC points.
    signal input nullifierHash;           // Poseidon(nullifier)
    signal input root;                    // state tree root, from the pool's 256-entry ring
    signal input associationRoot;         // ASP-published root of vetted deposits
    signal input withdrawalCommitment;    // Poseidon(relayer, relayerFeeMax, recipient)

    // ── PRIVATE inputs ────────────────────────────────────────────────────────
    signal input nullifier;
    signal input secret;
    signal input denomination;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal input aspPathElements[aspLevels];   // new
    signal input aspPathIndices[aspLevels];    // new
    signal input recipient;
    signal input relayerAddress;
    signal input relayerFeeMax;

    // ── C1: nullifierHash === Poseidon(nullifier) ─────────────────────────────
    component nullifierHasher = PoseidonHash(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHash === nullifierHasher.out;

    // ── C2: reconstruct the commitment ────────────────────────────────────────
    // Identical to production, so existing notes remain spendable under this circuit.
    component commitmentHasher = PoseidonHash(3);
    commitmentHasher.inputs[0] <== nullifier;
    commitmentHasher.inputs[1] <== secret;
    commitmentHasher.inputs[2] <== denomination;

    // ── C3: the commitment is in the pool's state tree ────────────────────────
    component stateTree = MerkleProof(levels);
    stateTree.leaf <== commitmentHasher.out;
    stateTree.root <== root;
    for (var i = 0; i < levels; i++) {
        stateTree.pathElements[i] <== pathElements[i];
        stateTree.pathIndices[i]  <== pathIndices[i];
    }

    // ── C4: the SAME commitment is in the association set ─────────────────────
    // Sharing `commitmentHasher.out` between C3 and C4 is what makes this a proof about one
    // deposit rather than two unrelated ones. Feeding the association proof a different leaf would
    // let a user borrow someone else's clean deposit to launder their own.
    component aspTree = MerkleProof(aspLevels);
    aspTree.leaf <== commitmentHasher.out;
    aspTree.root <== associationRoot;
    for (var i = 0; i < aspLevels; i++) {
        aspTree.pathElements[i] <== aspPathElements[i];
        aspTree.pathIndices[i]  <== aspPathIndices[i];
    }

    // ── C5: bind relayer, fee ceiling and recipient ───────────────────────────
    component wcHasher = PoseidonHash(3);
    wcHasher.inputs[0] <== relayerAddress;
    wcHasher.inputs[1] <== relayerFeeMax;
    wcHasher.inputs[2] <== recipient;
    withdrawalCommitment === wcHasher.out;
}

component main {
    public [nullifierHash, root, associationRoot, withdrawalCommitment]
} = WithdrawCompliant(20, 20);
