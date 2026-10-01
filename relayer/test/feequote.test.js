// relayer/test/feequote.test.js
//
// /fee_quote computed the relayer's cost, then called computeRelayerFeeMax, which computed the cost
// again: two getRecentPrioritizationFees round trips per quote, and two different snapshots. The
// first decided whether the pool can be served at all, the second set the ceiling bound into the
// user's proof, so under moving fees the ceiling could disagree with the cost the relayer had just
// checked. The quote now uses one snapshot for both, which also halves the RPC calls a quote costs
// (each one counts against the RPC quota, and the endpoint is public).

import { strict as assert } from "node:assert";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/api.js";
import { POOL_DISCRIMINATOR } from "../src/pool.js";
import { BASE_FEE, MARGIN, priorityFeeLamports } from "../src/fees.js";

const PROGRAM_ID = new PublicKey("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");
const RENT = 1_447_680;
const DENOMINATION = 1_000_000_000n;

/** A connection whose priority fee rises on every query, recording how often it is asked. */
function risingFeeConnection() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    getRecentPrioritizationFees: async () => {
      calls += 1;
      // 10 slots of the same fee; the fee doubles with every query (10k, 20k, ... uL/CU).
      const fee = 10_000 * 2 ** (calls - 1);
      return Array.from({ length: 10 }, (_, i) => ({ slot: i, prioritizationFee: fee }));
    },
    getMinimumBalanceForRentExemption: async () => RENT,
    getAccountInfo: async () => {
      const data = Buffer.alloc(8976);
      POOL_DISCRIMINATOR.copy(data, 0);
      data.writeBigUInt64LE(DENOMINATION, 72);
      Keypair.generate().publicKey.toBytes().forEach((b, i) => (data[96 + i] = b));
      return { data, owner: PROGRAM_ID };
    },
  };
}

async function quote(connection) {
  const app = createApp({ connection, relayerKeypair: Keypair.generate(), programId: PROGRAM_ID });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  try {
    const pool = Keypair.generate().publicKey.toBase58();
    const res = await fetch(`http://127.0.0.1:${server.address().port}/fee_quote?pool=${pool}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe("GET /fee_quote uses one fee snapshot", () => {
  it("queries the priority fee once per quote", async () => {
    const conn = risingFeeConnection();
    const res = await quote(conn);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(conn.calls, 1);
  });

  it("derives the ceiling from the same snapshot as the cost it checked", async () => {
    const conn = risingFeeConnection();
    const res = await quote(conn);
    // The first (and only) snapshot is 10,000 uL/CU.
    const cost = BASE_FEE + priorityFeeLamports(10_000) + RENT;
    const expected = BigInt(Math.ceil(cost * MARGIN));
    const cap = DENOMINATION / 50n;
    assert.equal(BigInt(res.body.relayerFeeMax), expected < cap ? expected : cap);
  });
});
