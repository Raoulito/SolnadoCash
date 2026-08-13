// relayer/src/fees.js
// T24 — Dynamic relayer fee computation per PROJET_enhanced.md Section 12.6
//
// The relayer fee is NOT a fixed percentage. It's computed from real network
// conditions: base fee + priority fee + nullifier rent + 50% margin.

const BASE_FEE = 5000;               // lamports per signature (Solana fixed)
const COMPUTE_UNITS = 200_000;        // CU budget for withdraw tx (measured: ~100k, buffer 2x)
const NULLIFIER_RENT = 2_039_280;     // ~0.002 SOL rent for nullifier PDA
const MARGIN = 1.5;                   // 50% margin on estimated gas cost
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000; // getRecentPrioritizationFees unit

/**
 * Read the recent priority fee, in MICRO-lamports per compute unit.
 *
 * `getRecentPrioritizationFees` reports micro-lamports per CU (1e-6 lamports),
 * which is also the unit `ComputeBudgetProgram.setComputeUnitPrice` expects — so
 * this value is passed straight to the transaction builder.
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @returns {Promise<number>} micro-lamports per compute unit
 */
export async function getPriorityFeePerCU(connection) {
  try {
    const fees = await connection.getRecentPrioritizationFees();
    if (!fees || fees.length === 0) return 0;
    // 90th percentile of recent priority fees (conservative estimate)
    const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  } catch {
    // If the RPC call fails, fall back to no priority fee — the base fee still
    // covers the minimum.
    return 0;
  }
}

/**
 * Convert a priority fee in micro-lamports/CU into the lamports actually charged
 * for COMPUTE_UNITS of budget.
 *
 * H-3: this division by 1e6 was missing, inflating the priority component by a
 * factor of one million. At 1,000 µL/CU that turned a 300 lamport cost into
 * 0.2 SOL, and above ~3,300 µL/CU the quote exceeded the pool denomination, so
 * `checked_sub` underflowed on-chain and every withdrawal failed.
 *
 * @param {number} priorityFeePerCU - micro-lamports per compute unit
 * @returns {number} lamports
 */
export function priorityFeeLamports(priorityFeePerCU) {
  return Math.ceil((priorityFeePerCU * COMPUTE_UNITS) / MICRO_LAMPORTS_PER_LAMPORT);
}

/**
 * The relayer's real cost to submit one withdrawal, in lamports.
 * No margin — this is what an honest relayer should actually take.
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @returns {Promise<number>} lamports
 */
export async function computeRelayerCost(connection) {
  const priorityFeePerCU = await getPriorityFeePerCU(connection);
  return BASE_FEE + priorityFeeLamports(priorityFeePerCU) + NULLIFIER_RENT;
}

/**
 * Compute the dynamic relayerFeeMax (the ceiling the user commits to in the ZK
 * proof) based on current network conditions: real cost plus a margin to absorb
 * fee movement between quote and submission.
 *
 * @param {import("@solana/web3.js").Connection} connection - Solana RPC connection
 * @returns {Promise<number>} relayerFeeMax in lamports
 */
export async function computeRelayerFeeMax(connection) {
  const gasCost = await computeRelayerCost(connection);
  return Math.ceil(gasCost * MARGIN);
}

/**
 * Compute the treasury fee for a given denomination.
 * Canonical formula: denomination / 500 (= 0.2%)
 *
 * @param {bigint} denomination - Pool denomination in lamports
 * @returns {bigint} Treasury fee in lamports
 */
export function computeTreasuryFee(denomination) {
  return denomination / 500n;
}

/**
 * Compute the minimum amount the user receives after all fees.
 *
 * @param {bigint} denomination - Pool denomination in lamports
 * @param {bigint} relayerFeeMax - Max relayer fee in lamports
 * @returns {bigint} Minimum user receives in lamports
 */
export function computeMinUserReceives(denomination, relayerFeeMax) {
  const treasuryFee = computeTreasuryFee(denomination);
  return denomination - treasuryFee - relayerFeeMax;
}

export { BASE_FEE, COMPUTE_UNITS, NULLIFIER_RENT, MARGIN, MICRO_LAMPORTS_PER_LAMPORT };
