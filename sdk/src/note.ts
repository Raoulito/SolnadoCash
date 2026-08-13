// sdk/src/note.ts
// T31 — generateNote, encodeNote, decodeNote per Section 12.5

import { PublicKey } from "@solana/web3.js";

// BN254 scalar field prime (Fr) — Poseidon and circuits operate over this field
const BN254_FIELD_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const NOTE_PREFIX = "sndo_";

export interface SecretNote {
  encoded: string; // "sndo_<pool>_<denomHex>_<nullifierHex><secretHex>"
  nullifier: bigint;
  secret: bigint;
  denomination: bigint; // pool denomination in lamports
  poolAddress: PublicKey;
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Fill a buffer with cryptographically secure random bytes (L-2).
 *
 * This is the single most security-critical operation in the protocol: these bytes
 * ARE the note, and anyone who can predict them can steal the deposit.
 *
 * Previously this used Node's `crypto.randomBytes`, which in the browser resolved
 * through vite-plugin-node-polyfills → crypto-browserify → randombytes. That chain
 * does end at `crypto.getRandomValues`, but it made note secrecy depend on bundler
 * configuration: a polyfill misconfiguration, a swapped shim, or a bundler that
 * stubs the module would silently degrade the RNG with no visible error.
 *
 * Now the Web Crypto API is called directly — available natively in browsers and in
 * Node >= 19 via globalThis.crypto — with an explicit throw if it is unavailable
 * rather than any fallback. There is no safe fallback for this.
 */
function secureRandomBytes(length: number): Uint8Array {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (!g.crypto || typeof g.crypto.getRandomValues !== "function") {
    throw new Error(
      "No cryptographically secure random number generator available. " +
        "A secret note must never be generated without one. Use a modern browser " +
        "or Node.js >= 19."
    );
  }
  const bytes = new Uint8Array(length);
  g.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Uniform random element of the BN254 scalar field (L-1).
 *
 * The previous implementation returned `random256Bits % Fr`, which is biased: with
 * 2^256 = 5*Fr + r, the r values below the remainder are reachable 6 ways while the
 * rest are reachable 5, so the low ~29% of the field is 20% more likely. That leaves
 * ~253.7 bits of entropy rather than ~254 — not exploitable, but the wrong shape for
 * the value that secures the deposit, and free to fix.
 *
 * Rejection sampling instead: draw 32 bytes, discard anything >= Fr, retry. Fr is
 * ~0.19 of 2^256, so the rejection probability per draw is ~19% and the expected
 * number of draws is ~1.23. The loop is bounded purely to make an impossible RNG
 * failure loud rather than infinite.
 */
function randomFieldElement(): bigint {
  for (let attempt = 0; attempt < 128; attempt++) {
    const bytes = secureRandomBytes(32);
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    if (n < BN254_FIELD_ORDER) return n;
  }
  // P(reaching here with a working RNG) < 0.19^128 ≈ 10^-92.
  throw new Error(
    "Failed to sample a field element in 128 attempts — the random number generator is broken"
  );
}

function bigintToHex64(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

function hex64ToBigint(hex: string): bigint {
  if (hex.length !== 64) throw new Error("Invalid hex length");
  return BigInt("0x" + hex);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a fresh secret note for a deposit.
 * The note contains two random field elements (nullifier, secret) plus
 * the pool metadata needed to reconstruct the commitment later.
 */
export function generateNote(
  denomination: bigint,
  poolAddress: PublicKey
): SecretNote {
  if (denomination < 500n) {
    throw new Error("Denomination must be >= 500 lamports (BF-14)");
  }

  const nullifier = randomFieldElement();
  const secret = randomFieldElement();

  const note: SecretNote = {
    encoded: "",
    nullifier,
    secret,
    denomination,
    poolAddress,
  };
  note.encoded = encodeNote(note);
  return note;
}

/**
 * Encode a SecretNote into a copyable string.
 * Format: sndo_<poolBase58>_<denomHex16>_<nullifierHex64><secretHex64>
 */
export function encodeNote(note: SecretNote): string {
  const poolB58 = note.poolAddress.toBase58();
  const denomHex = note.denomination.toString(16).padStart(16, "0");
  const nullHex = bigintToHex64(note.nullifier);
  const secretHex = bigintToHex64(note.secret);
  return `${NOTE_PREFIX}${poolB58}_${denomHex}_${nullHex}${secretHex}`;
}

/**
 * Decode a note string back into a SecretNote.
 * Throws if the string is malformed or contains invalid field elements.
 */
export function decodeNote(encoded: string): SecretNote {
  if (!encoded.startsWith(NOTE_PREFIX)) {
    throw new Error("Invalid note: must start with 'sndo_'");
  }

  const body = encoded.slice(NOTE_PREFIX.length);
  const parts = body.split("_");
  if (parts.length !== 3) {
    throw new Error(
      "Invalid note format: expected sndo_<pool>_<denom>_<preimage>"
    );
  }

  const [poolB58, denomHex, preimage] = parts;

  // Validate pool address
  let poolAddress: PublicKey;
  try {
    poolAddress = new PublicKey(poolB58);
  } catch {
    throw new Error("Invalid note: malformed pool address");
  }

  // Validate denomination (16 hex chars = 8 bytes = u64)
  if (denomHex.length !== 16 || !/^[0-9a-f]+$/.test(denomHex)) {
    throw new Error("Invalid note: denomination must be 16 lowercase hex chars");
  }
  const denomination = BigInt("0x" + denomHex);

  // Validate preimage (nullifier 64 + secret 64 = 128 hex chars)
  if (preimage.length !== 128) {
    throw new Error("Invalid note: preimage must be 128 hex chars");
  }
  if (!/^[0-9a-f]+$/.test(preimage)) {
    throw new Error("Invalid note: preimage must be lowercase hex");
  }

  const nullifier = hex64ToBigint(preimage.slice(0, 64));
  const secret = hex64ToBigint(preimage.slice(64));

  // Field element bounds check
  if (nullifier >= BN254_FIELD_ORDER) {
    throw new Error("Invalid note: nullifier exceeds BN254 field order");
  }
  if (secret >= BN254_FIELD_ORDER) {
    throw new Error("Invalid note: secret exceeds BN254 field order");
  }

  return {
    encoded,
    nullifier,
    secret,
    denomination,
    poolAddress,
  };
}
