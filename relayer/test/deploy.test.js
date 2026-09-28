// relayer/test/deploy.test.js
//
// What the relayer must do before it can run on a server behind a reverse proxy.
//
// 1. It printed "RPC: <SOLANA_RPC_URL>" at startup. Hosted RPC URLs carry the API key in the query
//    (Helius: ?api-key=...) or in the path (some providers), so under systemd the key went into the
//    journal, readable by every member of the adm group and kept across reboots.
// 2. It listened on every interface. Behind Caddy it must be reachable on loopback only, so the
//    rate limits and origin checks that Caddy's forwarding relies on cannot be bypassed by talking to
//    the port directly. HOST now sets the bind address.
//
// Both are tested against the real entry point, started against a fake JSON-RPC endpoint that
// answers the upgrade-authority check, so startup runs all the way to listening.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, "../src/index.js");
const PROGRAM_ID = new PublicKey("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SECRET = "k3y-THAT-MUST-NOT-BE-LOGGED";

/** A JSON-RPC endpoint whose program has an upgrade authority that is not the relayer. */
function fakeRpc() {
  const programData = Keypair.generate().publicKey;
  const prog = Buffer.alloc(36);
  prog.writeUInt32LE(2, 0);
  programData.toBuffer().copy(prog, 4);
  const pd = Buffer.alloc(45);
  pd.writeUInt32LE(3, 0);
  pd[12] = 1;
  Keypair.generate().publicKey.toBuffer().copy(pd, 13);
  const account = (data) => ({
    data: [data.toString("base64"), "base64"],
    executable: false,
    lamports: 1_000_000_000,
    owner: LOADER,
    rentEpoch: 0,
    space: data.length,
  });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      const ctx = { context: { slot: 1 } };
      let result;
      if (method === "getAccountInfo") {
        const key = params[0];
        result = { ...ctx, value: key === PROGRAM_ID.toBase58() ? account(prog) : key === programData.toBase58() ? account(pd) : null };
      } else if (method === "getBalance") {
        result = { ...ctx, value: 1_000_000_000 };
      } else {
        result = null;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Start src/index.js; resolve once it is listening (or has exited), with its output so far. */
function startRelayer(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [INDEX], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ child, out });
    };
    const onData = (d) => {
      out += d;
      if (/Listening/.test(out)) setTimeout(finish, 200); // let the rest of the banner print
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", finish);
    const timer = setTimeout(finish, 10_000);
  });
}

const canConnect = (host, port) =>
  new Promise((resolve) => {
    const s = connect({ host, port }, () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
    s.setTimeout(2000, () => (s.destroy(), resolve(false)));
  });

describe("deploying behind a reverse proxy", function () {
  this.timeout(30_000);
  let rpc, dir, keyPath;

  before(async () => {
    rpc = await fakeRpc();
    dir = mkdtempSync(path.join(tmpdir(), "relayer-deploy-"));
    keyPath = path.join(dir, "relayer.json");
    writeFileSync(keyPath, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  });
  after(() => {
    rpc?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const baseEnv = () => {
    const env = {
      ...process.env,
      PORT: "0",
      RELAYER_KEYPAIR: keyPath,
      // The key in both places providers put it: the query string and the path.
      SOLANA_RPC_URL: `http://127.0.0.1:${rpc.address().port}/${SECRET}/?api-key=${SECRET}`,
    };
    delete env.HOST;
    return env;
  };

  it("never prints the RPC URL's key, in the path or the query", async () => {
    const { child, out } = await startRelayer(baseEnv());
    child.kill("SIGKILL");
    assert.match(out, /Listening/, `the relayer did not start:\n${out}`);
    assert.ok(!out.includes(SECRET), `the RPC key reached the log:\n${out}`);
    assert.match(out, /RPC: http:\/\/127\.0\.0\.1:\d+/, "the RPC origin is still logged, for diagnosis");
  });

  it("binds to HOST when it is set, and is then unreachable on other interfaces", async () => {
    const { child, out } = await startRelayer({ ...baseEnv(), HOST: "127.0.0.1" });
    try {
      const m = out.match(/Listening on 127\.0\.0\.1:(\d+)/);
      assert.ok(m, `expected "Listening on 127.0.0.1:<port>", got:\n${out}`);
      const port = Number(m[1]);
      assert.equal(await canConnect("127.0.0.1", port), true);
      const external = Object.values(networkInterfaces())
        .flat()
        .find((i) => i && i.family === "IPv4" && !i.internal);
      if (external) assert.equal(await canConnect(external.address, port), false, `reachable on ${external.address}`);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
