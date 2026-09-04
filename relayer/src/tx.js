// relayer/src/tx.js
// T27 — Atomic withdraw transaction builder (BF-43)
//
// Builds and submits the withdraw instruction on behalf of the user.
// The relayer is the signer and pays for the nullifier PDA rent.

import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDL_PATH = join(__dirname, "../../target/idl/solnadocash.json");

import { COMPUTE_UNITS as COMPUTE_UNIT_LIMIT } from "./fees.js";

const BN254_Fq =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

// ── Helpers ──────────────────────────────────────────────────────────────────

function bigIntToBytes32(n) {
  const hex = n.toString(16).padStart(64, "0");
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

/**
 * Convert snarkjs proof to byte arrays for the on-chain instruction.
 * - proof_a: G1 with y-coordinate negated mod Fq (required by groth16-solana)
 * - proof_b: G2 in EIP-197 ordering (x_im || x_re || y_im || y_re)
 * - proof_c: G1 standard
 */
function snarkjsProofToBytes(proof) {
  const proofA = Buffer.concat([
    bigIntToBytes32(BigInt(proof.pi_a[0])),
    bigIntToBytes32(BN254_Fq - BigInt(proof.pi_a[1])),
  ]);
  const proofB = Buffer.concat([
    bigIntToBytes32(BigInt(proof.pi_b[0][1])),
    bigIntToBytes32(BigInt(proof.pi_b[0][0])),
    bigIntToBytes32(BigInt(proof.pi_b[1][1])),
    bigIntToBytes32(BigInt(proof.pi_b[1][0])),
  ]);
  const proofC = Buffer.concat([
    bigIntToBytes32(BigInt(proof.pi_c[0])),
    bigIntToBytes32(BigInt(proof.pi_c[1])),
  ]);
  return { proofA, proofB, proofC };
}

// ── PDA derivation ───────────────────────────────────────────────────────────

export function findNullifierPda(poolPda, nullifierHash, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), poolPda.toBytes(), nullifierHash],
    programId
  );
}

export function findVaultPda(poolPda, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), poolPda.toBytes()],
    programId
  );
}

// ── Transaction builder ──────────────────────────────────────────────────────

/**
 * Build and submit a withdraw transaction.
 *
 * @param {object} params
 * @param {Connection} params.connection - Solana RPC connection
 * @param {Keypair} params.relayerKeypair - Relayer signer keypair
 * @param {PublicKey} params.programId - SolnadoCash program ID
 * @param {PublicKey} params.poolAddress - Pool PDA address
 * @param {PublicKey} params.recipientAddress - Recipient wallet
 * @param {PublicKey} params.treasuryAddress - Treasury wallet (read from pool)
 * @param {object} params.proof - snarkjs Groth16 proof
 * @param {string[]} params.publicSignals - [nullifierHash, root, withdrawalCommitment]
 * @param {bigint} params.relayerFeeMax - Max fee committed in proof
 * @param {bigint} params.relayerFeeTaken - Actual fee the relayer takes (<= max)
 * @param {number} [params.priorityFeePerCU] - Priority fee in micro-lamports per CU.
 *   Must match what was charged in relayerFeeTaken (H-3).
 * @returns {Promise<string>} Transaction signature
 */
export async function submitWithdraw({
  connection,
  relayerKeypair,
  programId,
  poolAddress,
  recipientAddress,
  treasuryAddress,
  proof,
  publicSignals,
  relayerFeeMax,
  relayerFeeTaken,
  priorityFeePerCU = 0,
}) {
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  const wallet = new anchor.Wallet(relayerKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl, provider);

  // Derive PDAs
  const nullifierHash = bigIntToBytes32(BigInt(publicSignals[0]));
  const [nullifierPda] = findNullifierPda(poolAddress, nullifierHash, programId);
  const [vaultPda] = findVaultPda(poolAddress, programId);

  // Convert proof
  const { proofA, proofB, proofC } = snarkjsProofToBytes(proof);

  const withdrawArgs = {
    proofA: Array.from(proofA),
    proofB: Array.from(proofB),
    proofC: Array.from(proofC),
    nullifierHash: Array.from(nullifierHash),
    root: Array.from(bigIntToBytes32(BigInt(publicSignals[1]))),
    withdrawalCommitment: Array.from(
      bigIntToBytes32(BigInt(publicSignals[2]))
    ),
    relayerFeeMax: new BN(relayerFeeMax.toString()),
    relayerFeeTaken: new BN(relayerFeeTaken.toString()),
  };

  // Build the instruction
  const ix = await program.methods
    .withdraw(withdrawArgs)
    .accountsPartial({
      pool: poolAddress,
      vault: vaultPda,
      nullifierPda: nullifierPda,
      recipient: recipientAddress,
      treasury: treasuryAddress,
      relayer: relayerKeypair.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // Build versioned transaction with compute budget.
  // The priority fee is quoted to the user in lamports via computeRelayerFeeMax,
  // so it must actually be attached — otherwise the relayer charges for a
  // priority fee it never pays (H-3). setComputeUnitPrice takes micro-lamports
  // per CU, the same unit getRecentPrioritizationFees reports.
  const budgetIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
  ];
  if (priorityFeePerCU > 0) {
    budgetIxs.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFeePerCU,
      })
    );
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const msg = new TransactionMessage({
    payerKey: relayerKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [...budgetIxs, ix],
  }).compileToV0Message();

  const vTx = new VersionedTransaction(msg);
  vTx.sign([relayerKeypair]);

  const signature = await connection.sendTransaction(vTx, {
    skipPreflight: false,
  });

  // SEC-04: confirmTransaction RESOLVES on a failed transaction — it does not reject.
  //
  // A program error, a compute-budget overrun or a failed constraint arrives as
  // `value.err` on a fulfilled promise. Awaiting it without reading the result therefore treats
  // "included and reverted" identically to "included and succeeded", and the signature was returned
  // either way. The relayer answered HTTP 200, the interface showed a completed withdrawal with an
  // explorer link, and the recipient's balance was unchanged — the worst shape for a privacy tool,
  // because the user's next move is to assume the funds were taken.
  //
  // `skipPreflight: false` catches most failures before submission, so what remains is the case
  // where state moved between preflight and execution: the proof's root rotated out of the 256-entry
  // ring, or another transaction created the same nullifier first. Both are ordinary under load.
  //
  // No funds are at risk when this happens — a failed withdrawal does not create the nullifier, so
  // the note stays spendable — which is exactly why reporting it accurately matters. The user needs
  // to know to retry rather than to conclude the money is gone.
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  if (confirmation?.value?.err) {
    const onChainError = confirmation.value.err;

    // The API layer maps program failures to client-facing codes by matching the hex form Anchor
    // emits in simulation logs ("0x1774"), but a confirmed-then-reverted transaction reports the
    // same failure as a decimal `{ InstructionError: [i, { Custom: 6004 }] }`. Include both so a
    // reversion detected here is classified identically to one caught during preflight, rather
    // than degrading to a generic error.
    const custom = onChainError?.InstructionError?.[1]?.Custom;
    const hex = typeof custom === "number" ? ` (custom error 0x${custom.toString(16)})` : "";

    const err = new Error(
      `Withdrawal reverted on-chain: ${JSON.stringify(onChainError)}${hex}`
    );
    // Carried so the API layer can surface the signature: the transaction is on the ledger and the
    // user is entitled to inspect it, even though it failed.
    err.signature = signature;
    err.onChainError = onChainError;
    throw err;
  }

  return signature;
}
