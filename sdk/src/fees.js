"use strict";
// sdk/src/fees.ts
// T34 — Fee utilities: getFeeQuote, computeTreasuryFee, computeMinUserReceives
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeTreasuryFee = computeTreasuryFee;
exports.computeMinUserReceives = computeMinUserReceives;
exports.getFeeQuote = getFeeQuote;
const web3_js_1 = require("@solana/web3.js");
/**
 * Canonical treasury fee: denomination / 500 (= 0.2%).
 * Integer division only — no overflow risk for any valid u64 (BF-22, BF-41).
 * Applied to raw denomination, never to (denomination - relayerFee).
 */
function computeTreasuryFee(denomination) {
    if (denomination < 500n) {
        throw new Error("Denomination must be >= 500 (BF-14)");
    }
    return denomination / 500n;
}
/**
 * Minimum amount the user receives after all fees.
 * Formula: denomination - treasuryFee - relayerFeeMax
 */
function computeMinUserReceives(denomination, quote) {
    const treasuryFee = computeTreasuryFee(denomination);
    return denomination - treasuryFee - quote.relayerFeeMax;
}
/**
 * Fetch a fee quote from a relayer.
 * Calls GET <relayerUrl>/fee_quote?pool=<poolAddress> and parses the response
 * into a typed FeeQuote.
 *
 * Throws if the relayer returns an error or the quote has expired.
 */
async function getFeeQuote(relayerUrl, poolAddress) {
    const url = `${relayerUrl.replace(/\/+$/, "")}/fee_quote?pool=${poolAddress.toBase58()}`;
    const res = await fetch(url);
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`Relayer fee_quote failed (${res.status}): ${body.error || res.statusText}`);
    }
    const data = await res.json();
    const quote = {
        relayerAddress: new web3_js_1.PublicKey(data.relayerAddress),
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
