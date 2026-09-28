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
import { startHealthMonitor } from "./health.js";
import { assertNotUpgradeAuthority, loadRelayerKeypair, RelayerKeyError } from "./startup.js";

// ── Config from environment ──────────────────────────────────────────────────

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID_STR =
  process.env.PROGRAM_ID || "DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59";
const PORT = parseInt(process.env.PORT || "3000", 10);

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
console.log("  RPC:", RPC_URL);
console.log("  Program:", programId.toBase58());
console.log("  Relayer:", relayerKeypair.publicKey.toBase58());

// T29 — Start health monitoring (checks balance every 60s)
const monitor = startHealthMonitor(connection, relayerKeypair.publicKey);

// Create and start Express app
const app = createApp({ connection, relayerKeypair, programId });

const server = app.listen(PORT, () => {
  console.log(`  Listening on port ${PORT}`);
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
