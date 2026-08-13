// relayer/test/preflight.test.js
// M-4 — pre-flight validation against on-chain state.

import { strict as assert } from "node:assert";
import { Keypair } from "@solana/web3.js";
import { buildPoseidon } from "circomlibjs";
import { preflight, pubkeyToField, readRootHistory } from "../src/preflight.js";

const ROOT_HISTORY_OFFSET = 8 + 136;
const POOL_LEN = 8 + 8968;

function makePoolData(roots = new Map()) {
  const d = Buffer.alloc(POOL_LEN);
  for (const [idx, root] of roots) {
    const hex = root.toString(16).padStart(64, "0");
    Buffer.from(hex, "hex").copy(d, ROOT_HISTORY_OFFSET + idx * 32);
  }
  return d;
}

describe("M-4 — relayer preflight", function () {
  this.timeout(30_000);

  let poseidon, F;
  const relayer = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const FEE_MAX = 3_066_420n;

  const H = (...xs) => BigInt(F.toObject(poseidon(xs.map((x) => F.e(x)))));

  before(async () => {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  async function goodCommitment() {
    return H(await pubkeyToField(relayer), FEE_MAX, await pubkeyToField(recipient));
  }

  it("accepts a submission whose root is known and commitment matches", async () => {
    const root = 12345n;
    const wc = await goodCommitment();
    const r = await preflight({
      poolData: makePoolData(new Map([[7, root]])),
      publicSignals: ["999", root.toString(), wc.toString()],
      relayerPubkey: relayer,
      recipientPubkey: recipient,
      relayerFeeMax: FEE_MAX,
    });
    assert.equal(r.ok, true);
  });

  it("rejects a root that is not in the pool's history", async () => {
    const wc = await goodCommitment();
    const r = await preflight({
      poolData: makePoolData(new Map([[7, 12345n]])),
      publicSignals: ["999", "88888", wc.toString()],
      relayerPubkey: relayer,
      recipientPubkey: recipient,
      relayerFeeMax: FEE_MAX,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "StaleRoot");
  });

  it("rejects a zero root (empty history slot)", async () => {
    const wc = await goodCommitment();
    const r = await preflight({
      poolData: makePoolData(),
      publicSignals: ["999", "0", wc.toString()],
      relayerPubkey: relayer,
      recipientPubkey: recipient,
      relayerFeeMax: FEE_MAX,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "StaleRoot");
  });

  it("rejects a commitment bound to a different recipient", async () => {
    const root = 12345n;
    const other = Keypair.generate().publicKey;
    const wc = H(
      await pubkeyToField(relayer),
      FEE_MAX,
      await pubkeyToField(other)
    );
    const r = await preflight({
      poolData: makePoolData(new Map([[0, root]])),
      publicSignals: ["999", root.toString(), wc.toString()],
      relayerPubkey: relayer,
      recipientPubkey: recipient,
      relayerFeeMax: FEE_MAX,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "InvalidWithdrawalCommitment");
  });

  it("rejects a commitment bound to a different relayer", async () => {
    const root = 12345n;
    const otherRelayer = Keypair.generate().publicKey;
    const wc = H(
      await pubkeyToField(otherRelayer),
      FEE_MAX,
      await pubkeyToField(recipient)
    );
    const r = await preflight({
      poolData: makePoolData(new Map([[0, root]])),
      publicSignals: ["999", root.toString(), wc.toString()],
      relayerPubkey: relayer,
      recipientPubkey: recipient,
      relayerFeeMax: FEE_MAX,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "InvalidWithdrawalCommitment");
  });

  it("rejects a commitment bound to a different fee ceiling", async () => {
    const root = 12345n;
    const wc = H(
      await pubkeyToField(relayer),
      FEE_MAX + 1n,
      await pubkeyToField(recipient)
    );
    const r = await preflight({
      poolData: makePoolData(new Map([[0, root]])),
      publicSignals: ["999", root.toString(), wc.toString()],
      relayerPubkey: relayer,
      recipientPubkey: recipient,
      relayerFeeMax: FEE_MAX,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "InvalidWithdrawalCommitment");
  });

  it("pubkeyToField matches the on-chain split-and-hash encoding", async () => {
    // Cross-implementation vector: relayer must agree with withdraw.rs and the SDK.
    const { PublicKey } = await import("@solana/web3.js");
    const pk = new PublicKey(
      Buffer.from(
        "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
        "hex"
      )
    );
    const expected = H(
      0x0102030405060708090a0b0c0d0e0f10n,
      0x1112131415161718191a1b1c1d1e1f20n
    );
    assert.equal(await pubkeyToField(pk), expected);
  });

  it("readRootHistory decodes 256 entries", () => {
    const roots = readRootHistory(makePoolData(new Map([[255, 42n]])));
    assert.equal(roots.length, 256);
    assert.equal(roots[255], 42n);
    assert.equal(roots[0], 0n);
  });
});
