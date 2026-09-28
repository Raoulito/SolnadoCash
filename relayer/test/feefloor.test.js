// relayer/test/feefloor.test.js
//
// H-3. /submit_proof took the fee ceiling from the request and never compared it with what the
// relayer would spend. A ceiling of 0 bound into a genuine proof went straight through: the relayer
// signed, paid the signature fee and 1,447,680 lamports of nullifier rent that is locked forever by
// design, and took nothing back. Pools are permissionless, so an attacker who owns the pool also
// recovers the treasury fee and loses only their own deposit's transaction fee per round, roughly
// 290 lamports drained for every 1 they spend. The only warning was a console line.
//
// These tests use GENUINE proofs, generated here with the proving artifacts the app ships, so every
// check before the fee floor (pool validation, preflight, off-chain verification) passes for real.
// A test that could only fail at preflight or verification would not show that the floor is the
// thing standing between the request and a signed transaction.

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { createApp } from "../src/api.js";
import { POOL_DISCRIMINATOR, POOL_ACCOUNT_LEN } from "../src/pool.js";
import { pubkeyToField } from "../src/preflight.js";
import { BASE_FEE } from "../src/fees.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The artifacts the browser ships, tracked in git and pinned to the deployed verifier by
// app/src/circuitArtifacts.test.ts. circuits/build is gitignored, so it cannot be relied on here.
const WASM = path.join(HERE, "../../app/public/circuits/withdraw.wasm");
const ZKEY = path.join(HERE, "../../app/public/circuits/withdraw_final.zkey");

const PROGRAM_ID = new PublicKey("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");
const RENT = 1_447_680;
const FLOOR = BigInt(BASE_FEE + RENT);
const DENOMINATION = 1_000_000_000n;
const CAP = DENOMINATION / 50n;
const OFF_DENOMINATION = 8 + 64;
const OFF_NEXT_INDEX = 8 + 80;
const OFF_TREASURY = 8 + 88;
const OFF_ROOT_HISTORY = 8 + 136;

let poseidon;
let F;
const hash = (...xs) => F.toObject(poseidon(xs));
const be32 = (v) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");

/** A one-deposit pool whose root history holds that deposit's root, and a genuine proof for it. */
async function genuineWithdrawal({ relayer, recipient, feeMax }) {
  const nullifier = 11n + BigInt(Math.floor(Math.random() * 1e9));
  const secret = 7n + BigInt(Math.floor(Math.random() * 1e9));
  const leaf = hash(nullifier, secret, DENOMINATION);

  // Leaf at index 0: every sibling is the empty subtree of its level.
  const pathElements = [];
  let zero = 0n;
  let node = leaf;
  for (let i = 0; i < 20; i++) {
    pathElements.push(zero);
    node = hash(node, zero);
    zero = hash(zero, zero);
  }
  const root = node;

  const withdrawalCommitment = hash(
    await pubkeyToField(relayer),
    feeMax,
    await pubkeyToField(recipient)
  );
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      nullifierHash: hash(nullifier).toString(),
      root: root.toString(),
      withdrawalCommitment: withdrawalCommitment.toString(),
      nullifier: nullifier.toString(),
      secret: secret.toString(),
      denomination: DENOMINATION.toString(),
      pathElements: pathElements.map(String),
      pathIndices: Array(20).fill("0"),
      recipient: (await pubkeyToField(recipient)).toString(),
      relayerAddress: (await pubkeyToField(relayer)).toString(),
      relayerFeeMax: feeMax.toString(),
    },
    WASM,
    ZKEY
  );

  const data = Buffer.alloc(POOL_ACCOUNT_LEN);
  POOL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(DENOMINATION, OFF_DENOMINATION);
  data.writeBigUInt64LE(1n, OFF_NEXT_INDEX);
  Keypair.generate().publicKey.toBuffer().copy(data, OFF_TREASURY);
  be32(root).copy(data, OFF_ROOT_HISTORY + 32);
  return { proof, publicSignals, poolData: data };
}

