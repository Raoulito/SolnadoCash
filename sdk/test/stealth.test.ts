// sdk/test/stealth.test.ts
// T33 — Tests for stealth address generation and recovery

import { strict as assert } from "node:assert";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  generateStealthAddress,
  recoverStealthKeypair,
  isMyStealthAddress,
} from "../src/stealth.js";

describe("T33 — sdk/src/stealth.ts", function () {
  // Recipient's key pairs (scan + spend)
  const scanKeypair = Keypair.generate();
  const spendKeypair = Keypair.generate();

  describe("generateStealthAddress", () => {
    it("returns a valid PublicKey and Keypair", () => {
      const result = generateStealthAddress(
        scanKeypair.publicKey,
        spendKeypair.publicKey
      );
      assert.ok(result.stealthAddress instanceof PublicKey);
      assert.ok(result.ephemeralKey instanceof Keypair);
      assert.equal(result.stealthAddress.toBytes().length, 32);
      assert.equal(result.ephemeralKey.publicKey.toBytes().length, 32);
    });

    it("generates unique stealth addresses each time", () => {
      const a = generateStealthAddress(
        scanKeypair.publicKey,
        spendKeypair.publicKey
      );
      const b = generateStealthAddress(
        scanKeypair.publicKey,
        spendKeypair.publicKey
      );
      assert.notEqual(
        a.stealthAddress.toBase58(),
        b.stealthAddress.toBase58()
      );
      assert.notEqual(
        a.ephemeralKey.publicKey.toBase58(),
        b.ephemeralKey.publicKey.toBase58()
      );
    });

    it("stealth address differs from scan and spend keys", () => {
      const { stealthAddress } = generateStealthAddress(
        scanKeypair.publicKey,
        spendKeypair.publicKey
      );
      assert.notEqual(
        stealthAddress.toBase58(),
        scanKeypair.publicKey.toBase58()
      );
      assert.notEqual(
        stealthAddress.toBase58(),
        spendKeypair.publicKey.toBase58()
      );
    });

    it("different spend keys produce different stealth addresses", () => {
      const spend2 = Keypair.generate();
      const a = generateStealthAddress(
        scanKeypair.publicKey,
        spendKeypair.publicKey
      );
      const b = generateStealthAddress(
        scanKeypair.publicKey,
        spend2.publicKey
      );
      // Different ephemeral keys AND different spend keys → different stealth addresses
      assert.notEqual(
        a.stealthAddress.toBase58(),
        b.stealthAddress.toBase58()
      );
    });
  });

  describe("recoverStealthKeypair", () => {
    it("recovers the same stealth address the sender generated", () => {
      const { stealthAddress, ephemeralKey } = generateStealthAddress(
        scanKeypair.publicKey,
        spendKeypair.publicKey
      );

      const recovered = recoverStealthKeypair(
        scanKeypair.secretKey.slice(0, 32), // 32-byte seed
        spendKeypair.publicKey,
        ephemeralKey.publicKey
      );

      assert.equal(
        recovered.publicKey.toBase58(),
        stealthAddress.toBase58(),
        "Recovered stealth address must match generated one"
      );
    });

    it("recovered keypair can sign (has valid secret key)", () => {
      const { ephemeralKey } = generateStealthAddress(
        scanKeypair.publicKey,
        spendKeypair.publicKey
      );

      const recovered = recoverStealthKeypair(
        scanKeypair.secretKey.slice(0, 32),
        spendKeypair.publicKey,
        ephemeralKey.publicKey
      );

      // Verify the keypair is internally consistent (pub matches priv)
      const rederived = Keypair.fromSecretKey(recovered.secretKey);
      assert.equal(
        rederived.publicKey.toBase58(),
        recovered.publicKey.toBase58()
      );
    });

    it("wrong scan key fails to recover", () => {
      const { stealthAddress, ephemeralKey } = generateStealthAddress(
        scanKeypair.publicKey,
        spendKeypair.publicKey
      );

      const wrongScan = Keypair.generate();
      const wrong = recoverStealthKeypair(
        wrongScan.secretKey.slice(0, 32),
        spendKeypair.publicKey,
        ephemeralKey.publicKey
      );

      assert.notEqual(
        wrong.publicKey.toBase58(),
        stealthAddress.toBase58(),
        "Wrong scan key must produce a different address"
      );
    });

    it("wrong ephemeral key fails to recover", () => {
      const { stealthAddress } = generateStealthAddress(
        scanKeypair.publicKey,
        spendKeypair.publicKey
      );

      const wrongEph = Keypair.generate();
      const wrong = recoverStealthKeypair(
        scanKeypair.secretKey.slice(0, 32),
        spendKeypair.publicKey,
        wrongEph.publicKey
      );

      assert.notEqual(
        wrong.publicKey.toBase58(),
        stealthAddress.toBase58(),
        "Wrong ephemeral key must produce a different address"
      );
    });

    it("works when scan and spend are the same key", () => {
      // Common setup for SOL pools — single keypair
      const sameKey = Keypair.generate();
      const { stealthAddress, ephemeralKey } = generateStealthAddress(
        sameKey.publicKey,
        sameKey.publicKey
      );

      const recovered = recoverStealthKeypair(
        sameKey.secretKey.slice(0, 32),
        sameKey.publicKey,
        ephemeralKey.publicKey
      );

      assert.equal(
        recovered.publicKey.toBase58(),
        stealthAddress.toBase58()
      );
    });
  });

  describe("isMyStealthAddress", () => {
    it("returns true for a matching stealth address", () => {
      const { stealthAddress, ephemeralKey } = generateStealthAddress(
        scanKeypair.publicKey,
        spendKeypair.publicKey
      );

      const result = isMyStealthAddress(
        scanKeypair.secretKey.slice(0, 32),
        spendKeypair.publicKey,
        ephemeralKey.publicKey,
        stealthAddress
      );

      assert.ok(result, "Should recognize own stealth address");
    });

    it("returns false for a non-matching address", () => {
      const { ephemeralKey } = generateStealthAddress(
        scanKeypair.publicKey,
        spendKeypair.publicKey
      );

      const randomAddress = Keypair.generate().publicKey;
      const result = isMyStealthAddress(
        scanKeypair.secretKey.slice(0, 32),
        spendKeypair.publicKey,
        ephemeralKey.publicKey,
        randomAddress
      );

      assert.ok(!result, "Should not match a random address");
    });

    it("returns false with wrong scan key", () => {
      const { stealthAddress, ephemeralKey } = generateStealthAddress(
        scanKeypair.publicKey,
        spendKeypair.publicKey
      );

      const wrongScan = Keypair.generate();
      const result = isMyStealthAddress(
        wrongScan.secretKey.slice(0, 32),
        spendKeypair.publicKey,
        ephemeralKey.publicKey,
        stealthAddress
      );

      assert.ok(!result, "Wrong scan key should not match");
    });
  });

  describe("determinism", () => {
    it("same inputs always produce same stealth address", () => {
      // Use a fixed ephemeral seed to verify determinism
      // (generateStealthAddress uses random internally, so we test via recovery)
      const { stealthAddress, ephemeralKey } = generateStealthAddress(
        scanKeypair.publicKey,
        spendKeypair.publicKey
      );

      // Recover twice with same inputs
      const a = recoverStealthKeypair(
        scanKeypair.secretKey.slice(0, 32),
        spendKeypair.publicKey,
        ephemeralKey.publicKey
      );
      const b = recoverStealthKeypair(
        scanKeypair.secretKey.slice(0, 32),
        spendKeypair.publicKey,
        ephemeralKey.publicKey
      );

      assert.equal(a.publicKey.toBase58(), b.publicKey.toBase58());
      assert.equal(a.publicKey.toBase58(), stealthAddress.toBase58());
    });
  });
});
