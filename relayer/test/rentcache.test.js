// relayer/test/rentcache.test.js
//
// The nullifier rent is read from the chain and cached per connection. It was cached forever, and a
// failed lookup cached the hardcoded fallback forever too. Rent does change: on 2026-10-01 both devnet
// and mainnet charge 1,056,640 lamports for the 80-byte nullifier account, where the fallback
// constant still said 1,447,680. So one RPC hiccup at the first quote fixed every later quote at the
// old figure until the relayer restarted, over-charging each withdrawal by 391,040 lamports, and a
// future rent rise would have had the relayer under-charging and paying the difference itself.

import { strict as assert } from "node:assert";
import { getNullifierRent, NULLIFIER_RENT } from "../src/fees.js";

function connection(answers) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    getMinimumBalanceForRentExemption: async () => {
      const a = answers[Math.min(calls++, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

describe("nullifier rent cache", () => {
  it("does not keep a failed lookup: the next quote reads the chain again", async () => {
    const c = connection([new Error("rate limited"), 1_056_640]);
    assert.equal(await getNullifierRent(c), NULLIFIER_RENT);
    assert.equal(await getNullifierRent(c), 1_056_640);
    assert.equal(c.calls, 2);
  });

  it("re-reads the chain once the cached value is ten minutes old", async () => {
    let now = 1_000_000;
    const clock = () => now;
    const c = connection([1_447_680, 1_056_640]);
    assert.equal(await getNullifierRent(c, clock), 1_447_680);
    now += 9 * 60_000;
    assert.equal(await getNullifierRent(c, clock), 1_447_680, "still fresh: cached");
    now += 2 * 60_000;
    assert.equal(await getNullifierRent(c, clock), 1_056_640, "stale: read again");
    assert.equal(c.calls, 2);
  });

  it("prefers the last value read from the chain over the constant when a refresh fails", async () => {
    let now = 0;
    const c = connection([1_056_640, new Error("down")]);
    assert.equal(await getNullifierRent(c, () => now), 1_056_640);
    now += 11 * 60_000;
    assert.equal(await getNullifierRent(c, () => now), 1_056_640);
  });

  it("the fallback is the 80-byte rent under the current rent parameters", () => {
    // Rent sysvar on devnet and mainnet, read 2026-10-01: 5,080 lamports per byte-year, exemption
    // threshold 1 year. Minimum for 80 bytes of data: (128 + 80) x 5,080.
    assert.equal(NULLIFIER_RENT, (128 + 80) * 5080);
  });
});