/** Every method the submit route touches, with a counter on the one that costs the relayer money. */
function stubConnection(poolPubkey, poolData) {
  const calls = { sent: 0 };
  return {
    calls,
    rpcEndpoint: "http://stub",
    async getAccountInfo(pk) {
      // The pool, and nothing else: the nullifier PDA does not exist, so the note is unspent.
      return pk.equals(poolPubkey) ? { owner: PROGRAM_ID, data: poolData, lamports: 1 } : null;
    },
    async getBalance() {
      return 10_000_000_000;
    },
    async getRecentPrioritizationFees() {
      return [];
    },
    async getMinimumBalanceForRentExemption() {
      return RENT;
    },
    async getLatestBlockhash() {
      return { blockhash: "9".repeat(43), lastValidBlockHeight: 1000 };
    },
    async sendTransaction() {
      calls.sent++;
      return "5".repeat(87);
    },
    async confirmTransaction() {
      return { context: { slot: 1 }, value: { err: null } };
    },
  };
}

async function post(app, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/submit_proof`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        resolve({ status: res.status, body: await res.json() });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

/** Submit a genuine proof bound to `feeMax`, sending `sent` as the request's relayerFeeMax. */
async function submitGenuine(feeMax, sent = feeMax.toString()) {
  const relayerKeypair = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const poolPubkey = Keypair.generate().publicKey;
  const w = await genuineWithdrawal({ relayer: relayerKeypair.publicKey, recipient, feeMax });
  const connection = stubConnection(poolPubkey, w.poolData);
  const app = createApp({ connection, relayerKeypair, programId: PROGRAM_ID });
  const res = await post(app, {
    proof: w.proof,
    publicSignals: w.publicSignals,
    poolAddress: poolPubkey.toBase58(),
    recipient: recipient.toBase58(),
    relayerFeeMax: sent,
  });
  return { res, sent: connection.calls.sent };
}

describe("H-3 — the relayer never signs a withdrawal that does not reimburse it", function () {
  this.timeout(120_000);

  before(async () => {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  after(async () => {
    // snarkjs keeps a worker pool alive on this global; without this mocha never exits.
    if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
  });

  it("refuses a genuine proof whose ceiling is 0, and sends nothing", async () => {
    const { res, sent } = await submitGenuine(0n);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "RelayerFeeBelowCost");
    assert.equal(res.body.minimum, FLOOR.toString());
    assert.equal(sent, 0, "the relayer must not sign or pay for this withdrawal");
  });

  it("refuses a ceiling one lamport below its cost", async () => {
    const { res, sent } = await submitGenuine(FLOOR - 1n);
    assert.equal(res.body.error, "RelayerFeeBelowCost");
    assert.equal(sent, 0);
  });

  it("serves a ceiling exactly at its cost, and charges exactly that", async () => {
    const { res, sent } = await submitGenuine(FLOOR);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.feeTaken, FLOOR.toString());
    assert.equal(sent, 1);
  });

  it("refuses a ceiling above the on-chain 2% cap before building anything", async () => {
    const { res, sent } = await submitGenuine(CAP + 1n);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "RelayerFeeMaxTooHigh");
    assert.equal(sent, 0);
  });
});

describe("H-3 — relayerFeeMax must be stated exactly", () => {
  // Checked before any RPC or proof work, so a junk proof is enough here.
  const junk = {
    proof: { pi_a: ["1", "2", "1"], pi_b: [["1", "2"], ["3", "4"], ["1", "0"]], pi_c: ["5", "6", "1"] },
    publicSignals: ["1", "2", "3"],
    poolAddress: Keypair.generate().publicKey.toBase58(),
    recipient: Keypair.generate().publicKey.toBase58(),
  };
  const app = () =>
    createApp({
      connection: stubConnection(Keypair.generate().publicKey, Buffer.alloc(0)),
      relayerKeypair: Keypair.generate(),
      programId: PROGRAM_ID,
    });

  it("rejects a request with no ceiling rather than guessing the one in the proof", async () => {
    const res = await post(app(), junk);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "InvalidRelayerFeeMax");
  });

  for (const bad of ["", "0x10", "1.5", "-5", " 5", "1e6", "18446744073709551616", 2_000_000, null, true]) {
    it(`rejects relayerFeeMax ${JSON.stringify(bad)}`, async () => {
      const res = await post(app(), { ...junk, relayerFeeMax: bad });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "InvalidRelayerFeeMax");
    });
  }
});
