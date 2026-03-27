// sdk/src/index.ts — barrel export

export { generateNote, encodeNote, decodeNote } from "./note.js";
export type { SecretNote } from "./note.js";

export {
  initPoseidon,
  poseidonHash,
  pubkeyToField,
  MerkleTree,
  generateWithdrawProof,
} from "./proof.js";
export type {
  Groth16Proof,
  MerkleProofData,
  CircuitPaths,
} from "./proof.js";

// FeeQuote is defined in both proof.ts and fees.ts (same shape).
// Re-export from fees.ts as the canonical source.
export { computeTreasuryFee, computeMinUserReceives, getFeeQuote } from "./fees.js";
export type { FeeQuote } from "./fees.js";
