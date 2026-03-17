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
}) {
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  const wallet = new anchor.Wallet(relayerKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl, provider);

  // Derive PDAs
  const nullifierHash = bigIntToBytes32(BigInt(publicSignals[0]));
  const [nullifierPda, nullifierBump] = findNullifierPda(
    poolAddress,
    nullifierHash,
    programId
  );
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
    nullifierBump,
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

  // Build versioned transaction with compute budget
  const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 200_000,
  });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const msg = new TransactionMessage({
    payerKey: relayerKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [budgetIx, ix],
  }).compileToV0Message();

  const vTx = new VersionedTransaction(msg);
  vTx.sign([relayerKeypair]);

  const signature = await connection.sendTransaction(vTx, {
    skipPreflight: false,
  });

  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  return signature;
}
