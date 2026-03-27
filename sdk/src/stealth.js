"use strict";
// sdk/src/stealth.ts
// T33 — Stealth address generation and recovery for unlinkable withdrawals
//
// Protocol: ECDH on Ed25519 + hash-to-seed
//
//   Sender (has scan_pub, spend_pub):
//     1. eph = random Ed25519 keypair
//     2. shared = eph_scalar * scan_point        (ECDH on Ed25519)
//     3. stealth_seed = SHA-256(shared || spend_pub)
//     4. stealth = Keypair.fromSeed(stealth_seed)
//     5. publish eph.publicKey
//
//   Recipient (has scan_priv, spend_pub, eph_pub):
//     1. shared = scan_scalar * eph_point         (same ECDH, reverse)
//     2. stealth_seed = SHA-256(shared || spend_pub)
//     3. stealth = Keypair.fromSeed(stealth_seed)
//
// Limitation: scan key alone can derive the stealth private key (no true
// scan/spend separation). This is inherent to Ed25519's seed-based signing —
// there's no way to add scalars and produce a valid Solana Keypair. For
// SolnadoCash, users set scanKey = spendKey. The ephemeral key provides
// the unlinkability between the user's wallet and the withdrawal address.
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateStealthAddress = generateStealthAddress;
exports.recoverStealthKeypair = recoverStealthKeypair;
exports.isMyStealthAddress = isMyStealthAddress;
const web3_js_1 = require("@solana/web3.js");
const ed25519_js_1 = require("@noble/curves/ed25519.js");
const sha2_js_1 = require("@noble/hashes/sha2.js");
const Point = ed25519_js_1.ed25519.Point;
// ── Internal helpers ────────────────────────────────────────────────────────
/** Extract the Ed25519 scalar from a 32-byte seed via noble-curves. */
function privToScalar(seed) {
    return ed25519_js_1.ed25519.utils.getExtendedPublicKey(seed).scalar;
}
/** Convert Uint8Array to hex string. */
function bytesToHex(bytes) {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
/** ECDH on Ed25519: scalar * point → compressed 32-byte shared secret. */
function ecdh(privSeed, pubBytes) {
    const scalar = privToScalar(privSeed);
    const point = Point.fromHex(bytesToHex(pubBytes));
    const shared = point.multiply(scalar);
    return shared.toBytes();
}
/** Derive a deterministic stealth seed from the ECDH shared point + spend pubkey. */
function deriveStealthSeed(sharedPointBytes, spendPubBytes) {
    const combined = new Uint8Array(sharedPointBytes.length + spendPubBytes.length);
    combined.set(sharedPointBytes);
    combined.set(spendPubBytes, sharedPointBytes.length);
    return (0, sha2_js_1.sha256)(combined);
}
// ── Public API ──────────────────────────────────────────────────────────────
/**
 * Generate a stealth address for a recipient.
 *
 * The sender calls this with the recipient's scan and spend public keys.
 * The returned ephemeralKey.publicKey must be published so the recipient
 * can recover the stealth keypair.
 *
 * For SOL pools, stealth addresses are optional (withdraw to any address).
 * For SPL pools, the stealth address is the ATA owner wallet.
 */
function generateStealthAddress(scanPubkey, spendPubkey) {
    // 1. Generate ephemeral keypair
    const ephSeed = ed25519_js_1.ed25519.utils.randomSecretKey();
    const ephKeypair = web3_js_1.Keypair.fromSeed(ephSeed);
    // 2. ECDH: shared = eph_scalar * scan_point
    const sharedBytes = ecdh(ephSeed, scanPubkey.toBytes());
    // 3. Derive stealth seed from shared secret + spend pubkey
    const stealthSeed = deriveStealthSeed(sharedBytes, spendPubkey.toBytes());
    // 4. Generate stealth keypair
    const stealthKeypair = web3_js_1.Keypair.fromSeed(stealthSeed);
    return {
        stealthAddress: stealthKeypair.publicKey,
        ephemeralKey: ephKeypair,
    };
}
/**
 * Recover the stealth keypair (recipient side).
 *
 * The recipient uses their scan private key seed and the ephemeral public key
 * (published by the sender) to derive the same stealth keypair.
 *
 * @param scanSeed - 32-byte Ed25519 private key seed for the scan key
 * @param spendPubkey - The recipient's spend public key
 * @param ephemeralPubkey - The ephemeral public key published by the sender
 * @returns The stealth Keypair (can sign transactions from the stealth address)
 */
function recoverStealthKeypair(scanSeed, spendPubkey, ephemeralPubkey) {
    // 1. ECDH: shared = scan_scalar * eph_point (same shared secret, reverse)
    const sharedBytes = ecdh(scanSeed, ephemeralPubkey.toBytes());
    // 2. Same stealth seed derivation
    const stealthSeed = deriveStealthSeed(sharedBytes, spendPubkey.toBytes());
    // 3. Recover keypair
    return web3_js_1.Keypair.fromSeed(stealthSeed);
}
/**
 * Check if a stealth address belongs to you (scanning).
 *
 * Given an ephemeral public key from an announcement, compute the expected
 * stealth address and compare. Does not require the spend private key.
 */
function isMyStealthAddress(scanSeed, spendPubkey, ephemeralPubkey, candidateAddress) {
    const recovered = recoverStealthKeypair(scanSeed, spendPubkey, ephemeralPubkey);
    return recovered.publicKey.equals(candidateAddress);
}
