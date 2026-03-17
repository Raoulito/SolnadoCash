// relayer/test/api.test.js
// Smoke tests for the relayer REST API (no on-chain interaction)

import { strict as assert } from "node:assert";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/api.js";

// Minimal mock connection
function mockConnection(balance = 10_000_000_000) {
  return {
    getBalance: async () => balance,
    getRecentPrioritizationFees: async () => [],
    getAccountInfo: async (pubkey) => {
      // Return a mock pool account with denomination = 1 SOL at offset 72
      const data = Buffer.alloc(8976);
      // denomination at offset 8 + 64 = 72 (after discriminator)
      data.writeBigUInt64LE(1_000_000_000n, 72);
      // treasury at offset 8 + 88 = 96
      const treasury = Keypair.generate().publicKey;
      treasury.toBytes().forEach((b, i) => (data[96 + i] = b));
      return { data, owner: new PublicKey("11111111111111111111111111111111") };
    },
  };
}

function makeApp(conn) {
  const relayerKeypair = Keypair.generate();
  const programId = new PublicKey(
    "DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59"
  );
  return createApp({
    connection: conn,
    relayerKeypair,
    programId,
  });
}

// Simple HTTP request helper using Node's built-in fetch
async function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const port = server.address().port;
      try {
        const opts = { method };
        if (body) {
          opts.headers = { "Content-Type": "application/json" };
          opts.body = JSON.stringify(body);
        }
        const res = await fetch(`http://127.0.0.1:${port}${path}`, opts);
        const json = await res.json();
        resolve({ status: res.status, body: json });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

describe("API routes", () => {
  describe("GET /health", () => {
    it("returns status ok with balance", async () => {
      const app = makeApp(mockConnection());
      const res = await request(app, "GET", "/health");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "ok");
      assert.equal(res.body.balance, "10000000000");
      assert.equal(typeof res.body.pendingTxCount, "number");
    });
  });

  describe("GET /fee_quote", () => {
    it("returns fee quote for valid pool", async () => {
      const pool = Keypair.generate().publicKey.toBase58();
      const app = makeApp(mockConnection());
      const res = await request(app, "GET", `/fee_quote?pool=${pool}`);
      assert.equal(res.status, 200);
      assert.ok(res.body.relayerAddress);
      assert.ok(res.body.relayerFeeMax);
      assert.ok(res.body.estimatedUserReceives);
      assert.ok(res.body.denomination);
    });

    it("returns 400 for missing pool", async () => {
      const app = makeApp(mockConnection());
      const res = await request(app, "GET", "/fee_quote");
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "MissingPoolAddress");
    });

    it("returns 400 for invalid pool address", async () => {
      const app = makeApp(mockConnection());
      const res = await request(app, "GET", "/fee_quote?pool=invalid");
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "InvalidPoolAddress");
    });
  });

  describe("POST /submit_proof", () => {
    it("returns 400 for missing fields", async () => {
      const app = makeApp(mockConnection());
      const res = await request(app, "POST", "/submit_proof", {});
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "MissingFields");
    });

    it("returns 400 for invalid public signals length", async () => {
      const app = makeApp(mockConnection());
      const res = await request(app, "POST", "/submit_proof", {
        proof: { pi_a: ["0", "0"], pi_b: [["0", "0"], ["0", "0"]], pi_c: ["0", "0"] },
        publicSignals: ["1", "2"], // should be 3
        poolAddress: Keypair.generate().publicKey.toBase58(),
        recipient: Keypair.generate().publicKey.toBase58(),
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "InvalidPublicSignals");
    });
  });
});
