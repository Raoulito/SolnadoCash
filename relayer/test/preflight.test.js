// relayer/test/preflight.test.js
// M-4 — pre-flight validation against on-chain state.

import { strict as assert } from "node:assert";
import { Keypair, PublicKey } from "@solana/web3.js";
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

const PROGRAM_ID = new PublicKey("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");
const POOL_PUBKEY = Keypair.generate().publicKey;

/**
 * Connection stub for the SEC-05 spent-note check.
 *
 * `data` mirrors the on-chain condition: the program's guard is `data_is_empty()`, so an account
 * holding lamports with zero data is NOT spent.
 */
function stubConnection(account) {
  return {
    calls: 0,
    async getAccountInfo() {
      this.calls++;
      if (account === "throw") throw new Error("RPC 429");
      return account;
    },
  };
}

const spentAccount = { lamports: 1_447_680, data: Buffer.alloc(80), owner: PROGRAM_ID };
const preFundedOnly = { lamports: 890_880, data: Buffer.alloc(0), owner: PROGRAM_ID };

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

  // ── SEC-05 ────────────────────────────────────────────────────────────────────
  //
  // A spent proof stays valid arithmetic forever and its root lingers in the 256-entry ring, so a
  // completed withdrawal's payload can be lifted off the chain and replayed. Checks 1 and 2 both pass
  // for a replay, which sent it on to the Groth16 pairing check — the most expensive operation the
  // relayer performs, on the same thread as everything else.

  it("SEC-05: rejects a note already spent on-chain", async () => {
    const root = 12345n;
    const wc = await goodCommitment();
    const conn = stubConnection(spentAccount);
    const r = await preflight({
      poolData: makePoolData(new Map([[7, root]])),
      publicSignals: ["999", root.toString(), wc.toString()],
      relayerPubkey: relayer,
      recipientPubkey: recipient,
      relayerFeeMax: FEE_MAX,
      connection: conn,
      programId: PROGRAM_ID,
      poolPubkey: POOL_PUBKEY,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "NullifierSpent");
    assert.equal(conn.calls, 1, "must actually query the chain");
  });

  it("SEC-05: accepts an unspent note", async () => {
    const root = 12345n;
    const wc = await goodCommitment();
    const r = await preflight({
      poolData: makePoolData(new Map([[7, root]])),
      publicSignals: ["999", root.toString(), wc.toString()],
      relayerPubkey: relayer,
      recipientPubkey: recipient,
      relayerFeeMax: FEE_MAX,
      connection: stubConnection(null),
      programId: PROGRAM_ID,
      poolPubkey: POOL_PUBKEY,
    });
    assert.equal(r.ok, true);
  });

  // This is the case that makes the check match the program rather than merely resemble it.
  it("SEC-05: a pre-funded PDA with no data is NOT spent (H-1 griefing must not resurface)", async () => {
    const root = 12345n;
    const wc = await goodCommitment();
    const r = await preflight({
      poolData: makePoolData(new Map([[7, root]])),
      publicSignals: ["999", root.toString(), wc.toString()],
      relayerPubkey: relayer,
      recipientPubkey: recipient,
      relayerFeeMax: FEE_MAX,
      connection: stubConnection(preFundedOnly),
      programId: PROGRAM_ID,
      poolPubkey: POOL_PUBKEY,
    });
    assert.equal(r.ok, true, "lamports without data must not read as spent");
  });

  it("SEC-05: fails OPEN when the RPC lookup errors", async () => {
    // The program enforces double-spending regardless, so a failed lookup must not become a
    // withdrawal outage — that would be a worse denial of service than the one being prevented.
    const root = 12345n;
    const wc = await goodCommitment();
    const r = await preflight({
      poolData: makePoolData(new Map([[7, root]])),
      publicSignals: ["999", root.toString(), wc.toString()],
      relayerPubkey: relayer,
      recipientPubkey: recipient,
      relayerFeeMax: FEE_MAX,
      connection: stubConnection("throw"),
      programId: PROGRAM_ID,
      poolPubkey: POOL_PUBKEY,
    });
    assert.equal(r.ok, true);
  });

  it("SEC-05: does not query the chain when a cheaper local check already failed", async () => {
    // The nullifier check is last precisely so malformed traffic costs no RPC round trip.
    const conn = stubConnection(spentAccount);
    const r = await preflight({
      poolData: makePoolData(new Map([[7, 12345n]])),
      publicSignals: ["999", "88888", "1"], // stale root
      relayerPubkey: relayer,
      recipientPubkey: recipient,
      relayerFeeMax: FEE_MAX,
      connection: conn,
      programId: PROGRAM_ID,
      poolPubkey: POOL_PUBKEY,
    });
    assert.equal(r.error, "StaleRoot");
    assert.equal(conn.calls, 0);
  });
});
