// monitor/src/checks.js
//
// Pure check logic — no network, no I/O — so every rule can be unit-tested against
// synthetic states rather than only against whatever devnet happens to look like.
//
// Severity contract:
//   CRITICAL  an invariant that cannot break under correct operation. Alert immediately.
//   WARNING   needs attention but has innocent explanations.
//   INFO      state changes worth recording, not worth waking anyone.

export const CRITICAL = "CRITICAL";
export const WARNING = "WARNING";
export const INFO = "INFO";

/**
 * The core integrity invariant.
 *
 *   vault == rent + (deposits - withdrawals) * denomination
 *
 * Rearranged, (rent + deposits*denom - vault) must be EXACTLY divisible by the
 * denomination, and the implied withdrawal count must lie in [0, deposits].
 *
 * Why this detects a forged-proof drain: withdrawals never increment next_index (only
 * deposits do), so an attacker minting withdrawals without deposits drives the implied
 * count above `deposits`, and skimming any other amount breaks divisibility.
 *
 * Known innocent cause of a positive remainder: anyone can send lamports to a vault with
 * a plain transfer. So a violation means investigate, not "definitely exploited" — the
 * message says so rather than crying wolf.
 */
export function checkVaultIntegrity(p) {
  const { label, denomination, deposits, vaultLamports, vaultRent } = p;
  const out = [];

  if (denomination <= 0n) {
    out.push({ severity: CRITICAL, code: "BAD_DENOMINATION", pool: label,
      message: `denomination is ${denomination}` });
    return out;
  }

  if (vaultLamports < vaultRent) {
    out.push({ severity: CRITICAL, code: "VAULT_BELOW_RENT", pool: label,
      message: `vault ${vaultLamports} is below its rent reserve ${vaultRent} — lamports ` +
               `left the vault outside the withdrawal path` });
    return out;
  }

  const numerator = vaultRent + deposits * denomination - vaultLamports;

  if (numerator < 0n) {
    out.push({ severity: WARNING, code: "VAULT_SURPLUS", pool: label,
      message: `vault holds ${-numerator} lamports more than ${deposits} deposits can ` +
               `account for. Most likely a plain transfer into the vault; harmless, but it ` +
               `makes the integrity check noisy until deposits catch up` });
    return out;
  }

  if (numerator % denomination !== 0n) {
    out.push({ severity: CRITICAL, code: "INTEGRITY_REMAINDER", pool: label,
      message: `vault balance is not a whole number of denominations from expected: ` +
               `remainder ${numerator % denomination} lamports. Either someone transferred ` +
               `lamports into the vault, or funds moved outside the withdrawal path. ` +
               `INVESTIGATE.` });
    return out;
  }

  const impliedWithdrawals = numerator / denomination;
  if (impliedWithdrawals > deposits) {
    out.push({ severity: CRITICAL, code: "WITHDRAWALS_EXCEED_DEPOSITS", pool: label,
      message: `implied withdrawals ${impliedWithdrawals} EXCEEDS deposits ${deposits}. ` +
               `This is the signature of proofs being accepted without matching deposits. ` +
               `Pause deposits and investigate immediately.` });
  }

  return out;
}

/**
 * Authority and immutable-field drift.
 *
 * The upgrade authority can replace the program and drain every vault, so a change to it
 * is the loudest possible signal — either you did it, or someone else holds it. A pool's
 * admin/treasury/denomination are immutable by construction, so any change means the
 * account was written by something other than this program.
 */
