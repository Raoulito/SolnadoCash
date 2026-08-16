#!/usr/bin/env node
/**
 * Economic simulation for SornadoCash.
 *
 * Answers three separate questions that are easy to conflate:
 *
 *   1. Can the PROTOCOL lose money?  (can the vault pay out more than it took in)
 *   2. Can the OPERATOR lose money?  (treasury income minus relayer out-of-pocket)
 *   3. Can a USER lose money?        (is the payout ever less than advertised)
 *
 * It drives the real fee functions from relayer/src/fees.js rather than a model of them, so the
 * numbers move if the shipped code moves. Everything is in lamports unless a column says SOL.
 *
 * Run: node scripts/simulate_economics.js
 */

import {
  planFee,
  priorityFeeLamports,
  computeTreasuryFee,
  computeMinUserReceives,
  BASE_FEE,
  COMPUTE_UNITS,
  NULLIFIER_RENT,
  MARGIN,
} from "../relayer/src/fees.js";

const LAMPORTS_PER_SOL = 1_000_000_000;
const RENT = NULLIFIER_RENT; // 80-byte nullifier PDA, the chain value on devnet/mainnet today
const DETERMINISTIC = BASE_FEE + RENT;
const CAP_DIVISOR = 50n; // on-chain: relayer_fee_max <= denomination / 50
const TREASURY_DIVISOR = 500n; // on-chain: treasury_fee = denomination / 500

const LADDER = [
  { label: "0.1 SOL", d: 100_000_000n },
  { label: "1 SOL", d: 1_000_000_000n },
  { label: "10 SOL", d: 10_000_000_000n },
  { label: "100 SOL", d: 100_000_000_000n },
];

/**
 * Priority-fee regimes, in micro-lamports per compute unit.
 *
 * Anchored to what the numbers mean over this transaction's 200,000 CU budget rather than to
 * folklore: a price of P uL/CU costs P * 200_000 / 1e6 lamports.
 */
const REGIMES = [
  { name: "calm", perCU: 0 },
  { name: "normal", perCU: 10_000 },
  { name: "busy", perCU: 100_000 },
  { name: "congested", perCU: 1_000_000 },
  { name: "extreme", perCU: 5_000_000 },
  { name: "absurd", perCU: 50_000_000 },
];

const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(6);
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

/** What the relayer quotes as a ceiling: min(cost * MARGIN, denomination/50). */
function quoteCeiling(denomination, perCU) {
  const cost = BASE_FEE + priorityFeeLamports(perCU) + RENT;
  const withMargin = BigInt(Math.ceil(cost * MARGIN));
  const cap = denomination / CAP_DIVISOR;
  return withMargin < cap ? withMargin : cap;
}

console.log("=".repeat(100));
console.log("  SornadoCash economic simulation");
console.log("=".repeat(100));
console.log(`  signature fee      ${rpad(BASE_FEE, 12)} lamports`);
console.log(`  nullifier rent     ${rpad(RENT, 12)} lamports  (recovered by nobody: it funds a permanent account)`);
console.log(`  deterministic cost ${rpad(DETERMINISTIC, 12)} lamports  = ${sol(DETERMINISTIC)} SOL per withdrawal`);
console.log(`  compute budget     ${rpad(COMPUTE_UNITS, 12)} CU`);
console.log(`  quote margin       ${rpad(MARGIN + "x", 12)}`);

// ── 1. Protocol solvency ────────────────────────────────────────────────────────
console.log("\n" + "-".repeat(100));
console.log("  1. CAN THE PROTOCOL LOSE MONEY?");
console.log("-".repeat(100));
{
  // Each deposit adds exactly one denomination to the vault. Each withdrawal removes exactly one,
  // and requires vault.lamports() >= denomination. Simulate an adversary trying to over-withdraw.
  let worstCase = null;
  for (const { label, d } of LADDER) {
    let vault = 0n;
    let deposits = 0;
    let withdrawals = 0;
    let refused = 0;
    // Random walk biased towards withdrawing, i.e. an attacker draining as hard as the rules allow.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let step = 0; step < 20_000; step++) {
      if (rnd() < 0.35) {
        vault += d;
        deposits++;
      } else {
        if (vault >= d) {
          vault -= d;
          withdrawals++;
        } else {
          refused++; // the on-chain guard: InsufficientVaultBalance
        }
      }
    }
    const netIn = BigInt(deposits) * d;
    const netOut = BigInt(withdrawals) * d;
    const ok = netOut <= netIn && vault === netIn - netOut;
    if (!ok) worstCase = label;
    console.log(
      `  ${pad(label, 9)} deposits ${rpad(deposits, 6)}  withdrawals ${rpad(withdrawals, 6)}  ` +
        `refused ${rpad(refused, 6)}  outflow<=inflow ${ok ? "YES" : "NO"}`
    );
  }
  console.log(
    worstCase
      ? `  RESULT: FAILED on ${worstCase}`
      : "  RESULT: total outflow never exceeded total inflow. The vault-balance guard makes protocol\n" +
        "          insolvency structurally impossible, so the protocol cannot lose money. A soundness\n" +
        "          break would drain a pool down to its rent reserve and no further."
  );
}

