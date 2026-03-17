// tests/benchmark.ts
//
// T11 + T12 — Measure CU costs for groth16_verify and 20-level Poseidon
// via simulateTransaction (returns unitsConsumed without submitting to chain).
//
// Run with:  anchor test

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Solnadocash } from "../target/types/solnadocash";

const MAX_CU = 1_400_000;

describe("CU Benchmarks (T11 + T12)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Solnadocash as Program<Solnadocash>;

  // Returns unitsConsumed even if the simulation fails (e.g. invalid proof).
  async function measureCU(
    ixBuilder: anchor.MethodsBuilder<Solnadocash, any>
  ): Promise<{ cu: number; err: any; logs: string[] }> {
    const ix = await ixBuilder.instruction();

    const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: MAX_CU,
    });

    const { blockhash } = await provider.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: provider.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [budgetIx, ix],
    }).compileToV0Message();

    const vTx = new VersionedTransaction(msg);
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
    const { cu, err, logs } = await measureCU(
      program.methods.benchmarkGroth16()
    );

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
    const { cu, err, logs } = await measureCU(
      program.methods.benchmarkPoseidon()
    );

    console.log(`\n  20-level Poseidon: ${cu.toLocaleString()} CU`);
    console.log(`  budget remaining:  ${(MAX_CU - cu).toLocaleString()} CU`);
    if (err) {
      throw new Error(
        `Poseidon simulation failed unexpectedly: ${JSON.stringify(err)}\nLogs:\n${logs.join("\n")}`
      );
    }
    if (cu > MAX_CU) {
      throw new Error(`Poseidon EXCEEDS max CU budget: ${cu} > ${MAX_CU}`);
    }
    // T13 decision point: if poseidon > 800k CU, reduce TREE_DEPTH 20 → 16
    if (cu > 800_000) {
      console.warn(
        `  WARNING: Poseidon > 800k CU (${cu}). ` +
          "Consider reducing TREE_DEPTH from 20 to 16 (T13)."
      );
    }
  });
});
