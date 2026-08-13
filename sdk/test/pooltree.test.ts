// sdk/test/pooltree.test.ts
// H-5 — verifying a locally rebuilt Merkle tree against on-chain pool state.

import { strict as assert } from "node:assert";
import {
  initPoseidon,
  MerkleTree,
  readPoolTreeState,
  verifyTreeMatchesPool,
  ROOT_HISTORY_SIZE,
} from "../src/proof.js";

// Mirrors programs/solnadocash/src/state.rs
const DISCRIMINATOR = 8;
const NEXT_INDEX_OFFSET = DISCRIMINATOR + 80;
const CURRENT_ROOT_INDEX_OFFSET = DISCRIMINATOR + 128;
const ROOT_HISTORY_OFFSET = DISCRIMINATOR + 136;
const POOL_LEN = DISCRIMINATOR + 8968;

/** Synthesise a raw Pool account with the given tree state. */
function makePoolData(opts: {
  nextIndex: number;
  currentRootIndex: number;
  roots: Map<number, bigint>;
}): Uint8Array {
  const d = new Uint8Array(POOL_LEN);
  const writeU64LE = (off: number, v: number) => {
    let n = BigInt(v);
    for (let i = 0; i < 8; i++) {
      d[off + i] = Number(n & 0xffn);
      n >>= 8n;
    }
  };
  writeU64LE(NEXT_INDEX_OFFSET, opts.nextIndex);
  writeU64LE(CURRENT_ROOT_INDEX_OFFSET, opts.currentRootIndex);
  for (const [idx, root] of opts.roots) {
    const hex = root.toString(16).padStart(64, "0");
    for (let j = 0; j < 32; j++) {
      d[ROOT_HISTORY_OFFSET + idx * 32 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
    }
  }
  return d;
}

describe("H-5 — verifyTreeMatchesPool", function () {
  this.timeout(30_000);

  before(async () => {
    await initPoseidon();
  });

  it("accepts a tree whose root is the newest on-chain root", () => {
    const tree = new MerkleTree(20);
    tree.insert(111n);
    tree.insert(222n);
    const pool = makePoolData({
      nextIndex: 2,
      currentRootIndex: 2,
      roots: new Map([[2, tree.root]]),
    });
    const r = verifyTreeMatchesPool(tree, pool);
    assert.equal(r.leafCount, 2);
    assert.equal(r.rootIndex, 2);
    assert.equal(r.root, tree.root);
  });

  it("accepts a root from anywhere in the history ring", () => {
    const tree = new MerkleTree(20);
    tree.insert(7n);
    const pool = makePoolData({
      nextIndex: 1,
      currentRootIndex: 200,
      roots: new Map([[ROOT_HISTORY_SIZE - 1, tree.root]]),
    });
    assert.equal(verifyTreeMatchesPool(tree, pool).rootIndex, ROOT_HISTORY_SIZE - 1);
  });

  it("rejects an incomplete tree with a precise count (the pruned-RPC case)", () => {
    // On-chain has 5 deposits, the client only recovered 3.
    const tree = new MerkleTree(20);
    tree.insert(1n);
    tree.insert(2n);
    tree.insert(3n);
    const pool = makePoolData({
      nextIndex: 5,
      currentRootIndex: 5,
      roots: new Map([[5, 999n]]),
    });
    assert.throws(
      () => verifyTreeMatchesPool(tree, pool),
      /recovered 3 of 5 on-chain deposits/
    );
  });

  it("rejects a tree with the right leaf count but wrong contents/order", () => {
    // Same number of leaves, inserted in the wrong order → different root.
    const correct = new MerkleTree(20);
    correct.insert(10n);
    correct.insert(20n);
    const swapped = new MerkleTree(20);
    swapped.insert(20n);
    swapped.insert(10n);
    assert.notEqual(correct.root, swapped.root, "order must change the root");

    const pool = makePoolData({
      nextIndex: 2,
      currentRootIndex: 2,
      roots: new Map([[2, correct.root]]),
    });
    assert.throws(
      () => verifyTreeMatchesPool(swapped, pool),
      /does not match any of the last 256 on-chain roots/
    );
  });

  it("does not accept the all-zero root of an unused history slot", () => {
    // An empty tree has a non-zero root (zeros[depth]); a blank ring slot is 0.
    // A tree must never validate against an unused slot.
    const tree = new MerkleTree(20);
    assert.notEqual(tree.root, 0n);
    const pool = makePoolData({
      nextIndex: 0,
      currentRootIndex: 0,
      roots: new Map(),
    });
    assert.throws(() => verifyTreeMatchesPool(tree, pool), /does not match/);
  });

  it("rejects a truncated pool account", () => {
    assert.throws(
      () => readPoolTreeState(new Uint8Array(100)),
      /Pool account too small/
    );
  });

  // ── L-3: duplicate commitments ─────────────────────────────────────────────
  it("detects duplicate leaves (L-3)", () => {
    const tree = new MerkleTree(20);
    tree.insert(100n);
    tree.insert(200n);
    tree.insert(100n); // same commitment deposited twice

    assert.deepEqual(tree.findAllLeaves(100n), [0, 2]);
    assert.deepEqual(tree.findAllLeaves(200n), [1]);
    assert.deepEqual(tree.findAllLeaves(999n), []);

    // findLeaf still returns the first, which is the correct index to prove against:
    // every duplicate shares one nullifier, so only one is ever spendable.
    assert.equal(tree.findLeaf(100n), 0);
    assert.equal(tree.hasLeaf(100n), true);
    assert.equal(tree.hasLeaf(999n), false);
  });

  it("decodes next_index and current_root_index correctly", () => {
    const pool = makePoolData({
      nextIndex: 123_456,
      currentRootIndex: 77,
      roots: new Map([[77, 42n]]),
    });
    const s = readPoolTreeState(pool);
    assert.equal(s.nextIndex, 123_456);
    assert.equal(s.currentRootIndex, 77);
    assert.equal(s.roots[77], 42n);
    assert.equal(s.roots.length, ROOT_HISTORY_SIZE);
  });
});
