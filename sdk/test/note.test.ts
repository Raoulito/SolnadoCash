// sdk/test/note.test.ts
// T31 — Tests for generateNote, encodeNote, decodeNote

import { strict as assert } from "node:assert";
import { Keypair, PublicKey } from "@solana/web3.js";
import { generateNote, encodeNote, decodeNote } from "../src/note.js";

const BN254_FIELD_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe("T31 — sdk/src/note.ts", function () {
  const denomination = 1_000_000_000n; // 1 SOL
  const poolAddress = Keypair.generate().publicKey;

  describe("generateNote", () => {
    it("returns a valid SecretNote with correct fields", () => {
      const note = generateNote(denomination, poolAddress);
      assert.equal(note.denomination, denomination);
      assert.equal(note.poolAddress.toBase58(), poolAddress.toBase58());
      assert.ok(note.nullifier > 0n);
      assert.ok(note.secret > 0n);
      assert.ok(note.nullifier < BN254_FIELD_ORDER);
      assert.ok(note.secret < BN254_FIELD_ORDER);
      assert.ok(note.encoded.startsWith("sndo_"));
    });

    it("generates unique notes on each call", () => {
      const a = generateNote(denomination, poolAddress);
      const b = generateNote(denomination, poolAddress);
      assert.notEqual(a.nullifier, b.nullifier);
      assert.notEqual(a.secret, b.secret);
      assert.notEqual(a.encoded, b.encoded);
    });

    it("throws for denomination < 500 (BF-14)", () => {
      assert.throws(
        () => generateNote(499n, poolAddress),
        /Denomination must be >= 500/
      );
    });

    it("accepts denomination == 500", () => {
      const note = generateNote(500n, poolAddress);
      assert.equal(note.denomination, 500n);
    });
  });

  describe("encodeNote / decodeNote roundtrip", () => {
    it("roundtrips correctly", () => {
      const note = generateNote(denomination, poolAddress);
      const encoded = encodeNote(note);
      const decoded = decodeNote(encoded);
      assert.equal(decoded.nullifier, note.nullifier);
      assert.equal(decoded.secret, note.secret);
      assert.equal(decoded.denomination, note.denomination);
      assert.equal(
        decoded.poolAddress.toBase58(),
        note.poolAddress.toBase58()
      );
      assert.equal(decoded.encoded, encoded);
    });

    it("note.encoded matches encodeNote output", () => {
      const note = generateNote(denomination, poolAddress);
      assert.equal(note.encoded, encodeNote(note));
    });

    it("roundtrips with various denominations", () => {
      for (const denom of [500n, 100_000_000n, 1_000_000_000n, 10_000_000_000n]) {
        const note = generateNote(denom, poolAddress);
        const decoded = decodeNote(note.encoded);
        assert.equal(decoded.denomination, denom);
      }
    });

    it("roundtrips with different pool addresses", () => {
      for (let i = 0; i < 5; i++) {
        const pool = Keypair.generate().publicKey;
        const note = generateNote(denomination, pool);
        const decoded = decodeNote(note.encoded);
        assert.equal(decoded.poolAddress.toBase58(), pool.toBase58());
      }
    });
  });

  describe("decodeNote validation", () => {
    it("rejects missing prefix", () => {
      assert.throws(
        () => decodeNote("invalid_string"),
        /must start with 'sndo_'/
      );
    });

    it("rejects wrong part count", () => {
      assert.throws(() => decodeNote("sndo_abc"), /expected/);
    });

    it("rejects invalid pool address", () => {
      assert.throws(
        () =>
          decodeNote(
            "sndo_notavalidpubkey_0000000000000001_" + "a".repeat(128)
          ),
        /malformed pool/
      );
    });

    it("rejects wrong preimage length", () => {
      const pool = poolAddress.toBase58();
      assert.throws(
        () =>
          decodeNote(`sndo_${pool}_0000000000000001_${"a".repeat(100)}`),
        /preimage must be 128/
      );
    });

    it("rejects non-hex preimage", () => {
      const pool = poolAddress.toBase58();
      assert.throws(
        () =>
          decodeNote(`sndo_${pool}_0000000000000001_${"g".repeat(128)}`),
        /lowercase hex/
      );
    });

    it("rejects uppercase hex in preimage", () => {
      const pool = poolAddress.toBase58();
      assert.throws(
        () =>
          decodeNote(`sndo_${pool}_0000000000000001_${"A".repeat(128)}`),
        /lowercase hex/
      );
    });

    it("rejects nullifier >= BN254 field order", () => {
      const pool = poolAddress.toBase58();
      const bigHex = BN254_FIELD_ORDER.toString(16).padStart(64, "0");
      assert.throws(
        () =>
          decodeNote(
            `sndo_${pool}_0000000000000001_${bigHex}${"0".repeat(64)}`
          ),
        /nullifier exceeds/
      );
    });

    it("rejects secret >= BN254 field order", () => {
      const pool = poolAddress.toBase58();
      const bigHex = BN254_FIELD_ORDER.toString(16).padStart(64, "0");
      assert.throws(
        () =>
          decodeNote(
            `sndo_${pool}_0000000000000001_${"0".repeat(64)}${bigHex}`
          ),
        /secret exceeds/
      );
    });

    it("rejects invalid denomination hex", () => {
      const pool = poolAddress.toBase58();
      assert.throws(
        () =>
          decodeNote(`sndo_${pool}_00000000000001_${"a".repeat(128)}`),
        /denomination must be 16/
      );
    });
  });
});
