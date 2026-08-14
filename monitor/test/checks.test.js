// monitor/test/checks.test.js
//
// The checks must fire on the states that matter and stay silent otherwise. A monitor that
// cries wolf gets muted, and a monitor that misses the one state it exists for is worse
// than none — so both directions are tested.

import { strict as assert } from "node:assert";
import {
  checkVaultIntegrity, checkAuthorities, checkOutflowRate, checkSaturation,
  checkRelayerBalance, checkPauseState, CRITICAL, WARNING, INFO,
} from "../src/checks.js";

const DENOM = 1_000_000_000n;
const RENT = 946_560n;

function healthy(deposits, withdrawals) {
  return {
    label: "1 SOL",
    denomination: DENOM,
    deposits,
    vaultRent: RENT,
    vaultLamports: RENT + (deposits - withdrawals) * DENOM,
  };
}

describe("vault integrity", () => {
  it("is silent on a consistent vault", () => {
    for (const [d, w] of [[0n, 0n], [1n, 0n], [10n, 4n], [118n, 46n], [50n, 50n]]) {
      assert.deepEqual(checkVaultIntegrity(healthy(d, w)), [], `deposits=${d} withdrawals=${w}`);
    }
  });

  it("fires CRITICAL when more has left than deposits could fund (forged-proof signature)", () => {
    // The reachable form of "withdrawals exceed deposits": draining beyond what deposits
    // funded necessarily takes the vault below its rent reserve.
    const f = checkVaultIntegrity({
      label: "1 SOL", denomination: DENOM, deposits: 2n,
      vaultRent: RENT, vaultLamports: RENT - DENOM,
    });
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, CRITICAL);
    assert.equal(f[0].code, "WITHDRAWALS_EXCEED_DEPOSITS");
    assert.match(f[0].message, /signature of proofs being accepted/);
    assert.match(f[0].message, /BELOW its rent reserve/);
  });

  it("still fires when the vault is short by a single lamport", () => {
    const f = checkVaultIntegrity({
      label: "1 SOL", denomination: DENOM, deposits: 3n,
      vaultRent: RENT, vaultLamports: RENT - 1n,
    });
    assert.equal(f[0].code, "WITHDRAWALS_EXCEED_DEPOSITS");
    assert.equal(f[0].severity, CRITICAL);
  });

  it("fires CRITICAL on a non-whole-denomination discrepancy", () => {
    const s = healthy(10n, 3n);
    s.vaultLamports += 12_345n; // skim/donation of a partial amount
    const f = checkVaultIntegrity(s);
    assert.equal(f.length, 1);
    assert.equal(f[0].code, "INTEGRITY_REMAINDER");
    assert.equal(f[0].severity, CRITICAL);
    assert.match(f[0].message, /INVESTIGATE/);
  });

  it("treats a whole-denomination surplus as a WARNING, not a breach", () => {
    // Someone transferred a round amount in. Harmless, but must not read as a drain.
    const s = healthy(2n, 0n);
    s.vaultLamports += DENOM * 3n;
    const f = checkVaultIntegrity(s);
    assert.equal(f.length, 1);
    assert.equal(f[0].code, "VAULT_SURPLUS");
    assert.equal(f[0].severity, WARNING);
  });

  it("treats a below-rent vault as the same finding, not a separate one", () => {
    const s = healthy(3n, 3n);
    s.vaultLamports = RENT - 1n;
    const f = checkVaultIntegrity(s);
    assert.equal(f[0].code, "WITHDRAWALS_EXCEED_DEPOSITS");
    assert.equal(f[0].severity, CRITICAL);
  });

  it("rejects a zero denomination rather than dividing by it", () => {
    const f = checkVaultIntegrity({ label: "x", denomination: 0n, deposits: 0n,
      vaultLamports: 0n, vaultRent: 0n });
    assert.equal(f[0].code, "BAD_DENOMINATION");
  });
});

