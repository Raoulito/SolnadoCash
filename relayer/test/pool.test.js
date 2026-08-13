// relayer/test/pool.test.js
// N-2 — the relayer must not treat an arbitrary account as a pool.
//
// Attack it defends against: the caller names an account they control, writes a Merkle
// root they chose at the root-history offset, and supplies a genuinely valid Groth16
// proof built against their own tree. The proof check and preflight both pass, the
// relayer signs and pays, and the transaction dies on-chain at the pool ownership
// check — burning the relayer's fee on every attempt.

import { strict as assert } from "node:assert";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  loadPool,
  POOL_DISCRIMINATOR,
  POOL_ACCOUNT_LEN,
} from "../src/pool.js";

const PROGRAM_ID = new PublicKey("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");

/** A connection that returns whatever account we describe. */
function mockConnection(account) {
  return { getAccountInfo: async () => account };
}

/** A well-formed pool account owned by the program. */
function realPool({ denomination = 1_000_000_000n, treasury = Keypair.generate().publicKey } = {}) {
  const data = Buffer.alloc(POOL_ACCOUNT_LEN);
  POOL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(denomination, 8 + 64);
  treasury.toBuffer().copy(data, 8 + 88);
  return { owner: PROGRAM_ID, data };
}

describe("N-2 — pool account validation", () => {
  it("accepts a genuine program-owned pool", async () => {
    const treasury = Keypair.generate().publicKey;
    const r = await loadPool(
      mockConnection(realPool({ treasury })),
      PROGRAM_ID,
      Keypair.generate().publicKey
    );
    assert.equal(r.ok, true);
    assert.equal(r.denomination, 1_000_000_000n);
    assert.equal(new PublicKey(r.treasury).toBase58(), treasury.toBase58());
  });

  it("rejects an attacker-owned account with a forged pool layout", async () => {
    // The exploit: correct length, correct discriminator, attacker-chosen contents —
    // but owned by someone else. Only the ownership check catches this.
    const forged = realPool();
    forged.owner = Keypair.generate().publicKey; // attacker's own program/wallet
    const r = await loadPool(
      mockConnection(forged),
      PROGRAM_ID,
      Keypair.generate().publicKey
    );
    assert.equal(r.ok, false);
    assert.equal(r.error, "NotAPool");
    assert.match(r.message, /not the SolnadoCash program/);
  });

  it("rejects a program-owned account that is not a Pool", async () => {
    // Vaults and nullifier accounts are also program-owned. Only the discriminator
    // distinguishes them, and reading pool offsets out of a nullifier account would
    // yield an attacker-influenced 'denomination' and 'treasury'.
    const notPool = { owner: PROGRAM_ID, data: Buffer.alloc(POOL_ACCOUNT_LEN) };
    notPool.data.writeUInt8(0xff, 0); // wrong discriminator
    const r = await loadPool(
      mockConnection(notPool),
      PROGRAM_ID,
      Keypair.generate().publicKey
    );
    assert.equal(r.ok, false);
    assert.equal(r.error, "NotAPool");
    assert.match(r.message, /discriminator/);
  });

  it("rejects a truncated account instead of reading past its end", async () => {
    const short = { owner: PROGRAM_ID, data: Buffer.alloc(64) };
    POOL_DISCRIMINATOR.copy(short.data, 0);
    const r = await loadPool(
      mockConnection(short),
      PROGRAM_ID,
      Keypair.generate().publicKey
    );
    assert.equal(r.ok, false);
    assert.equal(r.error, "NotAPool");
    assert.match(r.message, /bytes, expected/);
  });

  it("rejects a system-owned account (the cheapest forgery)", async () => {
    // An attacker can create an account of any size with the System program and write
    // arbitrary bytes into it. This is the cheapest way to mount the attack.
    const sysOwned = realPool();
    sysOwned.owner = SystemProgram.programId;
    const r = await loadPool(
      mockConnection(sysOwned),
      PROGRAM_ID,
      Keypair.generate().publicKey
    );
    assert.equal(r.ok, false);
    assert.equal(r.error, "NotAPool");
  });

  it("reports a missing account distinctly from an invalid one", async () => {
    const r = await loadPool(
      mockConnection(null),
      PROGRAM_ID,
      Keypair.generate().publicKey
    );
    assert.equal(r.ok, false);
    assert.equal(r.error, "PoolNotFound");
    assert.equal(r.status, 404);
  });

  it("discriminator matches the on-chain constant", () => {
    // Must equal POOL_DISCRIMINATOR in programs/solnadocash/src/withdraw.rs, or the
    // relayer would reject every real pool.
    assert.equal(
      POOL_DISCRIMINATOR.toString("hex"),
      "f19a6d0411b16dbc"
    );
  });
});
