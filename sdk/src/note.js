"use strict";
// sdk/src/note.ts
// T31 — generateNote, encodeNote, decodeNote per Section 12.5
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateNote = generateNote;
exports.encodeNote = encodeNote;
exports.decodeNote = decodeNote;
const web3_js_1 = require("@solana/web3.js");
const crypto_1 = require("crypto");
// BN254 scalar field prime (Fr) — Poseidon and circuits operate over this field
const BN254_FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const NOTE_PREFIX = "sndo_";
// ── Internal helpers ────────────────────────────────────────────────────────
function randomFieldElement() {
    const bytes = (0, crypto_1.randomBytes)(32);
    let n = 0n;
    for (const b of bytes)
        n = (n << 8n) | BigInt(b);
    return n % BN254_FIELD_ORDER;
}
function bigintToHex64(n) {
    return n.toString(16).padStart(64, "0");
}
function hex64ToBigint(hex) {
    if (hex.length !== 64)
        throw new Error("Invalid hex length");
    return BigInt("0x" + hex);
}
// ── Public API ──────────────────────────────────────────────────────────────
/**
 * Generate a fresh secret note for a deposit.
 * The note contains two random field elements (nullifier, secret) plus
 * the pool metadata needed to reconstruct the commitment later.
 */
function generateNote(denomination, poolAddress) {
    if (denomination < 500n) {
        throw new Error("Denomination must be >= 500 lamports (BF-14)");
    }
    const nullifier = randomFieldElement();
    const secret = randomFieldElement();
    const note = {
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
function encodeNote(note) {
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
function decodeNote(encoded) {
    if (!encoded.startsWith(NOTE_PREFIX)) {
        throw new Error("Invalid note: must start with 'sndo_'");
    }
    const body = encoded.slice(NOTE_PREFIX.length);
    const parts = body.split("_");
    if (parts.length !== 3) {
        throw new Error("Invalid note format: expected sndo_<pool>_<denom>_<preimage>");
    }
    const [poolB58, denomHex, preimage] = parts;
    // Validate pool address
    let poolAddress;
    try {
        poolAddress = new web3_js_1.PublicKey(poolB58);
    }
    catch {
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
