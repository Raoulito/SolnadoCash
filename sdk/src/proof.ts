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

/**
 * Map a Solana pubkey to a single BN254 field element.
 *
 * MUST match `pubkey_to_field` in programs/solnadocash/src/withdraw.rs exactly,
 * or the on-chain withdrawal-commitment check rejects every proof.
 *
 * The pubkey is split into its two 128-bit halves (both < 2^128 < Fr) and hashed.
 * The previous encoding was `pubkey mod Fr`, which is not injective: 81% of
 * addresses have a distinct alias `R + Fr` with the same field element, letting a
 * malicious relayer redirect a withdrawal to an unspendable address (H-2). Under
 * this encoding a collision requires ~2^127 work.
 *
 * The encoding is outside the circuit — `recipient` and `relayerAddress` are
 * opaque field elements to withdraw.circom — so it is not part of the trusted
 * setup and can be changed without a new ceremony.
 */
export function pubkeyToField(pk: PublicKey): bigint {
  const bytes = pk.toBytes();
  let hi = 0n;
  let lo = 0n;
  for (let i = 0; i < 16; i++) hi = (hi << 8n) | BigInt(bytes[i]);
  for (let i = 16; i < 32; i++) lo = (lo << 8n) | BigInt(bytes[i]);
  if (!_poseidon) throw new Error("Call initPoseidon() first");
  return poseidonHash(hi, lo);
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

  /**
   * All indices at which a leaf value appears (L-3).
   *
   * The program accepts duplicate commitments — it cannot cheaply do otherwise, since
   * detecting them would mean storing every leaf on-chain. But a commitment maps to
   * exactly one nullifier, so only ONE of a set of duplicate leaves is ever
   * withdrawable: the second deposit of the same commitment is permanently locked.
   *
   * Randomly generated notes never collide (2 x 254 bits), so in practice this only
   * happens when a note is reused — depositing with the same note twice. Callers
   * should check before depositing rather than discovering it at withdrawal time.
   */
  findAllLeaves(leaf: bigint): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.layers[0].length; i++) {
      if (this.layers[0][i] === leaf) out.push(i);
    }
    return out;
  }

  /** True if this commitment is already in the tree (L-3). */
  hasLeaf(leaf: bigint): boolean {
    return this.findLeaf(leaf) !== -1;
  }

  /** Get the node value at a given level and index (zeros for empty positions). */
  private nodeAt(level: number, index: number): bigint {
    if (index < this.layers[level].length) {
      return this.layers[level][index];
    }
    return this.zeros[level];
  }
}

// ── Pool tree state / verification (H-5) ────────────────────────────────────

export const ROOT_HISTORY_SIZE = 256;

// Offsets into the raw Pool account data, including the 8-byte Anchor
// discriminator. Must match programs/solnadocash/src/state.rs.
const POOL_NEXT_INDEX_OFFSET = 8 + 80;
const POOL_CURRENT_ROOT_INDEX_OFFSET = 8 + 128;
const POOL_ROOT_HISTORY_OFFSET = 8 + 136;
const POOL_MIN_LEN = POOL_ROOT_HISTORY_OFFSET + ROOT_HISTORY_SIZE * 32;

export interface PoolTreeState {
  /** Number of leaves inserted on-chain. */
  nextIndex: number;
  /** Index of the newest root in the ring buffer. */
  currentRootIndex: number;
  /** The 256-entry root ring buffer, as field elements (0 = unused slot). */
  roots: bigint[];
}

function readU64LE(data: Uint8Array, offset: number): number {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]);
  return Number(v);
}

/** Decode the Merkle-relevant fields of a raw Pool account. */
export function readPoolTreeState(poolData: Uint8Array): PoolTreeState {
  if (poolData.length < POOL_MIN_LEN) {
    throw new Error(
      `Pool account too small: ${poolData.length} bytes, expected >= ${POOL_MIN_LEN}`
    );
  }
  const roots: bigint[] = [];
  for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
    const start = POOL_ROOT_HISTORY_OFFSET + i * 32;
    let v = 0n;
    for (let j = 0; j < 32; j++) v = (v << 8n) | BigInt(poolData[start + j]);
    roots.push(v);
  }
  return {
    nextIndex: readU64LE(poolData, POOL_NEXT_INDEX_OFFSET),
    currentRootIndex: readU64LE(poolData, POOL_CURRENT_ROOT_INDEX_OFFSET),
    roots,
  };
}

/**
 * Verify a locally rebuilt tree against on-chain pool state (H-5).
 *
 * A tree rebuilt from transaction logs is silently wrong whenever a deposit is
 * missed — public RPC endpoints prune history and rate-limit, so this is a
 * question of when, not if. An unverified tree produces a proof against a root the
 * chain never had: the withdrawal fails with RootNotFound or InvalidProof and the
 * UI tells the user to "try again", which never converges.
 *
 * Two independent checks:
 *  - leaf count must equal pool.next_index (catches missing or extra leaves, and
 *    gives a precise "N of M deposits recovered" diagnostic)
 *  - the tree root must appear in the on-chain root history (the authoritative
 *    check: this is exactly what the program enforces at withdrawal time)
 *
 * Call this BEFORE generating a proof.
 *
 * @throws with an actionable message if the tree does not match the chain.
 */
export function verifyTreeMatchesPool(
  tree: MerkleTree,
  poolData: Uint8Array
): { root: bigint; leafCount: number; rootIndex: number } {
  const state = readPoolTreeState(poolData);
  const leafCount = tree.nextIndex;

  if (leafCount !== state.nextIndex) {
    throw new Error(
      `Merkle tree is incomplete: recovered ${leafCount} of ${state.nextIndex} ` +
        `on-chain deposits. The RPC endpoint is missing deposit history ` +
        `(pruned or rate-limited) — retry with a different or archival RPC.`
    );
  }

  const root = tree.root;
  const rootIndex = state.roots.findIndex((r) => r === root);
  if (rootIndex === -1) {
    throw new Error(
      `Rebuilt Merkle root does not match any of the last ${ROOT_HISTORY_SIZE} ` +
        `on-chain roots. The recovered deposits are wrong or out of order — ` +
        `do not submit: the proof would be rejected on-chain.`
    );
  }

  return { root, leafCount, rootIndex };
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

  // L-3: duplicate commitments are accepted on-chain but share one nullifier, so
  // only the first is spendable. Proving against the earliest index is the correct
  // choice (any index yields the same nullifier), but the user should know that a
  // second deposit of this note is unrecoverable.
  const duplicates = merkleTree.findAllLeaves(commitment);
  if (duplicates.length > 1) {
    console.warn(
      `[solnadocash] This commitment appears ${duplicates.length} times in the tree ` +
        `(leaf indices ${duplicates.join(", ")}). A commitment has exactly one ` +
        `nullifier, so only one of these deposits can ever be withdrawn — the others ` +
        `are permanently locked. This means the note was reused across deposits.`
    );
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
