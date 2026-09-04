// relayer/test/txconfirm.test.js
//
// SEC-04. `connection.confirmTransaction` RESOLVES when a transaction is included and reverts — the
// failure arrives as `value.err` on a fulfilled promise. Awaiting it without reading the result made
// "included and reverted" indistinguishable from "included and succeeded", so the relayer returned a
// signature and HTTP 200 for a withdrawal that paid out nothing.
//
// These tests drive the real `submitWithdraw` against a stubbed connection. Only the three methods it
// calls are stubbed; instruction assembly runs for real.

import { strict as assert } from "assert";
import { Keypair, PublicKey } from "@solana/web3.js";
import { submitWithdraw } from "../src/tx.js";

const PROGRAM_ID = new PublicKey("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");
const SIG = "5".repeat(87);

/** A syntactically valid snarkjs proof. Values are never verified on this path. */
const proof = {
  pi_a: ["1", "2", "1"],
  pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
  pi_c: ["5", "6", "1"],
};
const publicSignals = ["7", "8", "9"];

function stubConnection({ err = null } = {}) {
  const calls = { sent: 0, confirmed: 0 };
  return {
    calls,
    rpcEndpoint: "http://stub",
    async getLatestBlockhash() {
      return { blockhash: "9".repeat(43), lastValidBlockHeight: 1000 };
    },
    async sendTransaction() {
      calls.sent++;
      return SIG;
    },
    async confirmTransaction() {
      calls.confirmed++;
      // Shape matters: a fulfilled promise carrying the error, exactly as web3.js returns.
      return { context: { slot: 1 }, value: { err } };
    },
    // Touched by AnchorProvider construction in some versions; harmless if unused.
    async getAccountInfo() {
      return null;
    },
  };
}

function args(connection) {
  return {
    connection,
    relayerKeypair: Keypair.generate(),
    programId: PROGRAM_ID,
    poolAddress: Keypair.generate().publicKey,
    recipientAddress: Keypair.generate().publicKey,
    treasuryAddress: Keypair.generate().publicKey,
    proof,
    publicSignals,
    relayerFeeMax: 2_000_000n,
    relayerFeeTaken: 1_452_680n,
    priorityFeePerCU: 0,
  };
}

describe("SEC-04 — submitWithdraw must detect on-chain reversion", () => {
  it("returns the signature when the transaction succeeded", async () => {
    const c = stubConnection({ err: null });
    const sig = await submitWithdraw(args(c));
    assert.equal(sig, SIG);
    assert.equal(c.calls.confirmed, 1, "confirmation must be awaited");
  });

  it("throws when the transaction reverted, instead of returning the signature", async () => {
    const c = stubConnection({
      err: { InstructionError: [2, { Custom: 6004 }] },
    });
    await assert.rejects(() => submitWithdraw(args(c)), /reverted on-chain/i);
  });

  it("includes the hex code so the API maps it to a specific client error", async () => {
    // 6004 = NullifierAlreadySpent = 0x1774, which api.js already matches on.
    const c = stubConnection({
      err: { InstructionError: [2, { Custom: 6004 }] },
    });
    await assert.rejects(() => submitWithdraw(args(c)), /0x1774/);
  });

  it("maps a stale root the same way", async () => {
    // 6003 = RootNotFound = 0x1773.
    const c = stubConnection({
      err: { InstructionError: [2, { Custom: 6003 }] },
    });
    await assert.rejects(() => submitWithdraw(args(c)), /0x1773/);
  });

  it("carries the signature on the error so a failed transaction stays inspectable", async () => {
    const c = stubConnection({
      err: { InstructionError: [2, { Custom: 6004 }] },
    });
    await submitWithdraw(args(c)).then(
      () => assert.fail("should have thrown"),
      (e) => {
        assert.equal(e.signature, SIG);
        assert.deepEqual(e.onChainError, { InstructionError: [2, { Custom: 6004 }] });
      }
    );
  });

  it("handles a non-Custom error without inventing a hex code", async () => {
    const c = stubConnection({ err: "AccountInUse" });
    await submitWithdraw(args(c)).then(
      () => assert.fail("should have thrown"),
      (e) => {
        assert.match(e.message, /AccountInUse/);
        assert.ok(!/custom error/.test(e.message));
      }
    );
  });
});