export function checkAuthorities(p) {
  const { expectedUpgradeAuthority, actualUpgradeAuthority, pools } = p;
  const out = [];

  if (expectedUpgradeAuthority !== undefined) {
    if (actualUpgradeAuthority === null) {
      out.push({ severity: INFO, code: "PROGRAM_IMMUTABLE",
        message: "upgrade authority is now NONE — the program is immutable. Expected if " +
                 "you just ran `set-upgrade-authority --final`." });
    } else if (actualUpgradeAuthority !== expectedUpgradeAuthority) {
      out.push({ severity: CRITICAL, code: "UPGRADE_AUTHORITY_CHANGED",
        message: `upgrade authority is ${actualUpgradeAuthority}, expected ` +
                 `${expectedUpgradeAuthority}. If you did not do this, the key is ` +
                 `compromised and every vault can be drained by redeploying the program.` });
    }
  }

  for (const pool of pools ?? []) {
    for (const field of ["admin", "treasury", "denomination"]) {
      if (
        pool.baseline?.[field] !== undefined &&
        pool.current?.[field] !== undefined &&
        String(pool.baseline[field]) !== String(pool.current[field])
      ) {
        out.push({ severity: CRITICAL, code: "IMMUTABLE_FIELD_CHANGED", pool: pool.label,
          message: `${field} changed from ${pool.baseline[field]} to ${pool.current[field]}. ` +
                   `This field cannot change under correct operation.` });
      }
    }
  }
  return out;
}

/**
 * Outflow rate. Total outflow is already capped at total deposits by the vault-balance
 * guard, so this is early warning rather than a race to win — the threshold is loose on
 * purpose.
 */
export function checkOutflowRate(p) {
  const { label, denomination, vaultLamports, previous, maxDenomsPerWindow = 5n } = p;
  if (!previous || previous.vaultLamports === undefined) return [];
  const drop = BigInt(previous.vaultLamports) - vaultLamports;
  if (drop <= 0n) return [];
  const denoms = drop / denomination;
  if (denoms >= maxDenomsPerWindow) {
    return [{ severity: WARNING, code: "FAST_OUTFLOW", pool: label,
      message: `${denoms} withdrawals since the last check (threshold ` +
               `${maxDenomsPerWindow}). Normal under load; worth a look if unexpected.` }];
  }
  return [];
}

/** Saturation: pools hard-reject deposits at 950,000 leaves. */
export function checkSaturation(p) {
  const { label, deposits, threshold = 950_000n } = p;
  const out = [];
  if (deposits >= threshold) {
    out.push({ severity: WARNING, code: "POOL_SATURATED", pool: label,
      message: `pool is saturated at ${deposits} deposits and rejects new deposits. ` +
               `Deploy a new version.` });
  } else if (deposits >= threshold - 1000n) {
    out.push({ severity: WARNING, code: "POOL_NEAR_SATURATION", pool: label,
      message: `pool is near saturation (${deposits}/${threshold}). Prepare a new version.` });
  }
  return out;
}

/** Relayer solvency: below the nullifier rent it cannot submit withdrawals at all. */
export function checkRelayerBalance(p) {
  const { balance, criticalLamports = 10_000_000n, warnLamports = 100_000_000n } = p;
  if (balance === undefined || balance === null) return [];
  if (balance < criticalLamports) {
    return [{ severity: CRITICAL, code: "RELAYER_INSOLVENT",
      message: `relayer balance ${balance} lamports is below the floor — it cannot pay ` +
               `nullifier rent, so NO withdrawals can be relayed. Users are pushed into ` +
               `self-relaying, which destroys their privacy.` }];
  }
  if (balance < warnLamports) {
    return [{ severity: WARNING, code: "RELAYER_LOW",
      message: `relayer balance ${balance} lamports is low — top up.` }];
  }
  return [];
}

/** Pause transitions, so the incident timeline is reconstructable. */
export function checkPauseState(p) {
  const { label, isPaused, previous } = p;
  if (!previous || previous.isPaused === undefined || previous.isPaused === isPaused) {
    return [];
  }
  return [{ severity: INFO, code: isPaused ? "POOL_PAUSED" : "POOL_UNPAUSED", pool: label,
    message: `deposits are now ${isPaused ? "PAUSED" : "OPEN"}. Withdrawals are unaffected ` +
             `either way — they are never pausable by design.` }];
}

/** Run every per-pool rule. */
export function runPoolChecks(pool, previous) {
  return [
    ...checkVaultIntegrity(pool),
    ...checkOutflowRate({ ...pool, previous }),
    ...checkSaturation(pool),
    ...checkPauseState({ ...pool, previous }),
  ];
}
