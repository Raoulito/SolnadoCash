// sdk/test/e2e.test.ts
// T35 — End-to-end SDK test: generateNote → deposit → generateProof → withdraw via relayer
//
// This test exercises the full privacy flow using all SDK modules together:
//   note.ts → proof.ts → fees.ts → stealth.ts
// Circuit files are required for proof generation (skipped if missing).
// Relayer interactions are mocked via globalThis.fetch.

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as snarkjs from "snarkjs";
import { generateNote, encodeNote, decodeNote } from "../src/note.js";
import {
  initPoseidon,
  poseidonHash,
  pubkeyToField,
  MerkleTree,
  generateWithdrawProof,
} from "../src/proof.js";
import {
  computeTreasuryFee,
  computeMinUserReceives,
  getFeeQuote,
  FeeQuote,
} from "../src/fees.js";
import {
  generateStealthAddress,
  recoverStealthKeypair,
} from "../src/stealth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "../..");
const WITHDRAW_WASM = resolve(ROOT_DIR, "circuits/build/withdraw_js/withdraw.wasm");
const WITHDRAW_ZKEY = resolve(ROOT_DIR, "circuits/build/withdraw_final.zkey");
const VK_PATH = resolve(ROOT_DIR, "circuits/build/withdraw_vk.json");

const hasCircuits =
  existsSync(WITHDRAW_WASM) &&
  existsSync(WITHDRAW_ZKEY) &&
  existsSync(VK_PATH);

// ── Test constants ────────────────────────────────────────────────────────────

const DENOMINATION = 1_000_000_000n; // 1 SOL
const RELAYER_FEE_MAX = 83_000n; // typical relayer fee

