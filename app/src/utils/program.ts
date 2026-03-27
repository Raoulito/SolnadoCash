// app/src/utils/program.ts
// Anchor program setup + PDA derivation utilities for the frontend.

import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import type { AnchorWallet } from '@solana/wallet-adapter-react';
import IDL from '../idl/solnadocash.json';
import { PROGRAM_ID } from '../config';

const programId = new PublicKey(PROGRAM_ID);

/**
 * Create an Anchor Program instance for the connected wallet.
 * Use this to build deposit instructions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getProgram(connection: Connection, wallet: AnchorWallet): Program<any> {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(IDL as any, provider);
}

/**
 * Derive the vault PDA for a given pool.
 * Seeds: [b"vault", pool_pda]
 */
export function findVaultPda(poolPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), poolPda.toBytes()],
    programId
  );
}

/**
 * Derive a pool PDA from admin + denomination + version.
 * Seeds: [b"pool", admin, mint(zeros for SOL), denomination_le_bytes, version]
 */
export function findPoolPda(
  admin: PublicKey,
  denomination: bigint,
  version: number
): [PublicKey, number] {
  const denomBytes = Buffer.alloc(8);
  denomBytes.writeBigUInt64LE(denomination);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('pool'),
      admin.toBytes(),
      new PublicKey(Buffer.alloc(32, 0)).toBytes(), // SOL = Pubkey::default()
      denomBytes,
      Buffer.from([version]),
    ],
    programId
  );
}

/**
 * Convert a bigint to a 32-byte big-endian Uint8Array.
 */
export function bigintToBytes32(n: bigint): number[] {
  const hex = n.toString(16).padStart(64, '0');
  const bytes: number[] = [];
  for (let i = 0; i < 32; i++) {
    bytes.push(parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  }
  return bytes;
}

/**
 * Build and return a deposit transaction (unsigned).
 * The caller should use wallet adapter's sendTransaction to sign + send.
 */
export async function buildDepositTx(
  program: Program,
  poolPda: PublicKey,
  depositor: PublicKey,
  commitment: bigint
) {
  const [vaultPda] = findVaultPda(poolPda);
  const commitmentBytes = bigintToBytes32(commitment);

  return program.methods
    .deposit(commitmentBytes)
    .accountsPartial({
      pool: poolPda,
      vault: vaultPda,
      depositor,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
}
