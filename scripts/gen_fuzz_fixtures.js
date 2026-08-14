#!/usr/bin/env node
"use strict";

/**
 * scripts/gen_fuzz_fixtures.js
 *
 * Pre-generates valid Groth16 withdrawal proofs for the LiteSVM sequence fuzzer.
 *
 * Why fixtures: LiteSVM executes the real syscalls (so Poseidon and BN254 work) but it
 * cannot GENERATE a proof — that needs snarkjs and the proving key. Without fixtures a
 * LiteSVM fuzzer can only ever drive failing withdrawals, which is the same blind spot
 * Trident had. So proofs are generated once here and replayed by the fuzzer.
 *
 * How the roots stay valid: every proof is generated against the root AFTER all N
 * fixture commitments are inserted. The fuzzer therefore deposits those N commitments
 * first, in this exact order, and may then withdraw any subset in any order — the root
 * remains in the pool's 256-entry history until 256 further deposits rotate it out, and
 * the fuzzer stays well under that.
 *
 * The relayer keypair is embedded because the relayer must sign the withdrawal and its
 * pubkey is bound inside the proof. It is a throwaway key generated here for tests only
 * and holds nothing.
 *
 * Usage: node scripts/gen_fuzz_fixtures.js [count]
 * Output: litesvm-tests/fixtures/withdrawals.json
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const snarkjs = require("snarkjs");
const { Keypair } = require("@solana/web3.js");

const COUNT = parseInt(process.argv[2] || "12", 10);
const DENOMINATION = 1_000_000_000n;
const TREE_DEPTH = 20;
const RELAYER_FEE = 83_000n;
const Fr =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const Fq =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

const BUILD = path.join(__dirname, "../circuits/build");
const WASM = path.join(BUILD, "withdraw_js/withdraw.wasm");
const ZKEY = path.join(BUILD, "withdraw_final.zkey");
const OUT_DIR = path.join(__dirname, "../litesvm-tests/fixtures");
const OUT = path.join(OUT_DIR, "withdrawals.json");

let poseidon, F;
const ph = (...xs) => BigInt(F.toObject(poseidon(xs.map((x) => F.e(x)))));
const hex32 = (n) => n.toString(16).padStart(64, "0");
const randField = () => {
  for (;;) {
    let v = 0n;
    for (const b of crypto.randomBytes(32)) v = (v << 8n) | BigInt(b);
    if (v < Fr) return v;
  }
};
function pkToField(pk) {
  const b = pk.toBytes();
  let hi = 0n, lo = 0n;
  for (let i = 0; i < 16; i++) hi = (hi << 8n) | BigInt(b[i]);
  for (let i = 16; i < 32; i++) lo = (lo << 8n) | BigInt(b[i]);
  return ph(hi, lo);
}

class Tree {
  constructor(depth) {
    this.depth = depth;
    this.zeros = [0n];
    for (let i = 1; i <= depth; i++) this.zeros[i] = ph(this.zeros[i - 1], this.zeros[i - 1]);
    this.layers = Array.from({ length: depth + 1 }, () => []);
  }
  at(l, i) {
    return i < this.layers[l].length ? this.layers[l][i] : this.zeros[l];
  }
  insert(leaf) {
    const idx = this.layers[0].length;
    this.layers[0].push(leaf);
    let cur = idx;
    for (let l = 1; l <= this.depth; l++) {
      const p = cur >> 1;
      const v = ph(this.at(l - 1, p * 2), this.at(l - 1, p * 2 + 1));
      if (p < this.layers[l].length) this.layers[l][p] = v;
      else this.layers[l].push(v);
      cur = p;
    }
    return idx;
  }
  proof(i) {
    const els = [], idxs = [];
    let cur = i;
    for (let l = 0; l < this.depth; l++) {
      const right = cur % 2 === 1;
      idxs.push(right ? 1 : 0);
      els.push(this.at(l, right ? cur - 1 : cur + 1));
      cur >>= 1;
    }
    return { els, idxs, root: this.at(this.depth, 0) };
  }
}

async function main() {
  if (!fs.existsSync(WASM) || !fs.existsSync(ZKEY)) {
    console.error("ERROR: circuit artifacts missing. Run scripts/trusted_setup.sh.");
    process.exit(1);
  }
  const { buildPoseidon } = require("circomlibjs");
  poseidon = await buildPoseidon();
  F = poseidon.F;

  const relayer = Keypair.generate();
  const relayerField = pkToField(relayer.publicKey);

  // Notes and their commitments, in insertion order.
  const notes = [];
  const tree = new Tree(TREE_DEPTH);
  for (let i = 0; i < COUNT; i++) {
    const n = randField(), s = randField();
    const commitment = ph(n, s, DENOMINATION);
    const leaf = tree.insert(commitment);
    notes.push({ n, s, commitment, leaf, recipient: Keypair.generate().publicKey });
  }
  const finalRoot = tree.proof(0).root;

  console.log(`Generating ${COUNT} proofs against the root after all ${COUNT} deposits...`);
  const withdrawals = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const { els, idxs, root } = tree.proof(note.leaf);
    if (root !== finalRoot) throw new Error("root drift between proofs");
    const recipientField = pkToField(note.recipient);
    const wc = ph(relayerField, RELAYER_FEE, recipientField);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      {
        nullifierHash: ph(note.n).toString(),
        root: root.toString(),
        withdrawalCommitment: wc.toString(),
        nullifier: note.n.toString(),
        secret: note.s.toString(),
        denomination: DENOMINATION.toString(),
        pathElements: els.map(String),
        pathIndices: idxs.map(String),
        recipient: recipientField.toString(),
        relayerAddress: relayerField.toString(),
        relayerFeeMax: RELAYER_FEE.toString(),
      },
      WASM,
      ZKEY
    );
    // Sanity-check each proof before shipping it as a fixture.
    const vk = JSON.parse(fs.readFileSync(path.join(BUILD, "withdraw_vk.json"), "utf8"));
    if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) {
      throw new Error(`proof ${i} failed self-verification`);
    }
    withdrawals.push({
      nullifierHash: hex32(BigInt(publicSignals[0])),
      root: hex32(BigInt(publicSignals[1])),
      withdrawalCommitment: hex32(BigInt(publicSignals[2])),
      proofA: hex32(BigInt(proof.pi_a[0])) + hex32(Fq - BigInt(proof.pi_a[1])),
      proofB:
        hex32(BigInt(proof.pi_b[0][1])) + hex32(BigInt(proof.pi_b[0][0])) +
        hex32(BigInt(proof.pi_b[1][1])) + hex32(BigInt(proof.pi_b[1][0])),
      proofC: hex32(BigInt(proof.pi_c[0])) + hex32(BigInt(proof.pi_c[1])),
      recipient: note.recipient.toBase58(),
      relayerFeeMax: RELAYER_FEE.toString(),
    });
    process.stdout.write(`  proof ${i + 1}/${COUNT}\r`);
  }
  console.log("");

  const fixture = {
    _comment:
      "Generated by scripts/gen_fuzz_fixtures.js for litesvm-tests. The relayer key is a " +
      "throwaway used only to sign test withdrawals; it holds nothing. Proofs are bound to " +
      "the root after ALL commitments are inserted, so the fuzzer must deposit them in this " +
      "exact order before withdrawing.",
    denomination: DENOMINATION.toString(),
    treeDepth: TREE_DEPTH,
    relayerFee: RELAYER_FEE.toString(),
    relayerSecretKey: Array.from(relayer.secretKey),
    relayerPubkey: relayer.publicKey.toBase58(),
    commitments: notes.map((n) => hex32(n.commitment)),
    rootAfterAllDeposits: hex32(finalRoot),
    withdrawals,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(fixture, null, 1));
  console.log(`Wrote ${withdrawals.length} proofs to ${path.relative(process.cwd(), OUT)}`);
  console.log(`Root after all deposits: ${fixture.rootAfterAllDeposits}`);
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
