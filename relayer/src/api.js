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
import { computeRelayerFeeMax, computeTreasuryFee, computeMinUserReceives } from "./fees.js";
import { verifyProofOffChain } from "./verify.js";
import { submitWithdraw } from "./tx.js";

/**
 * Create the Express app with all routes.
 *
 * @param {object} deps - Injected dependencies
 * @param {Connection} deps.connection - Solana RPC connection
 * @param {Keypair} deps.relayerKeypair - Relayer signer
 * @param {PublicKey} deps.programId - SolnadoCash program ID
 * @returns {express.Express}
 */
export function createApp({ connection, relayerKeypair, programId }) {
  const app = express();

  // CORS — allow frontend dev server
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
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
      const valid = await verifyProofOffChain(proof, publicSignals);
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

      // Compute actual fee to take
      const feeMax = BigInt(relayerFeeMax || (await computeRelayerFeeMax(connection)));
      const feeTaken = BigInt(await computeRelayerFeeMax(connection));
      // Take the lesser of our computed fee and the max the user agreed to
      const actualFee = feeTaken < feeMax ? feeTaken : feeMax;

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
        });

        res.json({
          txSignature,
          feeTaken: actualFee.toString(),
        });
      } finally {
        pendingNullifiers.delete(nullifierHex);
      }
    } catch (err) {
      // Map known on-chain errors to HTTP status codes
      const msg = err.message || "";
      if (msg.includes("NullifierAlreadySpent")) {
        return res.status(400).json({ error: "NullifierSpent" });
      }
      if (msg.includes("RootNotFound")) {
        return res.status(400).json({ error: "StaleRoot" });
      }
      if (msg.includes("InvalidProof")) {
        return res.status(400).json({ error: "InvalidProof" });
      }
      console.error("[submit_proof] Error:", err);
      res.status(500).json({ error: "InternalError", message: msg });
    }
  });

  return app;
}
