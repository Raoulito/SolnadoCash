// relayer/src/api.js
// T25 — REST endpoints per PROJET_enhanced.md Section 12.6
// T28 — Rate limiting via express-rate-limit
//
// Endpoints:
//   POST /submit_proof — submit a ZK proof for on-chain withdrawal
//   GET  /fee_quote    — get current dynamic relayer fee
//   GET  /health       — relayer health check

import express from "express";
import rateLimit from "express-rate-limit";
import { PublicKey } from "@solana/web3.js";
import {
  computeRelayerFeeMax,
  computeTreasuryFee,
  computeMinUserReceives,
  getPriorityFeePerCU,
  priorityFeeLamports,
  BASE_FEE,
  NULLIFIER_RENT,
} from "./fees.js";
import { verifyProofOffChain } from "./verify.js";
import { submitWithdraw } from "./tx.js";
import { preflight } from "./preflight.js";

/**
 * Create the Express app with all routes.
 *
 * @param {object} deps - Injected dependencies
 * @param {Connection} deps.connection - Solana RPC connection
 * @param {Keypair} deps.relayerKeypair - Relayer signer
 * @param {PublicKey} deps.programId - SolnadoCash program ID
 * @returns {express.Express}
 */
/**
 * Strip base58 addresses and long hex blobs from a message so relayer logs do not
 * become a deposit/withdrawal correlation database (H-6).
 */
function redactIdentifiers(msg) {
  return String(msg)
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "[addr]")
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "[hex]");
}

