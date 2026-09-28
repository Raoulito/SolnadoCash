// relayer/test/healththreshold.test.js
//
// The balance alerts were fixed at 5 SOL (warning) and 1 SOL (critical, "Withdrawals will fail").
// A withdrawal fronts one nullifier rent, about 0.00106 SOL, which it gets back in the fee, so a hot
// wallet holding 0.15 SOL covers well over a hundred withdrawals in flight. Kept deliberately small,
// as a hot wallet should be, it logged a false CRITICAL every minute. The thresholds are now
// configurable (RELAYER_ALERT_SOL, RELAYER_CRITICAL_SOL) and the messages state the real threshold.

import { strict as assert } from "node:assert";
import { Keypair } from "@solana/web3.js";
import { startHealthMonitor, thresholdsFromEnv } from "../src/health.js";

const pubkey = Keypair.generate().publicKey;
const SOL = 1_000_000_000;

/** Run one monitor tick against a fixed balance and collect the alerts it raises. */
async function alertsAt(balance, options) {
  const seen = [];
  const m = startHealthMonitor({ getBalance: async () => balance }, pubkey, {
    ...options,
    intervalMs: 5,
    onAlert: (level, sol) => seen.push([level, sol]),
  });
  await new Promise((r) => setTimeout(r, 40));
  m.stop();
  return seen;
}

describe("relayer balance alerts", () => {
  it("honours a configured critical threshold", async () => {
    const t = thresholdsFromEnv({ RELAYER_ALERT_SOL: "0.05", RELAYER_CRITICAL_SOL: "0.01" });
    assert.deepEqual(t, { alertThreshold: 0.05 * SOL, criticalThreshold: 0.01 * SOL });
    assert.deepEqual(await alertsAt(0.15 * SOL, t), []);
    assert.equal((await alertsAt(0.03 * SOL, t))[0]?.[0], "warning");
    assert.equal((await alertsAt(0.005 * SOL, t))[0]?.[0], "critical");
  });

  it("keeps the previous defaults when nothing is configured", () => {
    assert.deepEqual(thresholdsFromEnv({}), { alertThreshold: 5 * SOL, criticalThreshold: 1 * SOL });
  });

  it("refuses values that are not a positive number of SOL, or a critical above the warning", () => {
    for (const bad of [{ RELAYER_ALERT_SOL: "abc" }, { RELAYER_CRITICAL_SOL: "-1" }, { RELAYER_ALERT_SOL: "0.01", RELAYER_CRITICAL_SOL: "0.05" }]) {
      assert.throws(() => thresholdsFromEnv(bad), /RELAYER_(ALERT|CRITICAL)_SOL/, JSON.stringify(bad));
    }
  });

  it("states the configured threshold in the message, not a fixed 1 SOL", async () => {
    const lines = [];
    const orig = console.error;
    console.error = (...a) => lines.push(a.join(" "));
    try {
      const m = startHealthMonitor({ getBalance: async () => 0.005 * SOL }, pubkey, {
        ...thresholdsFromEnv({ RELAYER_ALERT_SOL: "0.05", RELAYER_CRITICAL_SOL: "0.01" }),
        intervalMs: 5,
      });
      await new Promise((r) => setTimeout(r, 40));
      m.stop();
    } finally {
      console.error = orig;
    }
    assert.ok(lines.length > 0, "a critical alert was expected");
    assert.match(lines[0], /below 0\.01 SOL/);
    assert.doesNotMatch(lines[0], /below 1 SOL/);
  });
});
