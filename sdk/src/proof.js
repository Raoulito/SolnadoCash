"use strict";
// sdk/src/proof.ts
// T32 — generateWithdrawProof (uses snarkjs + WASM from circuits build)
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MerkleTree = void 0;
exports.initPoseidon = initPoseidon;
exports.poseidonHash = poseidonHash;
exports.pubkeyToField = pubkeyToField;
exports.generateWithdrawProof = generateWithdrawProof;
const circomlibjs_1 = require("circomlibjs");
const snarkjs = __importStar(require("snarkjs"));
// BN254 scalar field prime (Fr) — Poseidon and circuits operate over this field.
// Pubkeys (256 bits) can exceed Fr (~254 bits), must reduce mod Fr before hashing.
const BN254_FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const TREE_DEPTH = 20;
// ── Poseidon singleton ──────────────────────────────────────────────────────
let _poseidon;
let _F;
async function initPoseidon() {
    if (!_poseidon) {
        _poseidon = await (0, circomlibjs_1.buildPoseidon)();
        _F = _poseidon.F;
    }
}
function poseidonHash(...inputs) {
    if (!_poseidon)
        throw new Error("Call initPoseidon() first");
    const result = _poseidon(inputs.map((x) => _F.e(x)));
    return BigInt(_F.toObject(result));
}
// ── Pubkey → field element ──────────────────────────────────────────────────
/** Reduce a Solana pubkey (256 bits) to a BN254 Fr field element. */
function pubkeyToField(pk) {
    const bytes = pk.toBytes();
    let v = 0n;
    for (const b of bytes)
        v = (v << 8n) | BigInt(b);
    return v % BN254_FIELD_ORDER;
}
// ── Incremental Merkle Tree ─────────────────────────────────────────────────
/**
 * Sparse Merkle tree using layered storage.
 * Mirrors the on-chain incremental Merkle tree (depth 20, Poseidon hash).
 * Supports insertion, proof generation for any leaf, and leaf lookup.
 */
class MerkleTree {
    constructor(depth = TREE_DEPTH) {
        if (!_poseidon)
            throw new Error("Call initPoseidon() before creating a MerkleTree");
        this.depth = depth;
        this.zeros = this.buildZeros();
        this.layers = Array.from({ length: depth + 1 }, () => []);
    }
    buildZeros() {
        const zeros = new Array(this.depth + 1);
        zeros[0] = 0n;
        for (let i = 1; i <= this.depth; i++) {
            zeros[i] = poseidonHash(zeros[i - 1], zeros[i - 1]);
        }
        return zeros;
    }
    get nextIndex() {
        return this.layers[0].length;
    }
    get root() {
        if (this.layers[0].length === 0) {
            return this.zeros[this.depth];
        }
        return this.nodeAt(this.depth, 0);
    }
    /** Insert a leaf and update all parent layers. Returns the leaf index. */
    insert(leaf) {
        const index = this.layers[0].length;
        this.layers[0].push(leaf);
        let currentIndex = index;
        for (let level = 1; level <= this.depth; level++) {
            const parentIndex = currentIndex >> 1;
            const leftChild = this.nodeAt(level - 1, parentIndex * 2);
            const rightChild = this.nodeAt(level - 1, parentIndex * 2 + 1);
            const parent = poseidonHash(leftChild, rightChild);
            if (parentIndex < this.layers[level].length) {
                this.layers[level][parentIndex] = parent;
            }
            else {
                this.layers[level].push(parent);
            }
            currentIndex = parentIndex;
        }
        return index;
    }
    /** Get the Merkle proof (path elements + indices) for a given leaf. */
    getProof(leafIndex) {
        if (leafIndex < 0 || leafIndex >= this.layers[0].length) {
            throw new Error(`Leaf index ${leafIndex} out of range [0, ${this.layers[0].length})`);
        }
        const pathElements = [];
        const pathIndices = [];
        let currentIndex = leafIndex;
        for (let level = 0; level < this.depth; level++) {
            const isRight = currentIndex % 2 === 1;
            const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
            pathIndices.push(isRight ? 1 : 0);
            pathElements.push(this.nodeAt(level, siblingIndex));
            currentIndex = currentIndex >> 1;
        }
        return { pathElements, pathIndices, root: this.root, leafIndex };
    }
    /** Find the index of a leaf value, or -1 if not found. */
    findLeaf(leaf) {
        return this.layers[0].indexOf(leaf);
    }
    /** Get the node value at a given level and index (zeros for empty positions). */
    nodeAt(level, index) {
        if (index < this.layers[level].length) {
            return this.layers[level][index];
        }
        return this.zeros[level];
    }
}
exports.MerkleTree = MerkleTree;
// ── Proof generation ────────────────────────────────────────────────────────
/**
 * Generate a Groth16 withdraw proof.
 *
 * @param note - The secret note from deposit (contains nullifier, secret, denomination, poolAddress)
 * @param quote - Fee quote from relayer (contains relayerAddress, relayerFeeMax)
 * @param recipient - Destination wallet for the withdrawal
 * @param merkleTree - Merkle tree rebuilt from all deposit events
 * @param circuitPaths - Paths to withdraw.wasm and withdraw_final.zkey
 * @returns Groth16 proof and public signals [nullifierHash, root, withdrawalCommitment]
 */
async function generateWithdrawProof(note, quote, recipient, merkleTree, circuitPaths) {
    await initPoseidon();
    // Compute commitment from note to find it in the tree
    const commitment = poseidonHash(note.nullifier, note.secret, note.denomination);
    // Find leaf in tree
    const leafIndex = merkleTree.findLeaf(commitment);
    if (leafIndex === -1) {
        throw new Error("Commitment not found in Merkle tree — rebuild tree from all deposit events");
    }
    // Get Merkle proof
    const merkleProof = merkleTree.getProof(leafIndex);
    // Compute derived values
    const nullifierHash = poseidonHash(note.nullifier);
    const relayerField = pubkeyToField(quote.relayerAddress);
    const recipientField = pubkeyToField(recipient);
    const withdrawalCommitment = poseidonHash(relayerField, quote.relayerFeeMax, recipientField);
    // Build circom inputs (all as decimal strings)
    const circomInputs = {
        nullifierHash: nullifierHash.toString(),
        root: merkleProof.root.toString(),
        withdrawalCommitment: withdrawalCommitment.toString(),
        nullifier: note.nullifier.toString(),
        secret: note.secret.toString(),
        denomination: note.denomination.toString(),
        pathElements: merkleProof.pathElements.map((e) => e.toString()),
        pathIndices: merkleProof.pathIndices.map((i) => i.toString()),
        recipient: recipientField.toString(),
        relayerAddress: relayerField.toString(),
        relayerFeeMax: quote.relayerFeeMax.toString(),
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(circomInputs, circuitPaths.wasmPath, circuitPaths.zkeyPath);
    return {
        proof: proof,
        publicSignals: [
            BigInt(publicSignals[0]),
            BigInt(publicSignals[1]),
            BigInt(publicSignals[2]),
        ],
    };
}
