// app/src/utils/merkle.ts
// Rebuild the Merkle tree from on-chain DepositEvent logs.
// Required for generating valid ZK proofs during withdrawal.

import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, EventParser } from '@coral-xyz/anchor';
import { initPoseidon, MerkleTree, verifyTreeMatchesPool } from '@solnadocash/sdk';
import IDL from '../idl/solnadocash.json';
import { PROGRAM_ID } from '../config';

interface DepositEventData {
  leaf: number[];
  leafIndex: bigint;
}

/** How many getTransaction calls to issue concurrently. */
const FETCH_CONCURRENCY = 8;

/**
 * Convert a 32-byte big-endian array to bigint.
 */
function bytesToBigInt(bytes: number[]): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/** Map with bounded concurrency, preserving input order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onDone?: (completed: number, total: number) => void
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      completed++;
      onDone?.(completed, items.length);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Fetch all DepositEvent logs for a pool and rebuild the Merkle tree.
 *
 * The result is verified against on-chain pool state before it is returned
 * (H-5): a tree rebuilt from transaction logs is silently wrong whenever a
 * deposit is missed, and public RPC endpoints prune history and rate-limit. An
 * unverified tree yields a proof against a root the chain never had, which fails
 * as RootNotFound/InvalidProof and cannot be recovered by retrying.
 *
 * For production, replace log scanning with an indexer — this is O(deposits) RPC
 * round-trips.
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

  // Read pool state first so the rebuild can be checked against it.
  const poolAccount = await connection.getAccountInfo(poolAddress);
  if (!poolAccount) {
    throw new Error(
      'Pool account not found on-chain. Check the pool address in your note.'
    );
  }

  // Fetch all signatures for the pool (paginated, newest first)
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

  // Parse deposit events. Fetched concurrently — one sequential round-trip per
  // signature is unusably slow and trips rate limits well before the pool's
  // advertised capacity.
  const successful = allSignatures.filter((s) => !s.err);
  const txs = await mapPool(
    successful,
    FETCH_CONCURRENCY,
    (sig) =>
      connection.getTransaction(sig.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }),
    onProgress
  );

  const deposits: { leaf: number[]; leafIndex: number }[] = [];
  for (const tx of txs) {
    if (!tx?.meta?.logMessages) continue;
    for (const event of eventParser.parseLogs(tx.meta.logMessages)) {
      if (event.name === 'DepositEvent' || event.name === 'depositEvent') {
        const data = event.data as unknown as DepositEventData;
        deposits.push({
          leaf: Array.from(data.leaf),
          leafIndex: Number(data.leafIndex),
        });
      }
    }
  }

  // Sort by leaf index to ensure correct insertion order
  deposits.sort((a, b) => a.leafIndex - b.leafIndex);

  // Build the Merkle tree
  const tree = new MerkleTree(20);
  for (const deposit of deposits) {
    tree.insert(bytesToBigInt(deposit.leaf));
  }

  // Authoritative check: leaf count and root must agree with the chain.
  // Throws with an actionable message if they do not.
  verifyTreeMatchesPool(tree, poolAccount.data);

  return tree;
}
