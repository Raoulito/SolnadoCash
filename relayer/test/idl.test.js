// relayer/test/idl.test.js
//
// The relayer builds withdraw transactions from app/src/idl/solnadocash.json, the tracked copy of the
// program's IDL, because target/ is gitignored and absent on any checkout that has not run
// `anchor build`. A tracked copy can drift from the program it describes. This pins it: wherever a
// build output exists, which is every machine that can change the program, the two must be identical.

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TRACKED = join(ROOT, "app/src/idl/solnadocash.json");
const BUILT = join(ROOT, "target/idl/solnadocash.json");

describe("program IDL", () => {
  it("the tracked IDL exists and names the deployed program", () => {
    const idl = JSON.parse(readFileSync(TRACKED, "utf8"));
    assert.equal(idl.address, "DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");
    assert.ok(idl.instructions.some((i) => i.name === "withdraw"));
  });

  (existsSync(BUILT) ? it : it.skip)(
    "the tracked IDL is identical to the one `anchor build` produced",
    () => {
      assert.deepEqual(
        JSON.parse(readFileSync(TRACKED, "utf8")),
        JSON.parse(readFileSync(BUILT, "utf8")),
        "app/src/idl/solnadocash.json has drifted from target/idl. Copy the build output over it."
      );
    }
  );
});
