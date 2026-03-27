// app/src/utils/merkle.ts
// Rebuild the Merkle tree from on-chain DepositEvent logs.
// Required for generating valid ZK proofs during withdrawal.

import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, EventParser } from '@coral-xyz/anchor';
import { initPoseidon, MerkleTree } from '@solnadocash/sdk';
import IDL from '../idl/solnadocash.json';
import { PROGRAM_ID } from '../config';

interface DepositEventData {
  leaf: number[];
  leafIndex: bigint;
}

/**
 * Convert a 32-byte big-endian array to bigint.
 */
function bytesToBigInt(bytes: number[]): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/**
 * Fetch all DepositEvent logs for a pool and rebuild the Merkle tree.
 *
 * This fetches every transaction involving the pool PDA, extracts
 * DepositEvent events (Anchor CPI events), sorts by leaf_index,
 * and inserts each commitment into a fresh MerkleTree.
 *
 * For devnet beta with few deposits this is fast. For production
 * with thousands of deposits, consider an off-chain indexer.
 */
export async function rebuildMerkleTree(
  connection: Connection,
  poolAddress: PublicKey,
  onProgress?: (loaded: number, total: number) => void
): Promise<MerkleTree> {
  await initPoseidon();

  const programId = new PublicKey(PROGRAM_ID);
  const coder = new BorshCoder(IDL as never);
  const eventParser = new EventParser(programId, coder);

  // Fetch all signatures for the pool (paginated, oldest first)
  const allSignatures = [];
  let before: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await connection.getSignaturesForAddress(
      poolAddress,
      { before, limit: 1000 },
      'confirmed'
    );
    if (batch.length === 0) break;
    allSignatures.push(...batch);
    before = batch[batch.length - 1].signature;
  }

  // Reverse to chronological order (oldest first)
  allSignatures.reverse();

  // Parse deposit events from each transaction
  const deposits: { leaf: number[]; leafIndex: number }[] = [];

  for (let i = 0; i < allSignatures.length; i++) {
    const sig = allSignatures[i];
    if (sig.err) continue; // Skip failed transactions

    const tx = await connection.getTransaction(sig.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta?.logMessages) continue;

    for (const event of eventParser.parseLogs(tx.meta.logMessages)) {
      if (event.name === 'DepositEvent') {
        const data = event.data as unknown as DepositEventData;
        deposits.push({
          leaf: Array.from(data.leaf),
          leafIndex: Number(data.leafIndex),
        });
      }
    }

    if (onProgress) {
      onProgress(i + 1, allSignatures.length);
    }
  }

  // Sort by leaf index to ensure correct insertion order
  deposits.sort((a, b) => a.leafIndex - b.leafIndex);

  // Build the Merkle tree
  const tree = new MerkleTree(20);
  for (const deposit of deposits) {
    const leafBigInt = bytesToBigInt(deposit.leaf);
    tree.insert(leafBigInt);
  }

  return tree;
}