export function createApp({ connection, relayerKeypair, programId }) {
  const app = express();

  // CORS — restrict to configured origins (H-6). Defaults to "*" for local
  // development; set ALLOWED_ORIGINS in production so an arbitrary site cannot
  // drive a visitor's browser into this relayer.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowedOrigins.includes("*")) {
    console.warn(
      "[relayer] ALLOWED_ORIGINS is unset — accepting requests from any origin. Set it in production."
    );
  }
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.includes("*")) {
      res.header("Access-Control-Allow-Origin", "*");
    } else if (origin && allowedOrigins.includes(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
    }
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: "64kb" }));

  // T28 — Rate limiting: 30 requests per minute per IP
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "TooManyRequests", retryAfter: 60 },
  });
  app.use(limiter);

  // Stricter limit for proof submission: 5 per minute per IP
  const submitLimiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "RelayerBusy", retryAfter: 60 },
  });

  // Track pending transactions to avoid double-submission
  const pendingNullifiers = new Set();

  // ── GET /health ──────────────────────────────────────────────────────────────
  app.get("/health", async (_req, res) => {
    try {
      const balance = await connection.getBalance(relayerKeypair.publicKey);
      res.json({
        status: "ok",
        balance: balance.toString(),
        pendingTxCount: pendingNullifiers.size,
      });
    } catch (err) {
      res.status(500).json({ status: "error", error: err.message });
    }
  });

  // ── GET /fee_quote ───────────────────────────────────────────────────────────
  app.get("/fee_quote", async (req, res) => {
    try {
      const poolAddr = req.query.pool;
      if (!poolAddr) {
        return res.status(400).json({ error: "MissingPoolAddress" });
      }

      // Validate pool address
      let poolPubkey;
      try {
        poolPubkey = new PublicKey(poolAddr);
      } catch {
        return res.status(400).json({ error: "InvalidPoolAddress" });
      }

      // Read pool denomination from on-chain account
      const poolInfo = await connection.getAccountInfo(poolPubkey);
      if (!poolInfo) {
        return res.status(404).json({ error: "PoolNotFound" });
      }

      // denomination at offset 8 (discriminator) + 64 = 72, 8 bytes LE
      const denomBytes = poolInfo.data.subarray(72, 80);
      const denomination = denomBytes.readBigUInt64LE();

      const relayerFeeMax = await computeRelayerFeeMax(connection);
      const treasuryFee = computeTreasuryFee(denomination);

      // Never quote a fee the pool cannot honour. The on-chain guard caps
      // relayer_fee_max at denomination/50; refuse to serve rather than hand the
      // user a ceiling that would make their proof unusable (H-3).
      const onChainCap = denomination / 50n;
      if (BigInt(relayerFeeMax) > onChainCap) {
        return res.status(503).json({
          error: "FeeAbovePoolCap",
          message:
            "Network fees currently exceed this pool's maximum relayer fee. Try again later or use a larger denomination.",
          relayerFeeMax: relayerFeeMax.toString(),
          cap: onChainCap.toString(),
        });
      }
      const estimatedUserReceives = computeMinUserReceives(
        denomination,
        BigInt(relayerFeeMax)
      );

      res.json({
        relayerAddress: relayerKeypair.publicKey.toBase58(),
        relayerFeeMax: relayerFeeMax.toString(),
        validUntil: Date.now() + 30_000, // 30s validity
        estimatedUserReceives: estimatedUserReceives.toString(),
        treasuryFee: treasuryFee.toString(),
        denomination: denomination.toString(),
      });
    } catch (err) {
      res.status(500).json({ error: "InternalError", message: err.message });
    }
  });

  // ── POST /submit_proof ───────────────────────────────────────────────────────
  app.post("/submit_proof", submitLimiter, async (req, res) => {
    try {
      const { proof, publicSignals, poolAddress, recipient, relayerFeeMax } =
        req.body;

      // Validate inputs
      if (!proof || !publicSignals || !poolAddress || !recipient) {
        return res.status(400).json({ error: "MissingFields" });
      }
      if (!Array.isArray(publicSignals) || publicSignals.length !== 3) {
        return res.status(400).json({ error: "InvalidPublicSignals" });
      }

      let poolPubkey, recipientPubkey;
      try {
        poolPubkey = new PublicKey(poolAddress);
        recipientPubkey = new PublicKey(recipient);
      } catch {
        return res.status(400).json({ error: "InvalidAddress" });
      }

      // Check nullifier not already pending
      const nullifierHex = publicSignals[0];
      if (pendingNullifiers.has(nullifierHex)) {
        return res
          .status(409)
          .json({ error: "NullifierPending" });
      }

      // T26 — Off-chain proof verification
      let valid;
      try {
        valid = await verifyProofOffChain(proof, publicSignals);
      } catch (verifyErr) {
        console.error("[submit_proof] Proof verification failed to parse:", verifyErr.message);
        return res.status(400).json({ error: "InvalidProof", message: "Malformed proof data" });
      }
      if (!valid) {
        return res.status(400).json({ error: "InvalidProof" });
      }

      // Read treasury from pool account
      const poolInfo = await connection.getAccountInfo(poolPubkey);
      if (!poolInfo) {
        return res.status(404).json({ error: "PoolNotFound" });
      }
      // treasury at offset 8 + 88 = 96, 32 bytes
      const treasuryBytes = poolInfo.data.subarray(96, 128);
      const treasuryAddress = new PublicKey(treasuryBytes);

      // Compute the fee to take. An honest relayer charges its REAL cost, not the
      // ceiling the user agreed to (H-3): relayerFeeMax exists to absorb fee
      // movement between quote and submission, not to be claimed in full.
      const feeMax = BigInt(relayerFeeMax || (await computeRelayerFeeMax(connection)));
      const priorityFeePerCU = await getPriorityFeePerCU(connection);
      const realCost = BigInt(
        BASE_FEE + priorityFeeLamports(priorityFeePerCU) + NULLIFIER_RENT
      );
      const actualFee = realCost < feeMax ? realCost : feeMax;

      // T29 — Check relayer balance before submitting
      const balance = await connection.getBalance(relayerKeypair.publicKey);
      if (balance < 5_000_000_000) {
        console.warn(
          `[ALERT] Relayer balance low: ${balance / 1e9} SOL (< 5 SOL threshold)`
        );
      }
      if (balance < 10_000_000) {
        // < 0.01 SOL — cannot cover nullifier rent
        return res
          .status(503)
          .json({ error: "RelayerBusy", retryAfter: 300 });
      }

      // M-4: reject submissions that cannot succeed on-chain BEFORE paying for a
      // transaction. A valid proof can still be doomed by a rotated root or a
      // commitment bound to a different relayer/fee/recipient.
      const pf = await preflight({
        poolData: poolInfo.data,
        publicSignals,
        relayerPubkey: relayerKeypair.publicKey,
        recipientPubkey,
        relayerFeeMax: feeMax,
      });
      if (!pf.ok) {
        return res.status(400).json({ error: pf.error, message: pf.message });
      }

      // Mark nullifier as pending
      pendingNullifiers.add(nullifierHex);

      try {
        const txSignature = await submitWithdraw({
          connection,
          relayerKeypair,
          programId,
          poolAddress: poolPubkey,
          recipientAddress: recipientPubkey,
          treasuryAddress,
          proof,
          publicSignals,
          relayerFeeMax: feeMax,
          relayerFeeTaken: actualFee,
          priorityFeePerCU,
        });

        res.json({
          txSignature,
          feeTaken: actualFee.toString(),
        });
      } finally {
        pendingNullifiers.delete(nullifierHex);
      }
    } catch (err) {
      const msg = err.message || "";
      const logs = err.logs || [];

      // H-6: the relayer already learns the recipient, the nullifier and the
      // request IP. Do not additionally persist them to logs unless an operator
      // explicitly opts in for debugging — program logs echo the nullifier hash.
      const verboseLogs = process.env.LOG_WITHDRAW_DETAILS === "1";
      console.error("[submit_proof] Error:", verboseLogs ? msg : redactIdentifiers(msg));
      if (logs.length && verboseLogs) {
        console.error("[submit_proof] Program logs:");
        logs.forEach((l) => console.error("  ", l));
      }

      // Map known on-chain program errors
      if (msg.includes("NullifierAlreadySpent") || msg.includes("0x1774")) {
        return res.status(400).json({ error: "NullifierSpent" });
      }
      if (msg.includes("RootNotFound") || msg.includes("0x1773")) {
        return res.status(400).json({ error: "StaleRoot" });
      }
      if (msg.includes("InvalidProof") || msg.includes("0x1775") || msg.includes("0x1776")) {
        return res.status(400).json({ error: "InvalidProof" });
      }
      if (msg.includes("InvalidWithdrawalCommitment") || msg.includes("0x1777")) {
        return res.status(400).json({ error: "InvalidWithdrawalCommitment" });
      }
      if (msg.includes("RelayerFeeExceedsMax") || msg.includes("0x1778")) {
        return res.status(400).json({ error: "RelayerFeeExceedsMax" });
      }
      if (msg.includes("FeeInvariantViolated") || msg.includes("0x1779")) {
        return res.status(400).json({ error: "FeeInvariantViolated" });
      }
      // NOTE: withdraw deliberately ignores is_paused (BF-31) — pausing blocks
      // deposits only, so a withdrawal can never fail with PoolPaused. Mapping it
      // here implied a guarantee nobody had tested (M-3); it is asserted on-chain
      // in tests/withdraw.ts instead.

      // Map Solana/network errors
      if (msg.includes("insufficient funds") || msg.includes("InsufficientFunds")) {
        return res.status(503).json({ error: "RelayerInsufficientFunds", message: "Relayer wallet has insufficient SOL" });
      }
      if (msg.includes("blockhash") || msg.includes("BlockhashNotFound")) {
        return res.status(503).json({ error: "BlockhashExpired", message: "Transaction expired, try again" });
      }
      if (msg.includes("AccountNotFound") || msg.includes("account does not exist")) {
        return res.status(400).json({ error: "AccountNotFound", message: "A required account was not found on-chain" });
      }
      if (msg.includes("Simulation failed") || msg.includes("Transaction simulation failed")) {
        // Extract the specific program error from logs
        const programError = logs.find((l) => l.includes("Error:") || l.includes("failed:"));
        return res.status(400).json({
          error: "SimulationFailed",
          message: programError || msg,
          // Returned to the caller (who already knows these values) but never
          // written to relayer logs unless LOG_WITHDRAW_DETAILS=1.
          logs: logs.slice(-5),
        });
      }

      // Fallback — include message so frontend can display useful info
      res.status(500).json({ error: "InternalError", message: msg });
    }
  });

  return app;
}
