// sdk/src/proof.ts
// T32 — generateWithdrawProof (uses snarkjs + WASM from circuits build)

import { PublicKey } from "@solana/web3.js";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import type { SecretNote } from "./note.js";

// BN254 scalar field prime (Fr) — Poseidon and circuits operate over this field.
// Pubkeys (256 bits) can exceed Fr (~254 bits), must reduce mod Fr before hashing.
const BN254_FIELD_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const TREE_DEPTH = 20;

// ── Types ───────────────────────────────────────────────────────────────────

export interface FeeQuote {
  relayerAddress: PublicKey;
  relayerFeeMax: bigint;
  validUntil: number;
  estimatedUserReceives: bigint;
}

export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

export interface MerkleProofData {
  pathElements: bigint[];
  pathIndices: number[];
  root: bigint;
  leafIndex: number;
}

export interface CircuitPaths {
  wasmPath: string;
  zkeyPath: string;
}

// ── Poseidon singleton ──────────────────────────────────────────────────────

let _poseidon: any;
let _F: any;

export async function initPoseidon(): Promise<void> {
  if (!_poseidon) {
    _poseidon = await buildPoseidon();
    _F = _poseidon.F;
  }
}

export function poseidonHash(...inputs: bigint[]): bigint {
  if (!_poseidon) throw new Error("Call initPoseidon() first");
  const result = _poseidon(inputs.map((x: bigint) => _F.e(x)));
  return BigInt(_F.toObject(result));
}

// ── Pubkey → field element ──────────────────────────────────────────────────

/** Reduce a Solana pubkey (256 bits) to a BN254 Fr field element. */
export function pubkeyToField(pk: PublicKey): bigint {
  const bytes = pk.toBytes();
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v % BN254_FIELD_ORDER;
}

// ── Incremental Merkle Tree ─────────────────────────────────────────────────

/**
 * Sparse Merkle tree using layered storage.
 * Mirrors the on-chain incremental Merkle tree (depth 20, Poseidon hash).
 * Supports insertion, proof generation for any leaf, and leaf lookup.
 */
export class MerkleTree {
  readonly depth: number;
  readonly zeros: bigint[];
  private layers: bigint[][];

  constructor(depth: number = TREE_DEPTH) {
    if (!_poseidon) throw new Error("Call initPoseidon() before creating a MerkleTree");
    this.depth = depth;
    this.zeros = this.buildZeros();
    this.layers = Array.from({ length: depth + 1 }, () => []);
  }

  private buildZeros(): bigint[] {
    const zeros = new Array(this.depth + 1);
    zeros[0] = 0n;
    for (let i = 1; i <= this.depth; i++) {
      zeros[i] = poseidonHash(zeros[i - 1], zeros[i - 1]);
    }
    return zeros;
  }

  get nextIndex(): number {
    return this.layers[0].length;
  }

  get root(): bigint {
    if (this.layers[0].length === 0) {
      return this.zeros[this.depth];
    }
    return this.nodeAt(this.depth, 0);
  }

  /** Insert a leaf and update all parent layers. Returns the leaf index. */
  insert(leaf: bigint): number {
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
      } else {
        this.layers[level].push(parent);
      }
      currentIndex = parentIndex;
    }
    return index;
  }

  /** Get the Merkle proof (path elements + indices) for a given leaf. */
  getProof(leafIndex: number): MerkleProofData {
    if (leafIndex < 0 || leafIndex >= this.layers[0].length) {
      throw new Error(`Leaf index ${leafIndex} out of range [0, ${this.layers[0].length})`);
    }

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
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
  findLeaf(leaf: bigint): number {
    return this.layers[0].indexOf(leaf);
  }

  /** Get the node value at a given level and index (zeros for empty positions). */
  private nodeAt(level: number, index: number): bigint {
    if (index < this.layers[level].length) {
      return this.layers[level][index];
    }
    return this.zeros[level];
  }
}

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
export async function generateWithdrawProof(
  note: SecretNote,
  quote: FeeQuote,
  recipient: PublicKey,
  merkleTree: MerkleTree,
  circuitPaths: CircuitPaths
): Promise<{ proof: Groth16Proof; publicSignals: [bigint, bigint, bigint] }> {
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
  const withdrawalCommitment = poseidonHash(
    relayerField,
    quote.relayerFeeMax,
    recipientField
  );

  // Build circom inputs (all as decimal strings)
  const circomInputs: Record<string, string | string[]> = {
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

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circomInputs,
    circuitPaths.wasmPath,
    circuitPaths.zkeyPath
  );

  return {
    proof: proof as Groth16Proof,
    publicSignals: [
      BigInt(publicSignals[0]),
      BigInt(publicSignals[1]),
      BigInt(publicSignals[2]),
    ],
  };
}
