// relayer/src/fees.js
// T24 — Dynamic relayer fee computation per PROJET_enhanced.md Section 12.6
//
// The relayer fee is NOT a fixed percentage. It's computed from real network
// conditions: base fee + priority fee + nullifier rent + 50% margin.

const BASE_FEE = 5000;               // lamports per signature (Solana fixed)
const COMPUTE_UNITS = 200_000;        // CU budget for withdraw tx (measured: ~100k, buffer 2x)
// Nullifier account: 8-byte discriminator + NullifierAccount (32+32+8) = 80 bytes.
const NULLIFIER_ACCOUNT_SIZE = 80;
// Fallback rent for the 80-byte nullifier account, used only when the chain cannot be read and no
// value has been read before: (128 + 80) * 5080 = 1_056_640 lamports. Rent sysvar on devnet and
// mainnet, read 2026-10-01: 5,080 lamports per byte-year, exemption threshold 1 year. It was
// (128 + 80) * 3480 * 2 = 1_447_680 under the earlier parameters, and 2_039_280 before M-6, which
// is the rent for a 165-byte SPL token account. The live value is what is charged.
const NULLIFIER_RENT = 1_056_640;
const MARGIN = 1.5;                   // 50% margin on estimated gas cost
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000; // getRecentPrioritizationFees unit

/**
 * Read the recent priority fee, in MICRO-lamports per compute unit.
 *
 * `getRecentPrioritizationFees` reports micro-lamports per CU (1e-6 lamports),
 * which is also the unit `ComputeBudgetProgram.setComputeUnitPrice` expects — so
 * this value is passed straight to the transaction builder.
 *
 * L-9: scoped to `writableAccounts`. Called without accounts, the RPC reports the minimum fee that
 * landed a transaction in each slot, which is 0 whenever anything got in for free: measured on
 * mainnet, all 150 slots were 0 while the same query for a contended writable account was non-zero
 * in 135 of 150 (p90 12,810 uL/CU). Priority is decided per write lock, so the estimate must be for
 * the accounts a withdrawal locks: the pool's vault and the relayer.
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @param {import("@solana/web3.js").PublicKey[]} writableAccounts - accounts the transaction write-locks
 * @returns {Promise<number>} micro-lamports per compute unit
 */
