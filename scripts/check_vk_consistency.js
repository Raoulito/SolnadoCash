#!/usr/bin/env node
"use strict";

/**
 * scripts/check_vk_consistency.js
 *
 * Verifies that programs/solnadocash/src/vk.rs was generated from
 * circuits/build/withdraw_vk.json (M-7).
 *
 * These two must never drift: the program verifies proofs with vk.rs while the
 * relayer validates them off-chain with withdraw_vk.json. If they disagree, the
 * relayer accepts proofs the chain rejects (wasting relayer funds on every
 * submission) or rejects proofs the chain would have accepted (silently censoring
 * withdrawals). Neither failure is visible without a check like this.
 *
 * Usage:  node scripts/check_vk_consistency.js
 * Exit:   0 = consistent, 1 = drift or missing files
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const VK_JSON = path.join(REPO, "circuits/build/withdraw_vk.json");
const VK_RS = path.join(REPO, "programs/solnadocash/src/vk.rs");
const CONVERTER = path.join(__dirname, "convert_vk_to_rust.js");

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(VK_JSON)) {
  fail(
    `${path.relative(REPO, VK_JSON)} is missing. It is committed to the repo — if you deleted it, restore it with git checkout.`
  );
}
if (!fs.existsSync(VK_RS)) fail(`${path.relative(REPO, VK_RS)} is missing.`);

const vk = JSON.parse(fs.readFileSync(VK_JSON, "utf8"));

// Structural checks first — they give clearer errors than a byte diff.
if (vk.protocol !== "groth16") fail(`expected protocol groth16, got ${vk.protocol}`);
if (vk.curve !== "bn128") fail(`expected curve bn128, got ${vk.curve}`);
if (vk.nPublic !== 3) {
  fail(
    `expected 3 public inputs [nullifierHash, root, withdrawalCommitment], got ${vk.nPublic}`
  );
}
if (vk.IC.length !== vk.nPublic + 1) {
  fail(`expected ${vk.nPublic + 1} IC points, got ${vk.IC.length}`);
}

const rs = fs.readFileSync(VK_RS, "utf8");
const declared = rs.match(/nr_pubinputs:\s*(\d+)/);
if (!declared) fail("could not find nr_pubinputs in vk.rs");
if (Number(declared[1]) !== vk.nPublic) {
  fail(`vk.rs declares nr_pubinputs ${declared[1]} but the key has ${vk.nPublic}`);
}

// Authoritative check: regenerate and compare, ignoring comments and whitespace.
const regenerated = execFileSync("node", [CONVERTER, VK_JSON], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

const normalise = (s) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();

if (normalise(regenerated) !== normalise(rs)) {
  fail(
    "vk.rs does not match circuits/build/withdraw_vk.json.\n" +
      "  The on-chain verifying key and the relayer's key have drifted.\n" +
      "  Regenerate with:\n" +
      "    node scripts/convert_vk_to_rust.js circuits/build/withdraw_vk.json > programs/solnadocash/src/vk.rs"
  );
}

console.log("OK: vk.rs matches circuits/build/withdraw_vk.json");
console.log(`  protocol=${vk.protocol} curve=${vk.curve} nPublic=${vk.nPublic}`);
console.log("  public inputs: [nullifierHash, root, withdrawalCommitment]");
