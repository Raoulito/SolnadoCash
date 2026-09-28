// relayer/test/pending.test.js
//
// L-2. Two submissions of the same note, arriving together, must not both be signed.
//
// The pending-nullifier guard was checked on arrival but only taken after several awaits (pool
// load, fee RPCs, balance, preflight, proof verification), so parallel requests all passed the
// check before any of them took the guard. It was also keyed on the raw JSON string, so "5", "05"
// and "0x5", the same note to snarkjs and the program, were three notes. Every duplicate that
// passes is signed and sent: the first lands, the rest revert, and the relayer pays for each.
//
// A genuine proof is used, so every check up to the send passes for real, and the stubbed
// connection counts sendTransaction calls.

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { createApp } from "../src/api.js";
import { POOL_DISCRIMINATOR, POOL_ACCOUNT_LEN } from "../src/pool.js";
import { pubkeyToField } from "../src/preflight.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(HERE, "../../app/public/circuits/withdraw.wasm");
const ZKEY = path.join(HERE, "../../app/public/circuits/withdraw_final.zkey");
const PROGRAM_ID = new PublicKey("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");
const DENOMINATION = 1_000_000_000n;
const FEE_MAX = 2_000_000n;

let poseidon, F;
const hash = (...xs) => F.toObject(poseidon(xs));
const be32 = (v) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");

describe("L-2 — one note is sent at most once, however it is spelled", function () {
  this.timeout(120_000);
  let fixture;

  before(async () => {
    poseidon = await buildPoseidon();
    F = poseidon.F;
    const relayer = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    const nullifier = 12345n, secret = 67890n;
    let node = hash(nullifier, secret, DENOMINATION), zero = 0n;
    const pathElements = [];
    for (let i = 0; i < 20; i++) { pathElements.push(zero); node = hash(node, zero); zero = hash(zero, zero); }
    const { proof, publicSignals } = await snarkjs.groth16.fullProve({
      nullifierHash: hash(nullifier).toString(), root: node.toString(),
      withdrawalCommitment: hash(await pubkeyToField(relayer.publicKey), FEE_MAX, await pubkeyToField(recipient)).toString(),
      nullifier: nullifier.toString(), secret: secret.toString(), denomination: DENOMINATION.toString(),
      pathElements: pathElements.map(String), pathIndices: Array(20).fill("0"),
      recipient: (await pubkeyToField(recipient)).toString(),
      relayerAddress: (await pubkeyToField(relayer.publicKey)).toString(), relayerFeeMax: FEE_MAX.toString(),
    }, WASM, ZKEY);
    const data = Buffer.alloc(POOL_ACCOUNT_LEN);
    POOL_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(DENOMINATION, 8 + 64);
    data.writeBigUInt64LE(1n, 8 + 80);
    Keypair.generate().publicKey.toBuffer().copy(data, 8 + 88);
    be32(node).copy(data, 8 + 136 + 32);
    fixture = { relayer, recipient, proof, publicSignals, poolData: data, pool: Keypair.generate().publicKey };
  });

  after(async () => {
    if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
  });

  async function submitAll(spellings) {
    const calls = { sent: 0 };
    const { relayer, recipient, proof, publicSignals, poolData, pool } = fixture;
    const connection = {
      rpcEndpoint: "http://stub",
      // Every read yields to the event loop, as a real RPC does, so parallel requests interleave.
      getAccountInfo: async (pk) => { await new Promise((r) => setTimeout(r, 5)); return pk.equals(pool) ? { owner: PROGRAM_ID, data: poolData, lamports: 1 } : null; },
      getBalance: async () => 10_000_000_000,
      getRecentPrioritizationFees: async () => [],
      getMinimumBalanceForRentExemption: async () => 1_447_680,
      getLatestBlockhash: async () => ({ blockhash: "9".repeat(43), lastValidBlockHeight: 1000 }),
      sendTransaction: async () => { calls.sent++; await new Promise((r) => setTimeout(r, 50)); return "5".repeat(87); },
      confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
    };
    const app = createApp({ connection, relayerKeypair: relayer, programId: PROGRAM_ID });
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    try {
      const port = server.address().port;
      const statuses = await Promise.all(spellings.map((first) =>
        fetch(`http://127.0.0.1:${port}/submit_proof`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proof, publicSignals: [first, publicSignals[1], publicSignals[2]],
            poolAddress: pool.toBase58(), recipient: recipient.toBase58(), relayerFeeMax: FEE_MAX.toString() }),
        }).then((r) => r.status)));
      return { statuses, sent: calls.sent };
    } finally {
      server.close();
    }
  }

  it("two identical submissions in parallel: one is sent, the other refused", async () => {
    const h = fixture.publicSignals[0];
    const { statuses, sent } = await submitAll([h, h]);
    assert.equal(sent, 1, `sent ${sent} transactions for one note`);
    assert.deepEqual(statuses.slice().sort(), [200, 409]);
  });

  it("the same note in three spellings, in parallel, is sent once", async () => {
    const h = BigInt(fixture.publicSignals[0]);
    const { sent } = await submitAll([h.toString(), "0" + h.toString(), "0x" + h.toString(16)]);
    assert.equal(sent, 1, `sent ${sent} transactions for one note`);
  });
});
