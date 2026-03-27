"use strict";
// tests/benchmark.ts
//
// T11 + T12 — Measure CU costs for groth16_verify and 20-level Poseidon
// via simulateTransaction (returns unitsConsumed without submitting to chain).
//
// Run with:  anchor test
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const anchor = __importStar(require("@coral-xyz/anchor"));
const web3_js_1 = require("@solana/web3.js");
const MAX_CU = 1400000;
describe("CU Benchmarks (T11 + T12)", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.Solnadocash;
    // Returns unitsConsumed even if the simulation fails (e.g. invalid proof).
    async function measureCU(ixBuilder) {
        const ix = await ixBuilder.instruction();
        const budgetIx = web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({
            units: MAX_CU,
        });
        const { blockhash } = await provider.connection.getLatestBlockhash();
        const msg = new web3_js_1.TransactionMessage({
            payerKey: provider.wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: [budgetIx, ix],
        }).compileToV0Message();
        const vTx = new web3_js_1.VersionedTransaction(msg);
        const sim = await provider.connection.simulateTransaction(vTx, {
            sigVerify: false,
        });
        return {
            cu: sim.value.unitsConsumed ?? 0,
            err: sim.value.err,
            logs: sim.value.logs ?? [],
        };
    }
    it("T11 — groth16_verify CU", async () => {
        const { cu, err, logs } = await measureCU(program.methods.benchmarkGroth16());
        console.log(`\n  groth16_verify:    ${cu.toLocaleString()} CU`);
        console.log(`  budget remaining:  ${(MAX_CU - cu).toLocaleString()} CU`);
        if (err) {
            // Allowed: the dummy proof may not verify — we only measure CU.
            console.log(`  (simulation error — expected for dummy proof: ${JSON.stringify(err)})`);
        }
        if (cu === 0) {
            throw new Error(`groth16 reported 0 CU — program may not have run.\nLogs:\n${logs.join("\n")}`);
        }
        if (cu > MAX_CU) {
            throw new Error(`groth16 EXCEEDS max CU budget: ${cu} > ${MAX_CU}`);
        }
    });
    it("T12 — 20-level Poseidon CU", async () => {
        const { cu, err, logs } = await measureCU(program.methods.benchmarkPoseidon());
        console.log(`\n  20-level Poseidon: ${cu.toLocaleString()} CU`);
        console.log(`  budget remaining:  ${(MAX_CU - cu).toLocaleString()} CU`);
        if (err) {
            throw new Error(`Poseidon simulation failed unexpectedly: ${JSON.stringify(err)}\nLogs:\n${logs.join("\n")}`);
        }
        if (cu > MAX_CU) {
            throw new Error(`Poseidon EXCEEDS max CU budget: ${cu} > ${MAX_CU}`);
        }
        // T13 decision point: if poseidon > 800k CU, reduce TREE_DEPTH 20 → 16
        if (cu > 800000) {
            console.warn(`  WARNING: Poseidon > 800k CU (${cu}). ` +
                "Consider reducing TREE_DEPTH from 20 to 16 (T13).");
        }
    });
});
