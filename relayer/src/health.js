// relayer/src/health.js
// T29 — Relayer health monitoring + balance alert
//
// Periodically checks relayer wallet balance and logs warnings.
// Alert threshold: 5 SOL (configurable).

const DEFAULT_INTERVAL_MS = 60_000; // Check every 60 seconds
const ALERT_THRESHOLD_LAMPORTS = 5_000_000_000; // 5 SOL
const CRITICAL_THRESHOLD_LAMPORTS = 1_000_000_000; // 1 SOL

/**
 * Start periodic health monitoring for the relayer wallet.
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @param {import("@solana/web3.js").PublicKey} relayerPubkey
 * @param {object} [options]
 * @param {number} [options.intervalMs] - Check interval in milliseconds
 * @param {number} [options.alertThreshold] - Alert threshold in lamports
 * @param {function} [options.onAlert] - Custom alert callback
 * @returns {{ stop: () => void }} Handle to stop monitoring
 */
export function startHealthMonitor(connection, relayerPubkey, options = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const alertThreshold = options.alertThreshold ?? ALERT_THRESHOLD_LAMPORTS;
  const onAlert = options.onAlert ?? defaultAlert;

  const timer = setInterval(async () => {
    try {
      const balance = await connection.getBalance(relayerPubkey);
      const solBalance = balance / 1e9;

      if (balance < CRITICAL_THRESHOLD_LAMPORTS) {
        onAlert("critical", solBalance, relayerPubkey.toBase58());
      } else if (balance < alertThreshold) {
        onAlert("warning", solBalance, relayerPubkey.toBase58());
      }
    } catch (err) {
      console.error("[health] Failed to check balance:", err.message);
    }
  }, intervalMs);

  // Don't prevent process exit
  timer.unref();

  return {
    stop: () => clearInterval(timer),
  };
}

function defaultAlert(level, solBalance, address) {
  const timestamp = new Date().toISOString();
  if (level === "critical") {
    console.error(
      `[${timestamp}] CRITICAL: Relayer ${address} balance is ${solBalance.toFixed(4)} SOL — below 1 SOL! Withdrawals will fail.`
    );
  } else {
    console.warn(
      `[${timestamp}] WARNING: Relayer ${address} balance is ${solBalance.toFixed(4)} SOL — below 5 SOL threshold. Top up soon.`
    );
  }
}

export { ALERT_THRESHOLD_LAMPORTS, CRITICAL_THRESHOLD_LAMPORTS };