describe("authorities", () => {
  const A = "4PLXgVX9MumeLLjcyvYFNoKq1dECdEneiFA8StLCnf1c";
  const B = "9eQQp4q3cxwnhd5LJ6ENxS65uyDSFME7DQzU282DQBpF";

  it("is silent when the authority matches", () => {
    assert.deepEqual(
      checkAuthorities({ expectedUpgradeAuthority: A, actualUpgradeAuthority: A, pools: [] }),
      []
    );
  });

  it("fires CRITICAL when the upgrade authority changed (key takeover)", () => {
    const f = checkAuthorities({ expectedUpgradeAuthority: A, actualUpgradeAuthority: B, pools: [] });
    assert.equal(f[0].code, "UPGRADE_AUTHORITY_CHANGED");
    assert.equal(f[0].severity, CRITICAL);
    assert.match(f[0].message, /compromised/);
  });

  it("reports immutability as INFO, not as an alarm", () => {
    const f = checkAuthorities({ expectedUpgradeAuthority: A, actualUpgradeAuthority: null, pools: [] });
    assert.equal(f[0].code, "PROGRAM_IMMUTABLE");
    assert.equal(f[0].severity, INFO);
  });

  it("fires CRITICAL when an immutable pool field drifts", () => {
    const f = checkAuthorities({
      pools: [{ label: "1 SOL",
        baseline: { admin: A, treasury: A, denomination: "1000000000" },
        current: { admin: A, treasury: B, denomination: "1000000000" } }],
    });
    assert.equal(f[0].code, "IMMUTABLE_FIELD_CHANGED");
    assert.equal(f[0].severity, CRITICAL);
    assert.match(f[0].message, /treasury changed/);
  });

  it("says nothing when no expectation is configured", () => {
    assert.deepEqual(checkAuthorities({ actualUpgradeAuthority: B, pools: [] }), []);
  });
});

describe("outflow rate", () => {
  it("is silent on the first observation", () => {
    assert.deepEqual(
      checkOutflowRate({ label: "1 SOL", denomination: DENOM, vaultLamports: RENT }),
      []
    );
  });

  it("is silent on deposits (vault growing)", () => {
    assert.deepEqual(
      checkOutflowRate({ label: "1 SOL", denomination: DENOM,
        vaultLamports: RENT + 5n * DENOM, previous: { vaultLamports: RENT } }),
      []
    );
  });

  it("warns on a burst of withdrawals", () => {
    const f = checkOutflowRate({ label: "1 SOL", denomination: DENOM,
      vaultLamports: RENT, previous: { vaultLamports: RENT + 9n * DENOM } });
    assert.equal(f[0].code, "FAST_OUTFLOW");
    assert.equal(f[0].severity, WARNING);
  });

  it("stays quiet below the threshold", () => {
    assert.deepEqual(
      checkOutflowRate({ label: "1 SOL", denomination: DENOM,
        vaultLamports: RENT + 7n * DENOM, previous: { vaultLamports: RENT + 9n * DENOM } }),
      []
    );
  });
});

describe("saturation", () => {
  it("is silent well below the cap", () => {
    assert.deepEqual(checkSaturation({ label: "1 SOL", deposits: 100n }), []);
  });
  it("warns near the cap", () => {
    const f = checkSaturation({ label: "1 SOL", deposits: 949_500n });
    assert.equal(f[0].code, "POOL_NEAR_SATURATION");
  });
  it("warns at the cap", () => {
    const f = checkSaturation({ label: "1 SOL", deposits: 950_000n });
    assert.equal(f[0].code, "POOL_SATURATED");
  });
});

describe("relayer balance", () => {
  it("is silent when funded", () => {
    assert.deepEqual(checkRelayerBalance({ balance: 5_000_000_000n }), []);
  });
  it("warns when low", () => {
    assert.equal(checkRelayerBalance({ balance: 50_000_000n })[0].code, "RELAYER_LOW");
  });
  it("fires CRITICAL when it cannot pay nullifier rent", () => {
    const f = checkRelayerBalance({ balance: 1_000_000n });
    assert.equal(f[0].code, "RELAYER_INSOLVENT");
    assert.equal(f[0].severity, CRITICAL);
    assert.match(f[0].message, /privacy/);
  });
  it("is silent when not configured", () => {
    assert.deepEqual(checkRelayerBalance({}), []);
  });
});

describe("pause transitions", () => {
  it("is silent with no change", () => {
    assert.deepEqual(
      checkPauseState({ label: "1 SOL", isPaused: false, previous: { isPaused: false } }),
      []
    );
  });
  it("records a pause, noting withdrawals are unaffected", () => {
    const f = checkPauseState({ label: "1 SOL", isPaused: true, previous: { isPaused: false } });
    assert.equal(f[0].code, "POOL_PAUSED");
    assert.equal(f[0].severity, INFO);
    assert.match(f[0].message, /never pausable/);
  });
});
