#!/usr/bin/env node
// scripts/check_layout.js
//
// F-6, off-chain half.
//
// `state.rs` now fails the build if a Pool field moves, which protects the program. It does
// nothing for the other side of the boundary: the monitor, relayer, SDK, front end, scripts and
// every fuzz harness decode the same account by re-declaring the same byte offsets in their own
// source. A Rust struct change keeps all of those compiling and passing, because they hardcode
// numbers rather than deriving them.
//
// That failure mode is worse than it sounds. The monitor's whole job is to notice when
// `vault == rent + (deposits - withdrawals) * denomination` stops holding, and it reads `deposits`
// and `treasury` by offset. A layout change silently repoints the watchdog at the wrong bytes at
// exactly the moment there is something to watch for.
//
// This script makes Rust the single source of truth and checks everyone else against it. It parses
// the OFF_* constants out of state.rs — which are themselves asserted against the real struct at
// compile time — and then verifies that every named offset constant elsewhere in the repo agrees.
//
// Enforced: any declaration of the form `NAME = 8 + N` (or `DISCRIMINATOR + N`) whose name
// identifies a Pool field must equal 8 + the canonical offset of that field.
//
// Reported but not enforced: bare `8 + N` literals inline in expressions. They are matched by too
// many unrelated things to fail a build on — `8 + 72` is both `mint_decimals` and the nullifier
// account size — and a check that cries wolf gets deleted. They are printed so a reviewer can see
// what is still hand-written.
//
// Usage:
//   node scripts/check_layout.js          # exits non-zero on mismatch
//   node scripts/check_layout.js --list   # also print un-enforceable inline literals

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_RS = join(ROOT, "programs/solnadocash/src/state.rs");

// ── 1. Canonical offsets, parsed from the compile-time-verified Rust source ──────────────────

function parseCanonical() {
  const src = readFileSync(STATE_RS, "utf8");
  const offsets = new Map();
  const re = /pub const OFF_([A-Z0-9_]+):\s*usize\s*=\s*(\d+);/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    offsets.set(m[1].toLowerCase(), Number(m[2]));
  }
  const dl = /pub const DISCRIMINATOR_LEN:\s*usize\s*=\s*(\d+);/.exec(src);
  if (!dl) throw new Error(`DISCRIMINATOR_LEN not found in ${STATE_RS}`);
  if (offsets.size === 0) throw new Error(`no OFF_* constants found in ${STATE_RS}`);
  return { offsets, discriminatorLen: Number(dl[1]) };
}

const { offsets: CANONICAL, discriminatorLen: DISCR } = parseCanonical();

// Name fragments that identify a Pool field. Longest first, so CURRENT_ROOT_INDEX is tested
// before ROOT_INDEX-style substrings and ROOT_HISTORY before ROOT.
const FIELD_TOKENS = [
  ["CURRENT_ROOT_INDEX", "current_root_index"],
  ["FILLED_SUBTREES", "filled_subtrees"],
  ["ROOT_HISTORY", "root_history"],
  ["NEXT_INDEX", "next_index"],
  ["DENOMINATION", "denomination"],
  ["VAULT_BUMP", "vault_bump"],
  ["IS_PAUSED", "is_paused"],
  ["TREASURY", "treasury"],
  ["ADMIN", "admin"],
];

// A constant whose name says SIZE/LEN/COUNT is a length, not an offset.
const NOT_AN_OFFSET = /(SIZE|_LEN|LENGTH|COUNT|THRESHOLD|DEPTH|BYTES)\b/;

function fieldForName(name) {
  if (NOT_AN_OFFSET.test(name)) return null;
  for (const [token, field] of FIELD_TOKENS) {
    if (name.includes(token)) return field;
  }
  return null;
}

// ── 2. Walk the repo ────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules", ".git", "target", "build", "dist", ".anchor", "coverage",
  ".keypairs", "proptest-regressions", "test-ledger",
]);
const EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".rs"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(extname(p))) out.push(p);
  }
  return out;
}

// `NAME = 8 + N;` / `pub const NAME: usize = 8 + N;` / `NAME = DISCRIMINATOR + N;`
const DECL = /(?:pub\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[A-Za-z0-9_:<>\[\]; ]+?\s*)?=\s*(?:8|DISCRIMINATOR|DISCRIMINATOR_LEN)\s*\+\s*(\d+)\s*[;,]/g;

// Bare `8 + N` not preceded by another digit, so `(128 + 80)` does not match.
const INLINE = /(?<![0-9])8\s*\+\s*(\d+)/g;

const problems = [];
const checked = [];
const inline = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (rel === "scripts/check_layout.js") continue;
  const src = readFileSync(file, "utf8");

  DECL.lastIndex = 0;
  let m;
  while ((m = DECL.exec(src)) !== null) {
    const [, name, nStr] = m;
    const field = fieldForName(name);
    if (!field) continue;
    const declared = Number(nStr);
    const expected = CANONICAL.get(field);
    if (expected === undefined) {
      problems.push(`${rel}: ${name} names field '${field}', which is not in state.rs`);
      continue;
    }
    const line = src.slice(0, m.index).split("\n").length;
    if (declared !== expected) {
      problems.push(
        `${rel}:${line}: ${name} = ${DISCR} + ${declared}, but state.rs has ` +
          `OFF_${field.toUpperCase()} = ${expected} (expected ${DISCR} + ${expected})`
      );
    } else {
      checked.push(`${rel}:${line} ${name} -> ${field} @ ${expected}`);
    }
  }

  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(src)) !== null) {
    const line = src.slice(0, m.index).split("\n").length;
    inline.push(`${rel}:${line}  8 + ${m[1]}`);
  }
}

// ── 3. Report ───────────────────────────────────────────────────────────────────────────────

const fields = [...CANONICAL.entries()].sort((a, b) => a[1] - b[1]);
console.log(`canonical layout from programs/solnadocash/src/state.rs (discriminator ${DISCR}):`);
for (const [f, o] of fields) {
  console.log(`  ${f.padEnd(20)} struct+${String(o).padStart(4)}   account+${o + DISCR}`);
}

console.log(`\nnamed offset declarations verified: ${checked.length}`);
for (const c of checked) console.log(`  ok  ${c}`);

if (process.argv.includes("--list")) {
  console.log(`\ninline literals, not enforced (${inline.length}):`);
  for (const i of inline) console.log(`  ??  ${i}`);
} else {
  console.log(`\ninline literals, not enforced: ${inline.length} (run with --list to see them)`);
}

if (problems.length > 0) {
  console.error(`\nLAYOUT DRIFT — ${problems.length} mismatch(es):`);
  for (const p of problems) console.error(`  FAIL  ${p}`);
  console.error(
    "\nstate.rs is the source of truth and is asserted against the Pool struct at compile time.\n" +
      "Update the off-chain constants above to match it."
  );
  process.exit(1);
}

console.log("\nOK: every named off-chain offset matches the on-chain layout.");
