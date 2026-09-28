// relayer/test/ratelimit.test.js
//
// M-5. The submit limits keyed on the exact client address. express-rate-limit 7.5.1 uses
// `request.ip` verbatim, so an IPv6 client, which is handed a /64 or larger by any VPS host, got a
// fresh bucket for every address it rotated to. The per-note limiter keyed on the raw JSON string,
// so "5", "05" and "0x5", the same field element to snarkjs, were three different notes.
//
// These limits are the only brake on submission floods, each of which costs a pairing check on the
// relayer's single thread. The tests drive the real app over HTTP with TRUST_PROXY set so the client
// address can be chosen per request through X-Forwarded-For.

import { strict as assert } from "node:assert";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/api.js";
import { rateLimitKey } from "../src/ratelimit.js";

const PROGRAM_ID = new PublicKey("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");

/** A body that passes shape validation and then fails fast at pool loading (no account). */
function body(nullifier = "12345") {
  return {
    proof: { pi_a: ["1", "2", "1"], pi_b: [["1", "2"], ["3", "4"], ["1", "0"]], pi_c: ["5", "6", "1"] },
    publicSignals: [nullifier, "2", "3"],
    poolAddress: Keypair.generate().publicKey.toBase58(),
    recipient: Keypair.generate().publicKey.toBase58(),
    relayerFeeMax: "2000000",
  };
}

async function withApp(fn) {
  const prev = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "1";
  const app = createApp({
    connection: { getAccountInfo: async () => null },
    relayerKeypair: Keypair.generate(),
    programId: PROGRAM_ID,
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  try {
    const port = server.address().port;
    const post = (ip, b) =>
      fetch(`http://127.0.0.1:${port}/submit_proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify(b),
      }).then((r) => r.status);
    return await fn(post);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prev;
  }
}

describe("M-5 — rate limits cannot be escaped by address or spelling", () => {
  it("rotating addresses inside one IPv6 /56 shares a single submit bucket", async () => {
    await withApp(async (post) => {
      const statuses = [];
      for (let i = 0; i < 7; i++) {
        // Seven addresses in 2001:db8:aa00:0000::/56, each in a different /64 (fourth group 0x00-0x06).
        statuses.push(await post(`2001:db8:aa00:${i.toString(16)}::1`, body(String(1000 + i))));
      }
      assert.deepEqual(statuses.slice(0, 5), [404, 404, 404, 404, 404], "first five reach the handler");
      assert.deepEqual(statuses.slice(5), [429, 429], "the sixth and seventh are limited");
    });
  });

  it("separate IPv6 /56 networks still get separate buckets", async () => {
    await withApp(async (post) => {
      for (let i = 0; i < 5; i++) await post("2001:db8:bb00::1", body(String(2000 + i)));
      assert.equal(await post("2001:db8:bb00::2", body("2999")), 429);
      assert.equal(await post("2001:db8:cc00::1", body("3000")), 404, "another /56 is not limited");
    });
  });

  it("IPv4 clients are keyed on the full address, and IPv4-mapped IPv6 is the same client", async () => {
    await withApp(async (post) => {
      for (let i = 0; i < 5; i++) await post("203.0.113.7", body(String(4000 + i)));
      assert.equal(await post("::ffff:203.0.113.7", body("4999")), 429, "mapped form shares the bucket");
      assert.equal(await post("203.0.113.8", body("5000")), 404, "the neighbouring IPv4 address does not");
    });
  });

  it("one note spelled three ways counts as one note", async () => {
    await withApp(async (post) => {
      // Different /56s, so only the per-note limiter can stop these.
      const spellings = ["77", "077", "0x4d", "0077"];
      const statuses = [];
      for (let i = 0; i < spellings.length; i++) {
        statuses.push(await post(`2001:db8:${(0xd000 + i).toString(16)}::1`, body(spellings[i])));
      }
      assert.deepEqual(statuses, [404, 404, 404, 429]);
    });
  });
});

describe("M-5 — rateLimitKey", () => {
  it("normalises IPv6 to its /56 and IPv4 to itself", () => {
    // A /56 fixes the first 56 bits: three groups and the high byte of the fourth. So
    // 2001:db8:aa00:00xx:… share one, and 2001:db8:aa00:01xx:… is the next /56 along.
    assert.equal(rateLimitKey("2001:db8:aa00:1::1"), rateLimitKey("2001:db8:aa00:ff:ffff:ffff:ffff:ffff"));
    assert.notEqual(rateLimitKey("2001:db8:aa00:ff::1"), rateLimitKey("2001:db8:aa00:100::1"));
    assert.notEqual(rateLimitKey("2001:db8:aa00::1"), rateLimitKey("2001:db8:ab00::1"));
    assert.equal(rateLimitKey("::ffff:198.51.100.1"), rateLimitKey("198.51.100.1"));
    assert.equal(rateLimitKey("2001:DB8:AA00::1"), rateLimitKey("2001:db8:aa00::1"));
  });

  it("never throws, whatever it is given", () => {
    for (const v of [undefined, "", "not-an-ip", "::", "1::2::3", "999.1.1.1"]) rateLimitKey(v);
  });
});
