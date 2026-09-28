// relayer/test/startup.test.js
//
// L-3. The relayer must be told which key to sign with, and must refuse to be the program's
// upgrade authority. The first case starts the real entry point with RELAYER_KEYPAIR unset and a
// HOME that holds a CLI wallet: before this fix it started and signed as that wallet.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  assertNotUpgradeAuthority,
  loadRelayerKeypair,
  RelayerKeyError,
  upgradeAuthority,
} from "../src/startup.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, "../src/index.js");
const PROGRAM_ID = new PublicKey("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** Run src/index.js until it exits or 6 s pass; report what it printed and how it ended. */
function runRelayer(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INDEX], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out });
    });
  });
}

/** A connection whose program's upgrade authority is `authority` (null = immutable). */
function chainWith(authority) {
  const programData = Keypair.generate().publicKey;
  const prog = Buffer.alloc(36);
  prog.writeUInt32LE(2, 0);
  programData.toBuffer().copy(prog, 4);
  const pd = Buffer.alloc(45);
  pd.writeUInt32LE(3, 0);
  if (authority) {
    pd[12] = 1;
    authority.toBuffer().copy(pd, 13);
  }
  return {
    getAccountInfo: async (pk) =>
      pk.equals(PROGRAM_ID)
        ? { owner: LOADER, data: prog }
        : pk.equals(programData)
          ? { owner: LOADER, data: pd }
          : null,
  };
}

describe("L-3 — the relayer's signing key", function () {
  this.timeout(20_000);

  it("does not start, and never signs as the CLI wallet, when RELAYER_KEYPAIR is unset", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "relayer-home-"));
    try {
      mkdirSync(path.join(home, ".config/solana"), { recursive: true });
      const cli = Keypair.generate();
      writeFileSync(path.join(home, ".config/solana/id.json"), JSON.stringify(Array.from(cli.secretKey)));
      const env = { ...process.env, HOME: home, PORT: "0", SOLANA_RPC_URL: "http://127.0.0.1:1" };
      delete env.RELAYER_KEYPAIR;
      const r = await runRelayer(env);
      assert.ok(!r.out.includes(cli.publicKey.toBase58()), "must not load the CLI wallet");
      assert.ok(!r.out.includes("Listening"), "must not start listening");
      assert.notEqual(r.code, 0);
      assert.match(r.out, /RELAYER_KEYPAIR is not set/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("loadRelayerKeypair reads the named file and nothing else", () => {
    const kp = Keypair.generate();
    const got = loadRelayerKeypair({ RELAYER_KEYPAIR: "/k.json" }, (p) => {
      assert.equal(p, "/k.json");
      return JSON.stringify(Array.from(kp.secretKey));
    });
    assert.ok(got.publicKey.equals(kp.publicKey));
    assert.throws(() => loadRelayerKeypair({}, () => "[]"), RelayerKeyError);
    assert.throws(() => loadRelayerKeypair({ RELAYER_KEYPAIR: "/x" }, () => "not json"), RelayerKeyError);
  });

  it("reads the upgrade authority from the program's accounts", async () => {
    const auth = Keypair.generate().publicKey;
    assert.ok((await upgradeAuthority(chainWith(auth), PROGRAM_ID)).equals(auth));
    assert.equal(await upgradeAuthority(chainWith(null), PROGRAM_ID), null);
  });

  it("refuses to run as the upgrade authority", async () => {
    const auth = Keypair.generate().publicKey;
    await assert.rejects(assertNotUpgradeAuthority(chainWith(auth), PROGRAM_ID, auth), /upgrade authority/);
  });

  it("allows any other key, and an immutable program", async () => {
    const other = Keypair.generate().publicKey;
    await assertNotUpgradeAuthority(chainWith(Keypair.generate().publicKey), PROGRAM_ID, other);
    await assertNotUpgradeAuthority(chainWith(null), PROGRAM_ID, other);
  });

  it("refuses to guess when the program cannot be read", async () => {
    await assert.rejects(
      assertNotUpgradeAuthority({ getAccountInfo: async () => null }, PROGRAM_ID, Keypair.generate().publicKey),
      RelayerKeyError
    );
  });
});
