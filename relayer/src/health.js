// relayer/src/health.js
// T29 — Relayer health monitoring + balance alert
//
// Periodically checks relayer wallet balance and logs warnings.
// Thresholds default to 5 SOL (warning) and 1 SOL (critical). Set RELAYER_ALERT_SOL and
// RELAYER_CRITICAL_SOL for a small hot wallet: a withdrawal fronts one nullifier rent (about
// 0.00106 SOL) and recovers it from the fee, so 0.15 SOL covers well over a hundred in flight, and
// the fixed defaults logged a false CRITICAL every minute.

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
  const criticalThreshold = options.criticalThreshold ?? CRITICAL_THRESHOLD_LAMPORTS;
  const onAlert =
    options.onAlert ??
    ((level, sol, address) => defaultAlert(level, sol, address, { alertThreshold, criticalThreshold }));

  const timer = setInterval(async () => {
    try {
      const balance = await connection.getBalance(relayerPubkey);
      const solBalance = balance / 1e9;

      if (balance < criticalThreshold) {
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

/**
 * Thresholds from RELAYER_ALERT_SOL / RELAYER_CRITICAL_SOL, in lamports. Unset keeps the defaults.
 * Throws on a value that is not a positive number, or a critical threshold above the warning one,
 * so a typo stops startup instead of silencing the alerts.
 */
export function thresholdsFromEnv(env = process.env) {
  const read = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const sol = Number(raw);
    if (!Number.isFinite(sol) || sol <= 0) throw new Error(`${name} must be a positive number of SOL, got "${raw}"`);
    return Math.round(sol * 1e9);
  };
  const alertThreshold = read("RELAYER_ALERT_SOL", ALERT_THRESHOLD_LAMPORTS);
  const criticalThreshold = read("RELAYER_CRITICAL_SOL", CRITICAL_THRESHOLD_LAMPORTS);
  if (criticalThreshold > alertThreshold) {
    throw new Error("RELAYER_CRITICAL_SOL must not be above RELAYER_ALERT_SOL");
  }
  return { alertThreshold, criticalThreshold };
}

function defaultAlert(level, solBalance, address, { alertThreshold, criticalThreshold }) {
  const timestamp = new Date().toISOString();
  if (level === "critical") {
    console.error(
      `[${timestamp}] CRITICAL: Relayer ${address} balance is ${solBalance.toFixed(4)} SOL — below ${criticalThreshold / 1e9} SOL. Withdrawals may fail.`
    );
  } else {
    console.warn(
      `[${timestamp}] WARNING: Relayer ${address} balance is ${solBalance.toFixed(4)} SOL — below ${alertThreshold / 1e9} SOL. Top up soon.`
    );
  }
}

export { ALERT_THRESHOLD_LAMPORTS, CRITICAL_THRESHOLD_LAMPORTS };
