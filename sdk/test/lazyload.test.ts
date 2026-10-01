// sdk/test/lazyload.test.ts
//
// circomlibjs and snarkjs are loaded on first use (see the top of src/proof.ts). These check the
// behaviour that change must keep: importing the SDK does not load either library, concurrent
// initPoseidon() calls build the hasher once, and the hash is the same Poseidon as before.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("lazy loading of the proving and hashing libraries", function () {
  this.timeout(60_000);

  it("the compiled module imports neither library at load time", () => {
    const src = readFileSync(path.join(HERE, "../src/proof.ts"), "utf8");
    assert.doesNotMatch(src, /^import[^;]*from\s+["']circomlibjs["']/m);
    assert.doesNotMatch(src, /^import[^;]*from\s+["']snarkjs["']/m);
    assert.match(src, /import\("circomlibjs"\)/);
    assert.match(src, /import\("snarkjs"\)/);
  });

  it("concurrent initPoseidon calls share one build and hash correctly", async () => {
    // A fresh copy of the module (the query string makes it a separate module instance), so the
    // result does not depend on whether an earlier test file already built Poseidon.
    const { initPoseidon, poseidonHash } = await import(`../src/proof.ts?fresh=${Date.now()}`);
    const calls = [initPoseidon(), initPoseidon(), initPoseidon()];
    assert.equal(new Set(calls).size, 1, "all callers get the same in-flight promise");
    await Promise.all(calls);
    // Poseidon(1, 2) over BN254, the circomlib reference test vector.
    assert.equal(
      poseidonHash(1n, 2n),
      7853200120776062878684798364095072458815029376092732009249414926327459813530n
    );
    // Once built, it resolves immediately without a new build.
    await initPoseidon();
  });
});