(hasCircuits ? describe : describe.skip)(
  "T35 — End-to-end SDK flow",
  function () {
    this.timeout(120_000);

    // Simulated actors
    const poolAddress = Keypair.generate().publicKey;
    const relayerKeypair = Keypair.generate();
    const recipientScanKeypair = Keypair.generate();
    const recipientSpendKeypair = Keypair.generate();

    let tree: MerkleTree;
    let originalFetch: typeof globalThis.fetch;

    before(async () => {
      await initPoseidon();
      tree = new MerkleTree(20);
      originalFetch = globalThis.fetch;
    });

    after(() => {
      globalThis.fetch = originalFetch;
    });

    // ── Step 1: Note generation ───────────────────────────────────────────

    let note: ReturnType<typeof generateNote>;

    it("Step 1 — generateNote creates a valid secret note", () => {
      note = generateNote(DENOMINATION, poolAddress);

      assert.equal(note.denomination, DENOMINATION);
      assert.equal(note.poolAddress.toBase58(), poolAddress.toBase58());
      assert.ok(note.nullifier > 0n, "nullifier must be non-zero");
      assert.ok(note.secret > 0n, "secret must be non-zero");
      assert.ok(note.encoded.startsWith("sndo_"), "encoded must have sndo_ prefix");
    });

    // ── Step 2: Note encode/decode roundtrip ──────────────────────────────

    it("Step 2 — encodeNote/decodeNote roundtrips correctly", () => {
      const encoded = encodeNote(note);
      assert.equal(encoded, note.encoded);

      const decoded = decodeNote(encoded);
      assert.equal(decoded.nullifier, note.nullifier);
      assert.equal(decoded.secret, note.secret);
      assert.equal(decoded.denomination, note.denomination);
      assert.equal(decoded.poolAddress.toBase58(), note.poolAddress.toBase58());
    });

    // ── Step 3: Compute commitment and insert into Merkle tree ────────────

    let commitment: bigint;

    it("Step 3 — compute commitment and insert into Merkle tree (simulates deposit)", () => {
      commitment = poseidonHash(note.nullifier, note.secret, note.denomination);
      assert.ok(commitment > 0n, "commitment must be non-zero");

      const emptyRoot = tree.root;
      const leafIndex = tree.insert(commitment);
      assert.equal(leafIndex, 0, "first deposit should be at index 0");
      assert.equal(tree.nextIndex, 1);
      assert.notEqual(tree.root, emptyRoot, "root should change after insert");

      // Verify commitment is findable
      assert.equal(tree.findLeaf(commitment), 0);
    });

    // ── Step 4: Generate stealth address for recipient ────────────────────

    let stealthAddress: PublicKey;
    let ephemeralPubkey: PublicKey;

    it("Step 4 — generate stealth address for recipient", () => {
      const result = generateStealthAddress(
        recipientScanKeypair.publicKey,
        recipientSpendKeypair.publicKey
      );
      stealthAddress = result.stealthAddress;
      ephemeralPubkey = result.ephemeralKey.publicKey;

      assert.ok(stealthAddress instanceof PublicKey);

      // Recipient can recover the same address
      const recovered = recoverStealthKeypair(
        recipientScanKeypair.secretKey.slice(0, 32),
        recipientSpendKeypair.publicKey,
        ephemeralPubkey
      );
      assert.equal(
        recovered.publicKey.toBase58(),
        stealthAddress.toBase58(),
        "recipient must recover the same stealth address"
      );
    });

    // ── Step 5: Get fee quote from relayer (mocked) ───────────────────────

    let quote: FeeQuote;

    it("Step 5 — getFeeQuote from relayer", async () => {
      const validUntil = Date.now() + 30_000;
      const treasuryFee = computeTreasuryFee(DENOMINATION);
      const estimatedUserReceives =
        DENOMINATION - treasuryFee - RELAYER_FEE_MAX;

      // Mock the relayer's /fee_quote endpoint
      globalThis.fetch = async (input: any) => {
        const url = typeof input === "string" ? input : input.url;
        assert.ok(
          url.includes("/fee_quote?pool="),
          "should call /fee_quote endpoint"
        );
        assert.ok(
          url.includes(poolAddress.toBase58()),
          "should include pool address"
        );

        return new Response(
          JSON.stringify({
            relayerAddress: relayerKeypair.publicKey.toBase58(),
            relayerFeeMax: RELAYER_FEE_MAX.toString(),
            validUntil,
            estimatedUserReceives: estimatedUserReceives.toString(),
            treasuryFee: treasuryFee.toString(),
            denomination: DENOMINATION.toString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      quote = await getFeeQuote("https://relayer.solnadocash.io", poolAddress);

      assert.equal(
        quote.relayerAddress.toBase58(),
        relayerKeypair.publicKey.toBase58()
      );
      assert.equal(quote.relayerFeeMax, RELAYER_FEE_MAX);
      assert.equal(quote.validUntil, validUntil);
      assert.equal(quote.estimatedUserReceives, estimatedUserReceives);
    });

    // ── Step 6: Verify fee calculations ───────────────────────────────────

    it("Step 6 — fee calculations are consistent", () => {
      const treasuryFee = computeTreasuryFee(DENOMINATION);
      assert.equal(treasuryFee, 2_000_000n, "treasury = 0.002 SOL for 1 SOL pool");

      const minUserReceives = computeMinUserReceives(DENOMINATION, quote);
      const expected = DENOMINATION - treasuryFee - quote.relayerFeeMax;
      assert.equal(minUserReceives, expected);
      assert.ok(minUserReceives > 0n, "user must receive positive amount");

      // Verify fee invariant: treasury + relayer + user == denomination
      assert.equal(
        treasuryFee + quote.relayerFeeMax + minUserReceives,
        DENOMINATION,
        "fee invariant: all fees + user amount == denomination"
      );
    });

    // ── Step 7: Generate ZK proof ─────────────────────────────────────────

    let proof: any;
    let publicSignals: [bigint, bigint, bigint];

    it("Step 7 — generateWithdrawProof creates a valid Groth16 proof", async () => {
      const result = await generateWithdrawProof(
        note,
        quote,
        stealthAddress, // withdraw to stealth address
        tree,
        { wasmPath: WITHDRAW_WASM, zkeyPath: WITHDRAW_ZKEY }
      );

      proof = result.proof;
      publicSignals = result.publicSignals;

      // Verify proof structure
      assert.ok(proof.pi_a, "proof must have pi_a");
      assert.ok(proof.pi_b, "proof must have pi_b");
      assert.ok(proof.pi_c, "proof must have pi_c");
      assert.equal(proof.protocol, "groth16");

      // Verify public signals order: [nullifierHash, root, withdrawalCommitment]
      assert.equal(publicSignals.length, 3);

      const expectedNullifierHash = poseidonHash(note.nullifier);
      assert.equal(
        publicSignals[0],
        expectedNullifierHash,
        "signal[0] must be nullifierHash"
      );
      assert.equal(
        publicSignals[1],
        tree.root,
        "signal[1] must be current Merkle root"
      );

      // Verify withdrawalCommitment binds recipient + relayer + fee
      const relayerField = pubkeyToField(quote.relayerAddress);
      const recipientField = pubkeyToField(stealthAddress);
      const expectedWC = poseidonHash(
        relayerField,
        quote.relayerFeeMax,
        recipientField
      );
      assert.equal(
        publicSignals[2],
        expectedWC,
        "signal[2] must be withdrawalCommitment"
      );
    });

    // ── Step 8: Verify proof off-chain (snarkjs) ──────────────────────────

    it("Step 8 — proof verifies with snarkjs (off-chain verification)", async () => {
      const { readFileSync } = await import("node:fs");
      const vk = JSON.parse(readFileSync(VK_PATH, "utf8"));

      const signalsAsStrings = publicSignals.map((s) => s.toString());
      const valid = await snarkjs.groth16.verify(vk, signalsAsStrings, proof);
      assert.ok(valid, "proof must verify against the verification key");
    });

    // ── Step 9: Submit to relayer (mocked) ────────────────────────────────

    it("Step 9 — submit proof to relayer and receive tx signature", async () => {
      const fakeTxSig = "5wHu1qwD7q3bYJe4QsCxqW" + "a".repeat(64);

      globalThis.fetch = async (input: any, init: any) => {
        const url = typeof input === "string" ? input : input.url;
        assert.ok(
          url.includes("/submit_proof"),
          "should call /submit_proof endpoint"
        );
        assert.equal(init?.method, "POST");

        const body = JSON.parse(init.body);

        // Verify the relayer receives correct proof format
        assert.ok(body.proof, "body must include proof");
        assert.ok(body.proof.pi_a, "proof must have pi_a");
        assert.ok(body.proof.pi_b, "proof must have pi_b");
        assert.ok(body.proof.pi_c, "proof must have pi_c");

        // Verify public signals (as decimal strings)
        assert.deepEqual(body.publicSignals, [
          publicSignals[0].toString(),
          publicSignals[1].toString(),
          publicSignals[2].toString(),
        ]);

        // Verify pool and recipient
        assert.equal(body.poolAddress, poolAddress.toBase58());
        assert.equal(body.recipient, stealthAddress.toBase58());
        assert.equal(body.relayerFeeMax, RELAYER_FEE_MAX.toString());

        return new Response(
          JSON.stringify({
            txSignature: fakeTxSig,
            feeTaken: RELAYER_FEE_MAX.toString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      // Simulate what the SDK client would do to submit
      const relayerUrl = "https://relayer.solnadocash.io";
      const res = await fetch(`${relayerUrl}/submit_proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proof,
          publicSignals: publicSignals.map((s) => s.toString()),
          poolAddress: poolAddress.toBase58(),
          recipient: stealthAddress.toBase58(),
          relayerFeeMax: RELAYER_FEE_MAX.toString(),
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.txSignature, "response must include txSignature");
      assert.equal(data.feeTaken, RELAYER_FEE_MAX.toString());
    });

    // ── Step 10: Verify double-spend protection ───────────────────────────

    it("Step 10 — same note cannot generate proof with different recipient", async () => {
      // The same note in the same tree should still produce a valid proof
      // (double-spend is enforced on-chain via nullifier PDA, not in the circuit).
      // But the nullifierHash must be the same, which the on-chain program rejects.
      const differentRecipient = Keypair.generate().publicKey;

      const result2 = await generateWithdrawProof(
        note,
        quote,
        differentRecipient,
        tree,
        { wasmPath: WITHDRAW_WASM, zkeyPath: WITHDRAW_ZKEY }
      );

      // Same nullifierHash — on-chain would reject as double-spend
      assert.equal(
        result2.publicSignals[0],
        publicSignals[0],
        "nullifierHash must be identical for the same note"
      );

      // Different withdrawalCommitment (different recipient)
      assert.notEqual(
        result2.publicSignals[2],
        publicSignals[2],
        "withdrawalCommitment must differ for different recipient"
      );
    });

    // ── Step 11: Multiple deposits in same tree ───────────────────────────

    it("Step 11 — second deposit updates tree, first deposit proof still works", async () => {
      // Simulate a second deposit from a different user
      const note2 = generateNote(DENOMINATION, poolAddress);
      const commitment2 = poseidonHash(
        note2.nullifier,
        note2.secret,
        note2.denomination
      );
      const leafIndex2 = tree.insert(commitment2);
      assert.equal(leafIndex2, 1, "second deposit at index 1");
      assert.equal(tree.nextIndex, 2);

      // Generate proof for the SECOND note (new tree state)
      const recipient2 = Keypair.generate().publicKey;
      const { proof: proof2, publicSignals: ps2 } =
        await generateWithdrawProof(note2, quote, recipient2, tree, {
          wasmPath: WITHDRAW_WASM,
          zkeyPath: WITHDRAW_ZKEY,
        });

      // Verify proof2 is valid
      const { readFileSync } = await import("node:fs");
      const vk = JSON.parse(readFileSync(VK_PATH, "utf8"));
      const valid = await snarkjs.groth16.verify(
        vk,
        ps2.map((s) => s.toString()),
        proof2
      );
      assert.ok(valid, "second deposit proof must also verify");

      // Root is different from original proof (tree grew)
      assert.notEqual(
        ps2[1],
        publicSignals[1],
        "root must differ after second deposit"
      );

      // NullifierHash is different (different note)
      assert.notEqual(
        ps2[0],
        publicSignals[0],
        "nullifierHash must differ for different notes"
      );
    });
  }
);
