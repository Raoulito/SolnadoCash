// sdk/test/proof.test.ts
// T32 — Tests for MerkleTree, poseidonHash, pubkeyToField, generateWithdrawProof

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  initPoseidon,
  poseidonHash,
  pubkeyToField,
  MerkleTree,
  generateWithdrawProof,
} from "../src/proof.js";
import { generateNote } from "../src/note.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "../..");
const WITHDRAW_WASM = resolve(ROOT_DIR, "circuits/build/withdraw_js/withdraw.wasm");
const WITHDRAW_ZKEY = resolve(ROOT_DIR, "circuits/build/withdraw_final.zkey");

const BN254_FIELD_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe("T32 — sdk/src/proof.ts", function () {
  this.timeout(120_000); // proof generation can be slow

  before(async () => {
    await initPoseidon();
  });

  // ── poseidonHash ──────────────────────────────────────────────────────────

  describe("poseidonHash", () => {
    it("hashes single input (nullifierHash style)", () => {
      const result = poseidonHash(42n);
      assert.ok(result > 0n);
      assert.ok(result < BN254_FIELD_ORDER);
    });

    it("hashes three inputs (commitment style)", () => {
      const result = poseidonHash(1n, 2n, 1_000_000_000n);
      assert.ok(result > 0n);
      assert.ok(result < BN254_FIELD_ORDER);
    });

    it("is deterministic", () => {
      const a = poseidonHash(100n, 200n);
      const b = poseidonHash(100n, 200n);
      assert.equal(a, b);
    });

    it("different inputs produce different hashes", () => {
      const a = poseidonHash(1n, 2n);
      const b = poseidonHash(2n, 1n);
      assert.notEqual(a, b);
    });
  });

  // ── pubkeyToField ────────────────────────────────────────────────────────

  describe("pubkeyToField", () => {
    it("returns a value within BN254 Fr", () => {
      const pk = Keypair.generate().publicKey;
      const field = pubkeyToField(pk);
      assert.ok(field >= 0n);
      assert.ok(field < BN254_FIELD_ORDER);
    });

    it("is deterministic for the same key", () => {
      const pk = Keypair.generate().publicKey;
      assert.equal(pubkeyToField(pk), pubkeyToField(pk));
    });

    it("reduces pubkeys exceeding Fr", () => {
      // Create a pubkey with all 0xFF bytes (exceeds Fr)
      const maxBytes = new Uint8Array(32).fill(0xff);
      const pk = new PublicKey(maxBytes);
      const field = pubkeyToField(pk);
      assert.ok(field < BN254_FIELD_ORDER);
      // 2^256 - 1 mod Fr
      const expected = (2n ** 256n - 1n) % BN254_FIELD_ORDER;
      assert.equal(field, expected);
    });
  });

  // ── MerkleTree ────────────────────────────────────────────────────────────

  describe("MerkleTree", () => {
    it("empty tree root equals zeros[depth]", () => {
      const tree = new MerkleTree(20);
      const expectedRoot = tree.zeros[20];
      assert.equal(tree.root, expectedRoot);
    });

    it("nextIndex starts at 0", () => {
      const tree = new MerkleTree();
      assert.equal(tree.nextIndex, 0);
    });

    it("insert increments nextIndex", () => {
      const tree = new MerkleTree();
      tree.insert(1n);
      assert.equal(tree.nextIndex, 1);
      tree.insert(2n);
      assert.equal(tree.nextIndex, 2);
    });

    it("single insert changes root", () => {
      const tree = new MerkleTree();
      const emptyRoot = tree.root;
      tree.insert(42n);
      assert.notEqual(tree.root, emptyRoot);
    });

    it("getProof returns valid path for single leaf", () => {
      const tree = new MerkleTree();
      tree.insert(42n);
      const proof = tree.getProof(0);
      assert.equal(proof.leafIndex, 0);
      assert.equal(proof.pathElements.length, 20);
      assert.equal(proof.pathIndices.length, 20);
      // First leaf at index 0: all pathIndices should be 0 (left child)
      assert.ok(proof.pathIndices.every((i) => i === 0));
    });

    it("getProof root matches tree root", () => {
      const tree = new MerkleTree();
      tree.insert(100n);
      tree.insert(200n);
      const proof0 = tree.getProof(0);
      const proof1 = tree.getProof(1);
      assert.equal(proof0.root, tree.root);
      assert.equal(proof1.root, tree.root);
    });

    it("proof can be verified by recomputing root", () => {
      const tree = new MerkleTree();
      const leaf = poseidonHash(123n, 456n, 1_000_000_000n);
      tree.insert(leaf);
      const proof = tree.getProof(0);

      // Recompute root from proof
      let current = leaf;
      for (let i = 0; i < proof.pathElements.length; i++) {
        if (proof.pathIndices[i] === 0) {
          current = poseidonHash(current, proof.pathElements[i]);
        } else {
          current = poseidonHash(proof.pathElements[i], current);
        }
      }
      assert.equal(current, tree.root);
    });

    it("proof valid after multiple inserts", () => {
      const tree = new MerkleTree();
      const leaves = [10n, 20n, 30n, 40n, 50n];
      for (const leaf of leaves) tree.insert(leaf);

      // Verify proof for each leaf
      for (let idx = 0; idx < leaves.length; idx++) {
        const proof = tree.getProof(idx);
        let current = leaves[idx];
        for (let i = 0; i < proof.pathElements.length; i++) {
          if (proof.pathIndices[i] === 0) {
            current = poseidonHash(current, proof.pathElements[i]);
          } else {
            current = poseidonHash(proof.pathElements[i], current);
          }
        }
        assert.equal(current, tree.root, `Proof failed for leaf index ${idx}`);
      }
    });

    it("findLeaf returns correct index", () => {
      const tree = new MerkleTree();
      tree.insert(100n);
      tree.insert(200n);
      tree.insert(300n);
      assert.equal(tree.findLeaf(100n), 0);
      assert.equal(tree.findLeaf(200n), 1);
      assert.equal(tree.findLeaf(300n), 2);
      assert.equal(tree.findLeaf(999n), -1);
    });

    it("getProof throws for out-of-range index", () => {
      const tree = new MerkleTree();
      tree.insert(1n);
      assert.throws(() => tree.getProof(-1), /out of range/);
      assert.throws(() => tree.getProof(1), /out of range/);
    });

    it("second leaf pathIndices[0] is 1 (right child)", () => {
      const tree = new MerkleTree();
      tree.insert(1n);
      tree.insert(2n);
      const proof = tree.getProof(1);
      assert.equal(proof.pathIndices[0], 1); // right child at level 0
    });
  });

  // ── generateWithdrawProof (requires circuit files) ────────────────────────

  const hasCircuits = existsSync(WITHDRAW_WASM) && existsSync(WITHDRAW_ZKEY);

  (hasCircuits ? describe : describe.skip)(
    "generateWithdrawProof (circuit integration)",
    function () {
      this.timeout(120_000);

      it("generates a valid proof for a single-deposit tree", async () => {
        const denomination = 1_000_000_000n;
        const poolAddress = Keypair.generate().publicKey;
        const note = generateNote(denomination, poolAddress);

        // Build tree and insert commitment
        const tree = new MerkleTree();
        const commitment = poseidonHash(
          note.nullifier,
          note.secret,
          note.denomination
        );
        tree.insert(commitment);

        // Mock fee quote
        const relayer = Keypair.generate();
        const recipient = Keypair.generate();
        const relayerFeeMax = 5_000_000n; // 0.005 SOL
        const quote = {
          relayerAddress: relayer.publicKey,
          relayerFeeMax,
          validUntil: Math.floor(Date.now() / 1000) + 30,
          estimatedUserReceives:
            denomination - denomination / 500n - relayerFeeMax,
        };

        const { proof, publicSignals } = await generateWithdrawProof(
          note,
          quote,
          recipient.publicKey,
          tree,
          { wasmPath: WITHDRAW_WASM, zkeyPath: WITHDRAW_ZKEY }
        );

        // Verify proof structure
        assert.ok(proof.pi_a, "proof should have pi_a");
        assert.ok(proof.pi_b, "proof should have pi_b");
        assert.ok(proof.pi_c, "proof should have pi_c");
        assert.equal(proof.protocol, "groth16");

        // Verify public signals: [nullifierHash, root, withdrawalCommitment]
        assert.equal(publicSignals.length, 3);
        const expectedNullifierHash = poseidonHash(note.nullifier);
        assert.equal(publicSignals[0], expectedNullifierHash);
        assert.equal(publicSignals[1], tree.root);

        const relayerField = pubkeyToField(relayer.publicKey);
        const recipientField = pubkeyToField(recipient.publicKey);
        const expectedWC = poseidonHash(
          relayerField,
          relayerFeeMax,
          recipientField
        );
        assert.equal(publicSignals[2], expectedWC);
      });

      it("throws when commitment is not in tree", async () => {
        const note = generateNote(1_000_000_000n, Keypair.generate().publicKey);
        const tree = new MerkleTree(); // empty tree
        const relayer = Keypair.generate();
        const quote = {
          relayerAddress: relayer.publicKey,
          relayerFeeMax: 5_000_000n,
          validUntil: Math.floor(Date.now() / 1000) + 30,
          estimatedUserReceives: 0n,
        };

        await assert.rejects(
          () =>
            generateWithdrawProof(note, quote, Keypair.generate().publicKey, tree, {
              wasmPath: WITHDRAW_WASM,
              zkeyPath: WITHDRAW_ZKEY,
            }),
          /Commitment not found/
        );
      });
    }
  );
});
