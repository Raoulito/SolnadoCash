"use strict";
// sdk/test/note.test.ts
// T31 — Tests for generateNote, encodeNote, decodeNote
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = require("node:assert");
const web3_js_1 = require("@solana/web3.js");
const note_js_1 = require("../src/note.js");
const BN254_FIELD_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
describe("T31 — sdk/src/note.ts", function () {
    const denomination = 1000000000n; // 1 SOL
    const poolAddress = web3_js_1.Keypair.generate().publicKey;
    describe("generateNote", () => {
        it("returns a valid SecretNote with correct fields", () => {
            const note = (0, note_js_1.generateNote)(denomination, poolAddress);
            node_assert_1.strict.equal(note.denomination, denomination);
            node_assert_1.strict.equal(note.poolAddress.toBase58(), poolAddress.toBase58());
            node_assert_1.strict.ok(note.nullifier > 0n);
            node_assert_1.strict.ok(note.secret > 0n);
            node_assert_1.strict.ok(note.nullifier < BN254_FIELD_ORDER);
            node_assert_1.strict.ok(note.secret < BN254_FIELD_ORDER);
            node_assert_1.strict.ok(note.encoded.startsWith("sndo_"));
        });
        it("generates unique notes on each call", () => {
            const a = (0, note_js_1.generateNote)(denomination, poolAddress);
            const b = (0, note_js_1.generateNote)(denomination, poolAddress);
            node_assert_1.strict.notEqual(a.nullifier, b.nullifier);
            node_assert_1.strict.notEqual(a.secret, b.secret);
            node_assert_1.strict.notEqual(a.encoded, b.encoded);
        });
        it("throws for denomination < 500 (BF-14)", () => {
            node_assert_1.strict.throws(() => (0, note_js_1.generateNote)(499n, poolAddress), /Denomination must be >= 500/);
        });
        it("accepts denomination == 500", () => {
            const note = (0, note_js_1.generateNote)(500n, poolAddress);
            node_assert_1.strict.equal(note.denomination, 500n);
        });
    });
    describe("encodeNote / decodeNote roundtrip", () => {
        it("roundtrips correctly", () => {
            const note = (0, note_js_1.generateNote)(denomination, poolAddress);
            const encoded = (0, note_js_1.encodeNote)(note);
            const decoded = (0, note_js_1.decodeNote)(encoded);
            node_assert_1.strict.equal(decoded.nullifier, note.nullifier);
            node_assert_1.strict.equal(decoded.secret, note.secret);
            node_assert_1.strict.equal(decoded.denomination, note.denomination);
            node_assert_1.strict.equal(decoded.poolAddress.toBase58(), note.poolAddress.toBase58());
            node_assert_1.strict.equal(decoded.encoded, encoded);
        });
        it("note.encoded matches encodeNote output", () => {
            const note = (0, note_js_1.generateNote)(denomination, poolAddress);
            node_assert_1.strict.equal(note.encoded, (0, note_js_1.encodeNote)(note));
        });
        it("roundtrips with various denominations", () => {
            for (const denom of [500n, 100000000n, 1000000000n, 10000000000n]) {
                const note = (0, note_js_1.generateNote)(denom, poolAddress);
                const decoded = (0, note_js_1.decodeNote)(note.encoded);
                node_assert_1.strict.equal(decoded.denomination, denom);
            }
        });
        it("roundtrips with different pool addresses", () => {
            for (let i = 0; i < 5; i++) {
                const pool = web3_js_1.Keypair.generate().publicKey;
                const note = (0, note_js_1.generateNote)(denomination, pool);
                const decoded = (0, note_js_1.decodeNote)(note.encoded);
                node_assert_1.strict.equal(decoded.poolAddress.toBase58(), pool.toBase58());
            }
        });
    });
    describe("decodeNote validation", () => {
        it("rejects missing prefix", () => {
            node_assert_1.strict.throws(() => (0, note_js_1.decodeNote)("invalid_string"), /must start with 'sndo_'/);
        });
        it("rejects wrong part count", () => {
            node_assert_1.strict.throws(() => (0, note_js_1.decodeNote)("sndo_abc"), /expected/);
        });
        it("rejects invalid pool address", () => {
            node_assert_1.strict.throws(() => (0, note_js_1.decodeNote)("sndo_notavalidpubkey_0000000000000001_" + "a".repeat(128)), /malformed pool/);
        });
        it("rejects wrong preimage length", () => {
            const pool = poolAddress.toBase58();
            node_assert_1.strict.throws(() => (0, note_js_1.decodeNote)(`sndo_${pool}_0000000000000001_${"a".repeat(100)}`), /preimage must be 128/);
        });
        it("rejects non-hex preimage", () => {
            const pool = poolAddress.toBase58();
            node_assert_1.strict.throws(() => (0, note_js_1.decodeNote)(`sndo_${pool}_0000000000000001_${"g".repeat(128)}`), /lowercase hex/);
        });
        it("rejects uppercase hex in preimage", () => {
            const pool = poolAddress.toBase58();
            node_assert_1.strict.throws(() => (0, note_js_1.decodeNote)(`sndo_${pool}_0000000000000001_${"A".repeat(128)}`), /lowercase hex/);
        });
        it("rejects nullifier >= BN254 field order", () => {
            const pool = poolAddress.toBase58();
            const bigHex = BN254_FIELD_ORDER.toString(16).padStart(64, "0");
            node_assert_1.strict.throws(() => (0, note_js_1.decodeNote)(`sndo_${pool}_0000000000000001_${bigHex}${"0".repeat(64)}`), /nullifier exceeds/);
        });
        it("rejects secret >= BN254 field order", () => {
            const pool = poolAddress.toBase58();
            const bigHex = BN254_FIELD_ORDER.toString(16).padStart(64, "0");
            node_assert_1.strict.throws(() => (0, note_js_1.decodeNote)(`sndo_${pool}_0000000000000001_${"0".repeat(64)}${bigHex}`), /secret exceeds/);
        });
        it("rejects invalid denomination hex", () => {
            const pool = poolAddress.toBase58();
            node_assert_1.strict.throws(() => (0, note_js_1.decodeNote)(`sndo_${pool}_00000000000001_${"a".repeat(128)}`), /denomination must be 16/);
        });
    });
});
