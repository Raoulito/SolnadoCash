// sdk/test/rng.test.ts
// L-1 / L-2 — note secret sampling: uniformity and RNG source.

import { strict as assert } from "node:assert";
import { Keypair } from "@solana/web3.js";
import { generateNote } from "../src/note.js";

const BN254_FIELD_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe("L-1/L-2 — note secret sampling", function () {
  this.timeout(30_000);

  const pool = Keypair.generate().publicKey;
  const DENOM = 1_000_000_000n;

  it("always produces in-field values", () => {
    for (let i = 0; i < 500; i++) {
      const n = generateNote(DENOM, pool);
      assert.ok(n.nullifier < BN254_FIELD_ORDER, "nullifier must be in-field");
      assert.ok(n.secret < BN254_FIELD_ORDER, "secret must be in-field");
      assert.ok(n.nullifier >= 0n && n.secret >= 0n);
    }
  });

  it("never repeats a value", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const n = generateNote(DENOM, pool);
      for (const v of [n.nullifier, n.secret]) {
        const k = v.toString();
        assert.ok(!seen.has(k), "sampled the same field element twice");
        seen.add(k);
      }
    }
  });

  it("is not biased toward the low part of the field (L-1)", () => {
    // The old `random256 % Fr` over-weighted the low 2^256 mod Fr ≈ 0.29*Fr of the
    // field, because those values have 6 preimages in [0, 2^256) while the rest have
    // 5. Expected share below that boundary:
    //   unbiased      : boundary / Fr        ≈ 0.2902
    //   old mod-based : 6 * boundary / 2^256 ≈ 0.3291   (measured: 0.332)
    const boundary = (1n << 256n) % BN254_FIELD_ORDER;
    const expectedShare = Number(boundary) / Number(BN254_FIELD_ORDER);
    const oldBiasedShare = (6 * Number(boundary)) / Number(1n << 256n);

    const N = 3000; // 6000 samples: standard error ≈ 0.0059 at p ≈ 0.29
    const TOLERANCE = 0.025; // ≈4.2 sigma — stable, and well below the 0.039 gap

    // The test must actually be able to tell the two apart, otherwise it proves
    // nothing. Assert its discriminating power explicitly.
    assert.ok(
      Math.abs(oldBiasedShare - expectedShare) > TOLERANCE,
      `test cannot discriminate: old bias ${oldBiasedShare.toFixed(4)} is within ` +
        `tolerance ${TOLERANCE} of unbiased ${expectedShare.toFixed(4)}`
    );

    let below = 0;
    for (let i = 0; i < N; i++) {
      const n = generateNote(DENOM, pool);
      if (n.nullifier < boundary) below++;
      if (n.secret < boundary) below++;
    }
    const observed = below / (N * 2);

    assert.ok(
      Math.abs(observed - expectedShare) < TOLERANCE,
      `observed ${observed.toFixed(4)} vs unbiased ${expectedShare.toFixed(4)} ` +
        `(old biased sampler would give ≈${oldBiasedShare.toFixed(4)}) — distribution looks biased`
    );
  });

  it("uses the top of the field too (high bits are reachable)", () => {
    // A truncating or mod-based sampler with a broken high byte would never reach
    // the upper field. Expect ~71% of samples above the boundary.
    let high = 0;
    const boundary = (1n << 256n) % BN254_FIELD_ORDER;
    for (let i = 0; i < 200; i++) {
      if (generateNote(DENOM, pool).nullifier >= boundary) high++;
    }
    assert.ok(high > 100, `only ${high}/200 samples in the upper field`);
  });
});