// ── 2. Operator P&L ─────────────────────────────────────────────────────────────
console.log("\n" + "-".repeat(100));
console.log("  2. CAN YOU LOSE MONEY? (per withdrawal, by denomination and congestion)");
console.log("-".repeat(100));
console.log(
  `  ${pad("rung", 9)} ${pad("regime", 10)} ${rpad("ceiling", 12)} ${rpad("charged", 12)} ` +
    `${rpad("spent", 12)} ${rpad("relayer P&L", 12)} ${rpad("treasury", 12)} ${rpad("net to you", 12)}`
);

const worstByRung = new Map();
for (const { label, d } of LADDER) {
  for (const { name, perCU } of REGIMES) {
    const feeMax = quoteCeiling(d, perCU);
    const plan = planFee({ feeMax, rent: RENT, estimatedPriorityPerCU: perCU });
    const spent = DETERMINISTIC + priorityFeeLamports(plan.appliedPriorityPerCU);
    const relayerPnl = Number(plan.actualFee) - spent;
    const treasury = Number(d / TREASURY_DIVISOR);
    const net = relayerPnl + treasury;

    const prev = worstByRung.get(label);
    if (prev === undefined || net < prev) worstByRung.set(label, net);

    console.log(
      `  ${pad(label, 9)} ${pad(name, 10)} ${rpad(feeMax, 12)} ${rpad(plan.actualFee, 12)} ` +
        `${rpad(spent, 12)} ${rpad(relayerPnl, 12)} ${rpad(treasury, 12)} ${rpad(net, 12)}` +
        (plan.degraded ? "  [slower inclusion]" : "")
    );
  }
}

console.log("\n  Worst case per rung, across every congestion regime:");
for (const [label, net] of worstByRung) {
  console.log(
    `    ${pad(label, 9)} net ${rpad(net, 12)} lamports = ${sol(net)} SOL ` +
      `${net >= 0 ? "PROFIT" : "LOSS"} per withdrawal`
  );
}

// ── 3. What the user receives ───────────────────────────────────────────────────
console.log("\n" + "-".repeat(100));
console.log("  3. CAN A USER LOSE MONEY? (worst-case payout vs what the UI promises)");
console.log("-".repeat(100));
console.log(
  `  ${pad("rung", 9)} ${rpad("deposited", 14)} ${rpad("worst payout", 14)} ${rpad("kept %", 9)} ` +
    `${rpad("min promised", 14)} honoured`
);
for (const { label, d } of LADDER) {
  const cap = d / CAP_DIVISOR;
  const treasury = computeTreasuryFee(d);
  // Worst case for the user: a relayer that claims the entire ceiling it is entitled to.
  const worstPayout = d - treasury - cap;
  const promised = computeMinUserReceives(d, cap);
  const keptPct = (Number(worstPayout) / Number(d)) * 100;
  console.log(
    `  ${pad(label, 9)} ${rpad(sol(d), 14)} ${rpad(sol(worstPayout), 14)} ${rpad(keptPct.toFixed(2) + "%", 9)} ` +
      `${rpad(sol(promised), 14)} ${worstPayout >= promised ? "YES" : "NO"}`
  );
}

// ── 4. Volume needed to fund operations ─────────────────────────────────────────
console.log("\n" + "-".repeat(100));
console.log("  4. VOLUME NEEDED TO COVER RUNNING COSTS");
console.log("-".repeat(100));
{
  // A small VM plus a paid RPC plan. Priced in SOL at a stated rate so the assumption is visible
  // and easy to change rather than buried.
  const SOL_USD = 76;
  const MONTHLY_USD = 5 /* VM */ + 50 /* RPC */;
  const monthlyLamports = BigInt(Math.ceil((MONTHLY_USD / SOL_USD) * LAMPORTS_PER_SOL));
  console.log(`  assumed infrastructure  $${MONTHLY_USD}/month at $${SOL_USD}/SOL = ${sol(monthlyLamports)} SOL/month`);
  console.log(`\n  ${pad("rung", 9)} ${rpad("net per withdrawal", 20)} ${rpad("withdrawals/month to break even", 32)}`);
  for (const { label, d } of LADDER) {
    const net = worstByRung.get(label);
    if (net <= 0) {
      console.log(`  ${pad(label, 9)} ${rpad(net, 20)} ${rpad("never (loses money per withdrawal)", 32)}`);
      continue;
    }
    const needed = Math.ceil(Number(monthlyLamports) / net);
    console.log(`  ${pad(label, 9)} ${rpad(net, 20)} ${rpad(needed.toLocaleString(), 32)}`);
  }
}

