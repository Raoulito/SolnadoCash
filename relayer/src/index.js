// relayer/src/index.js
// SolnadoCash Relayer — main entry point
//
// Usage:
//   RELAYER_KEYPAIR=/path/to/dedicated-hot-wallet.json \   (required; never the upgrade authority)
//   SOLANA_RPC_URL=https://api.devnet.solana.com \
//   PROGRAM_ID=DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59 \
//   node src/index.js

import { Connection, PublicKey } from "@solana/web3.js";
import { createApp } from "./api.js";
import { startHealthMonitor, thresholdsFromEnv } from "./health.js";
import { assertNotUpgradeAuthority, loadRelayerKeypair, RelayerKeyError } from "./startup.js";

// ── Config from environment ──────────────────────────────────────────────────

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID_STR =
  process.env.PROGRAM_ID || "DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59";
const PORT = parseInt(process.env.PORT || "3000", 10);
// Bind address. Unset keeps the old behaviour (every interface). Behind a reverse proxy set it to
// 127.0.0.1, so the port cannot be reached around the proxy.
const HOST = process.env.HOST || undefined;

/**
 * The RPC URL with everything after the origin removed. Hosted RPC URLs carry the API key in the
 * query (Helius: ?api-key=) or the path, and under systemd whatever is printed here is kept in the
 * journal, so only the origin is ever logged.
 */
function rpcOriginForLog(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "(unparseable SOLANA_RPC_URL)";
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

const connection = new Connection(RPC_URL, "confirmed");
const programId = new PublicKey(PROGRAM_ID_STR);

// L-3: the key must be named explicitly (no ~/.config/solana/id.json fallback), and must not be the
// key that can replace the program. Checked before anything is served or signed.
let relayerKeypair;
try {
  relayerKeypair = loadRelayerKeypair();
  await assertNotUpgradeAuthority(connection, programId, relayerKeypair.publicKey);
} catch (e) {
  console.error(
    e instanceof RelayerKeyError
      ? `[relayer] refusing to start: ${e.message}`
      : `[relayer] refusing to start: could not check the signing key against the program (${e.message})`
  );
  process.exit(1);
}

console.log("SolnadoCash Relayer starting...");
console.log("  RPC:", rpcOriginForLog(RPC_URL));
console.log("  Program:", programId.toBase58());
console.log("  Relayer:", relayerKeypair.publicKey.toBase58());

// T29 — Start health monitoring (checks balance every 60s)
let thresholds;
try {
  thresholds = thresholdsFromEnv();
} catch (e) {
  console.error(`[relayer] refusing to start: ${e.message}`);
  process.exit(1);
}
const monitor = startHealthMonitor(connection, relayerKeypair.publicKey, thresholds);

// Create and start Express app
const app = createApp({ connection, relayerKeypair, programId });

const server = app.listen(PORT, HOST, () => {
  const { address, port } = server.address();
  console.log(HOST ? `  Listening on ${address}:${port}` : `  Listening on port ${port}`);
  console.log("  Endpoints:");
  console.log("    GET  /health");
  console.log("    GET  /fee_quote?pool=<address>");
  console.log("    POST /submit_proof");
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  monitor.stop();
  server.close(() => process.exit(0));
});
