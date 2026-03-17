// relayer/src/fees.js
// T24 — Dynamic relayer fee computation per PROJET_enhanced.md Section 12.6
//
// The relayer fee is NOT a fixed percentage. It's computed from real network
// conditions: base fee + priority fee + nullifier rent + 50% margin.

const BASE_FEE = 5000;               // lamports per signature (Solana fixed)
const COMPUTE_UNITS = 200_000;        // CU budget for withdraw tx (measured: ~100k, buffer 2x)
const NULLIFIER_RENT = 2_039_280;     // ~0.002 SOL rent for nullifier PDA
const MARGIN = 1.5;                   // 50% margin on estimated gas cost

/**
 * Compute the dynamic relayerFeeMax based on current network conditions.
 *
 * @param {import("@solana/web3.js").Connection} connection - Solana RPC connection
 * @returns {Promise<number>} relayerFeeMax in lamports
 */
export async function computeRelayerFeeMax(connection) {
  let priorityFeePerCU = 0;

  try {
    const fees = await connection.getRecentPrioritizationFees();
    if (fees.length > 0) {
      // Take 90th percentile of recent priority fees (conservative estimate)
      const sorted = fees
        .map((f) => f.prioritizationFee)
        .sort((a, b) => a - b);
      priorityFeePerCU = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    }
  } catch {
    // If RPC call fails, use 0 priority fee (base fee still covers minimum)
    priorityFeePerCU = 0;
  }

  const priorityFee = priorityFeePerCU * COMPUTE_UNITS;
  const gasCost = BASE_FEE + priorityFee + NULLIFIER_RENT;
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

export { BASE_FEE, COMPUTE_UNITS, NULLIFIER_RENT, MARGIN };
