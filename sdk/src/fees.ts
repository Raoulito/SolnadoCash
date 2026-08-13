// sdk/src/fees.ts
// T34 — Fee utilities: getFeeQuote, computeTreasuryFee, computeMinUserReceives

import { PublicKey } from "@solana/web3.js";

export interface FeeQuote {
  relayerAddress: PublicKey;
  relayerFeeMax: bigint; // lamports — ceiling, not exact
  validUntil: number; // unix timestamp (ms), 30s window
  estimatedUserReceives: bigint; // denomination - treasuryFee - relayerFeeMax
}

/**
 * Canonical treasury fee: denomination / 500 (= 0.2%).
 * Integer division only — no overflow risk for any valid u64 (BF-22, BF-41).
 * Applied to raw denomination, never to (denomination - relayerFee).
 */
export function computeTreasuryFee(denomination: bigint): bigint {
  if (denomination < 500n) {
    throw new Error("Denomination must be >= 500 (BF-14)");
  }
  return denomination / 500n;
}

/**
 * Minimum amount the user receives after all fees.
 * Formula: denomination - treasuryFee - relayerFeeMax
 */
export function computeMinUserReceives(
  denomination: bigint,
  quote: FeeQuote
): bigint {
  const treasuryFee = computeTreasuryFee(denomination);
  return denomination - treasuryFee - quote.relayerFeeMax;
}

/**
 * Relayer fees are capped on-chain at denomination / 50 (2%). Mirror that here so
 * the client rejects an unusable quote before spending ~30s generating a proof.
 */
export const MAX_RELAYER_FEE_DIVISOR = 50n;

export interface FeeBreakdown {
  denomination: bigint;
  treasuryFee: bigint;
  relayerFeeMax: bigint;
  /** Guaranteed floor: what the user receives if the relayer claims its full ceiling. */
  userReceivesMin: bigint;
  /** relayerFeeMax as a percentage of the denomination. */
  relayerFeePct: number;
}

export interface ValidateQuoteOptions {
  /** Hard ceiling in lamports. Defaults to the on-chain cap (denomination / 50). */
  maxRelayerFee?: bigint;
  /** Clock skew allowance in ms when checking expiry. */
  nowMs?: number;
}

/**
 * Validate a relayer fee quote and derive the amounts to show the user (H-4).
 *
 * Every figure returned here is computed LOCALLY from the denomination. The
 * relayer's own `estimatedUserReceives` is treated as untrusted and only
 * cross-checked — a relayer that reports a figure inconsistent with its own
 * `relayerFeeMax` is rejected outright.
 *
 * Callers must show `userReceivesMin` and `relayerFeeMax` to the user BEFORE the
 * proof is generated, because the ceiling is bound into the proof and the relayer
 * is then free to claim all of it.
 *
 * @throws if the quote is expired, above the cap, or internally inconsistent.
 */
export function validateFeeQuote(
  denomination: bigint,
  quote: FeeQuote,
  opts: ValidateQuoteOptions = {}
): FeeBreakdown {
  const now = opts.nowMs ?? Date.now();
  if (quote.validUntil <= now) {
    throw new Error(
      "Fee quote has expired — request a fresh quote before generating a proof"
    );
  }

  if (quote.relayerFeeMax < 0n) {
    throw new Error("Relayer fee quote is negative");
  }

  const treasuryFee = computeTreasuryFee(denomination);
  const cap = opts.maxRelayerFee ?? denomination / MAX_RELAYER_FEE_DIVISOR;

  if (quote.relayerFeeMax > cap) {
    throw new Error(
      `Relayer fee ${quote.relayerFeeMax} lamports exceeds the maximum ${cap} ` +
        `(${(100 / Number(MAX_RELAYER_FEE_DIVISOR)).toFixed(0)}% of the denomination). ` +
        `This quote would be rejected on-chain — try another relayer.`
    );
  }

  const userReceivesMin = denomination - treasuryFee - quote.relayerFeeMax;
  if (userReceivesMin <= 0n) {
    throw new Error("Fees would consume the entire withdrawal");
  }

  // Cross-check the relayer's own claim against our local computation. A mismatch
  // means the relayer is misreporting what the user will receive.
  if (
    quote.estimatedUserReceives !== undefined &&
    quote.estimatedUserReceives !== userReceivesMin
  ) {
    throw new Error(
      `Relayer quote is inconsistent: it claims the user receives ` +
        `${quote.estimatedUserReceives} but its own fee ceiling implies ` +
        `${userReceivesMin}. Do not use this relayer.`
    );
  }

  return {
    denomination,
    treasuryFee,
    relayerFeeMax: quote.relayerFeeMax,
    userReceivesMin,
    relayerFeePct: (Number(quote.relayerFeeMax) / Number(denomination)) * 100,
  };
}

/**
 * Fetch a fee quote from a relayer.
 * Calls GET <relayerUrl>/fee_quote?pool=<poolAddress> and parses the response
 * into a typed FeeQuote.
 *
 * Throws if the relayer returns an error or the quote has expired.
 */
export async function getFeeQuote(
  relayerUrl: string,
  poolAddress: PublicKey
): Promise<FeeQuote> {
  const url = `${relayerUrl.replace(/\/+$/, "")}/fee_quote?pool=${poolAddress.toBase58()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `Relayer fee_quote failed (${res.status}): ${(body as any).error || res.statusText}`
    );
  }

  const data = (await res.json()) as Record<string, string>;

  const quote: FeeQuote = {
    relayerAddress: new PublicKey(data.relayerAddress),
    relayerFeeMax: BigInt(data.relayerFeeMax),
    validUntil: Number(data.validUntil),
    estimatedUserReceives: BigInt(data.estimatedUserReceives),
  };

  // Reject expired quotes immediately
  if (quote.validUntil <= Date.now()) {
    throw new Error("Fee quote already expired");
  }

  return quote;
}