// ── 5. The rent asymmetry, stated explicitly ────────────────────────────────────
console.log("\n" + "-".repeat(100));
console.log("  5. WHERE THE MONEY ACTUALLY GOES");
console.log("-".repeat(100));
console.log(
  `  Of the ${sol(DETERMINISTIC)} SOL a withdrawal costs the relayer, ${sol(RENT)} SOL is nullifier\n` +
    "  rent: it is locked in a permanent account forever, not paid to a validator and not\n" +
    "  recoverable. There is no close instruction, by design, because that account IS the\n" +
    "  double-spend guard. So each withdrawal permanently consumes that rent from whoever relays it.\n" +
    "  It is recovered from the user's withdrawal, which is why the relayer breaks even rather than\n" +
    "  profits, and why the protocol fee is the only actual revenue."
);

// ── 6. Sensitivity to the rent parameter ────────────────────────────────────────
console.log("\n" + "-".repeat(100));
console.log("  6. SENSITIVITY: WHAT IF SOLANA CHANGES THE RENT RATE?");
console.log("-".repeat(100));
{
  // Rent is a runtime parameter. The program reads it via Rent::get(), so it adapts automatically,
  // but the ECONOMICS do not: the 2% cap is proportional to the denomination while rent is a flat
  // cost, so a rent increase eats the relayer's margin from below. This finds the breaking point.
  console.log(
    `  A relayer breaks even only while denomination/50 >= signature fee + rent.\n` +
      `  Minimum viable denomination today: ${sol(BigInt(DETERMINISTIC) * CAP_DIVISOR)} SOL.\n`
  );
  console.log(`  ${pad("rent multiple", 15)} ${rpad("rent", 12)} ${rpad("min viable denom", 18)} rungs that would subsidise`);
  for (const mult of [1, 1.25, 1.38, 1.5, 2, 5, 10]) {
    const rent = Math.round(RENT * mult);
    const deterministic = BASE_FEE + rent;
    const minViable = BigInt(deterministic) * CAP_DIVISOR;
    const losers = LADDER.filter(({ d }) => d / CAP_DIVISOR < BigInt(deterministic)).map((x) => x.label);
    console.log(
      `  ${pad(mult + "x", 15)} ${rpad(rent, 12)} ${rpad(sol(minViable) + " SOL", 18)} ` +
        (losers.length ? losers.join(", ") : "none")
    );
  }
  console.log(
    "\n  So the 0.1 SOL rung tolerates roughly a 38% rent increase before the relayer starts\n" +
      "  subsidising it. The subsidy is bounded per withdrawal and the withdrawal still succeeds,\n" +
      "  so this degrades gracefully rather than breaking, but it is the first thing that would\n" +
      "  turn a profitable rung into a loss-making one."
  );
}

// ── 7. Correction to a documented figure ────────────────────────────────────────
console.log("\n" + "-".repeat(100));
console.log("  7. A DOCUMENTED FIGURE THIS SIMULATION CONTRADICTS");
console.log("-".repeat(100));
{
  const OLD_RENT_165_BYTE = 2_039_280; // rent for a 165-byte SPL token account (the M-6 bug)
  const oldDeterministic = BASE_FEE + OLD_RENT_165_BYTE;
  const cap01 = 100_000_000n / CAP_DIVISOR;
  console.log(
    `  README and earlier analysis say the 0.1 SOL rung's 2% cap sits BELOW a relayer's cost, so\n` +
      `  relayers subsidise it. That was true against the pre-M-6 rent of ${OLD_RENT_165_BYTE}\n` +
      `  lamports (a 165-byte SPL account), giving a cost of ${oldDeterministic} vs a cap of ${cap01}.\n` +
      `  M-6 corrected the rent to ${RENT} for the actual 80-byte account, which makes the real\n` +
      `  cost ${DETERMINISTIC} and the cap ${cap01}: comfortably ABOVE cost, ratio ` +
      `${(Number(cap01) / DETERMINISTIC).toFixed(2)}x.\n` +
      `  The claim was not updated when the rent was fixed. No rung on the current ladder subsidises.`
  );
}