export async function getPriorityFeePerCU(connection, writableAccounts) {
  try {
    const fees = await connection.getRecentPrioritizationFees(
      writableAccounts?.length ? { lockedWritableAccounts: writableAccounts } : undefined
    );
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

// Rent is a cluster parameter, so read it from the chain rather than trusting a
// hardcoded constant (M-6). Cached per connection: different clusters can differ,
// and a process-wide cache would leak one cluster's value into another.
// Per connection: the last rent read from the chain and when. Re-read after RENT_TTL_MS, because rent
// does change (the 80-byte figure fell from 1,447,680 to 1,056,640 lamports), and a value cached for
// the life of the process kept charging the old figure until a restart. A failed read is never cached.
const _nullifierRentByConnection = new WeakMap();
const RENT_TTL_MS = 10 * 60_000;

/**
 * Rent-exempt minimum for the nullifier account, in lamports.
 *
 * This cost is PERMANENT by design and must not be reclaimed: the nullifier PDA is
 * the double-spend guard, and the deposit's leaf remains in the Merkle tree
 * forever, so a note holder could always prove membership against a current root.
 * Closing a spent nullifier account would therefore re-enable withdrawal of an
 * already-spent note. (An earlier revision of SECURITY-REVIEW.md suggested adding a
 * close_nullifier instruction to recover this rent — that recommendation was unsafe
 * and has been retracted.)
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @param {() => number} [now] - clock, for tests
 * @returns {Promise<number>} lamports
 */
export async function getNullifierRent(connection, now = Date.now) {
  const cached = _nullifierRentByConnection.get(connection);
  if (cached && now() - cached.at < RENT_TTL_MS) return cached.rent;
  try {
    const rent = await connection.getMinimumBalanceForRentExemption(NULLIFIER_ACCOUNT_SIZE);
    _nullifierRentByConnection.set(connection, { rent, at: now() });
    return rent;
  } catch {
    // The last value read from the chain beats the constant; neither is cached as fresh.
    return cached?.rent ?? NULLIFIER_RENT;
  }
}

/**
 * Convert a lamport budget for priority fees back into micro-lamports per compute unit.
 *
 * Inverse of `priorityFeeLamports`, rounded DOWN so the resulting per-CU price can never spend
 * more than the budget allows.
 *
 * @param {number} lamports
 * @returns {number} micro-lamports per compute unit
 */
export function priorityPerCUFromLamports(lamports) {
  if (lamports <= 0) return 0;
  return Math.floor((lamports * MICRO_LAMPORTS_PER_LAMPORT) / COMPUTE_UNITS);
}

/**
 * Decide what the relayer will actually spend and charge for one withdrawal.
 *
 * The problem this solves. `relayer_fee_max` is frozen into the ZK proof when the user requests a
 * quote, but the transaction is submitted 30 to 90 seconds later, after proof generation. If
 * network congestion rises in between, the priority fee needed to land the transaction can exceed
 * what the ceiling reimburses. Previously the relayer clamped what it CHARGED to the ceiling while
 * still attaching the full estimated priority fee, so it paid the difference out of pocket with no
 * bound. Sustained congestion, or an attacker deliberately inducing it, would bleed the relayer to
 * insolvency; and an insolvent relayer is worse than a slow one, because users are then pushed into
 * self-relaying, which destroys the privacy they came for.
 *
 * So the priority fee is capped by what the ceiling can actually pay for, after the two
 * deterministic costs (signature fee and nullifier rent) are covered. Under congestion the relayer
 * degrades to a lower priority fee and slower inclusion instead of to a loss, and what it charges
 * always equals what it spends.
 *
 * @param {object} p
 * @param {bigint} p.feeMax - ceiling bound into the proof
 * @param {number} p.rent - nullifier rent, read from the chain
 * @param {number} p.estimatedPriorityPerCU - current p90 estimate, micro-lamports per CU
 * @returns {{ appliedPriorityPerCU: number, actualFee: bigint, degraded: boolean, shortfall: number }}
 */
export function planFee({ feeMax, rent, estimatedPriorityPerCU }) {
  const deterministic = BASE_FEE + rent;
  const budgetForPriority = Number(feeMax) - deterministic;

  const wantedLamports = priorityFeeLamports(estimatedPriorityPerCU);
  const affordableLamports = Math.max(0, budgetForPriority);
  const appliedLamports = Math.min(wantedLamports, affordableLamports);

  // Round-trip through per-CU so the charge matches what setComputeUnitPrice will really cost.
  const appliedPriorityPerCU = priorityPerCUFromLamports(appliedLamports);
  const spentOnPriority = priorityFeeLamports(appliedPriorityPerCU);

  // The charge is still clamped to the ceiling. If the ceiling is below the deterministic cost the
  // result reports the shortfall as `subsidy` rather than hiding it. The submit route refuses any
  // such ceiling before it gets here (H-3): the earlier policy of subsidising small rungs (N-1) let
  // anyone bind a ceiling of 0 into a genuine proof and make the relayer pay the nullifier rent, and
  // every rung on the current ladder covers its cost anyway. Capping the priority component above is
  // what keeps a ceiling AT or above the deterministic cost from ever producing a subsidy.
  const spent = deterministic + spentOnPriority;
  const charged = BigInt(spent) < feeMax ? BigInt(spent) : feeMax;

  return {
    appliedPriorityPerCU,
    actualFee: charged,
    degraded: wantedLamports > affordableLamports,
    shortfall: Math.max(0, wantedLamports - affordableLamports),
    // What the relayer cannot recover. Zero in normal operation.
    subsidy: Math.max(0, spent - Number(charged)),
  };
}

/**
 * The relayer's real cost to submit one withdrawal, in lamports.
 * No margin — this is what an honest relayer should actually take.
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @returns {Promise<number>} lamports
 */
export async function computeRelayerCost(connection, writableAccounts) {
  const priorityFeePerCU = await getPriorityFeePerCU(connection, writableAccounts);
  const rent = await getNullifierRent(connection);
  return BASE_FEE + priorityFeeLamports(priorityFeePerCU) + rent;
}

/**
 * Compute the dynamic relayerFeeMax (the ceiling the user commits to in the ZK
 * proof) based on current network conditions: real cost plus a margin to absorb
 * fee movement between quote and submission.
 *
 * @param {import("@solana/web3.js").Connection} connection - Solana RPC connection
 * @returns {Promise<number>} relayerFeeMax in lamports
 */
export async function computeRelayerFeeMax(connection, writableAccounts) {
  return feeMaxFromCost(await computeRelayerCost(connection, writableAccounts));
}

/**
 * The ceiling for a cost already computed: cost plus the margin. /fee_quote uses this with the cost
 * it has just checked against the pool's cap, so both come from one fee snapshot and one RPC call.
 *
 * @param {number} cost - lamports, from computeRelayerCost
 * @returns {number} lamports
 */
export function feeMaxFromCost(cost) {
  return Math.ceil(cost * MARGIN);
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

export {
  BASE_FEE,
  COMPUTE_UNITS,
  NULLIFIER_RENT,
  NULLIFIER_ACCOUNT_SIZE,
  MARGIN,
  MICRO_LAMPORTS_PER_LAMPORT,
};
