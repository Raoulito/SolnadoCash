// app/src/utils/merkle.ts
// Rebuild the Merkle tree from on-chain DepositEvent logs.
// Required for generating valid ZK proofs during withdrawal.

import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, EventParser } from '@coral-xyz/anchor';
import {
  initPoseidon,
  MerkleTree,
  readPoolTreeState,
  verifyTreeMatchesPool,
} from '@solnadocash/sdk';
import IDL from '../idl/solnadocash.json';
import { PROGRAM_ID } from '../config';
import { clearCache, leafToBigInt, loadCache, saveCache } from './leafCache';

/**
 * A DepositEvent as the Anchor EventParser yields it.
 *
 * The field is `leaf_index`: the parser returns the IDL's snake_case names verbatim rather than
 * camel-casing them. Reading `leafIndex` produced `undefined`, and `Number(undefined)` is NaN.
 * Both spellings are accepted here so this cannot break again on an Anchor version that does
 * convert, and a missing index is now a hard error rather than a silent NaN.
 */
interface DepositEventData {
  leaf: number[];
  leaf_index?: bigint | number;
  leafIndex?: bigint | number;
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
 * Scan pool signatures and return the deposit leaves found, plus the newest signature seen.
 *
 * `until` bounds the scan to transactions newer than a signature already processed, which is
 * what makes an incremental rebuild possible.
 */
async function scanDeposits(
  connection: Connection,
  poolAddress: PublicKey,
  until: string | undefined,
  onProgress?: (loaded: number, total: number) => void
): Promise<{ deposits: { leaf: bigint; leafIndex: number }[]; newestSignature?: string }> {
  const programId = new PublicKey(PROGRAM_ID);
  const eventParser = new EventParser(programId, new BorshCoder(IDL as never));

  const allSignatures = [];
  let before: string | undefined;
  for (;;) {
    const batch = await connection.getSignaturesForAddress(
      poolAddress,
      { before, until, limit: 1000 },
      'confirmed'
    );
    if (batch.length === 0) break;
    allSignatures.push(...batch);
    before = batch[batch.length - 1].signature;
  }

  // Newest first from the RPC; the newest is the bound for the next incremental scan.
  const newestSignature = allSignatures[0]?.signature;
  allSignatures.reverse();

  // Fetched concurrently — one sequential round-trip per signature is unusably slow and
  // trips rate limits well before the pool's advertised capacity.
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

  const deposits: { leaf: bigint; leafIndex: number }[] = [];
  for (const tx of txs) {
    if (!tx?.meta?.logMessages) continue;
    for (const event of eventParser.parseLogs(tx.meta.logMessages)) {
      if (event.name === 'DepositEvent' || event.name === 'depositEvent') {
        const data = event.data as unknown as DepositEventData;
        const rawIndex = data.leaf_index ?? data.leafIndex;
        const leafIndex = Number(rawIndex);

        // A NaN here is what caused "recovered 0 of N deposits" in the field: every deposit
        // collapsed onto one NaN map key, so the dense prefix was empty and the tree came out
        // empty while looking like an RPC history problem. Fail loudly instead.
        if (rawIndex === undefined || !Number.isInteger(leafIndex) || leafIndex < 0) {
          throw new Error(
            `Deposit event has an unusable leaf index (${String(rawIndex)}). The IDL in ` +
              `src/idl does not match the deployed program's event layout.`
          );
        }

        deposits.push({
          leaf: bytesToBigInt(Array.from(data.leaf)),
          leafIndex,
        });
      }
    }
  }
  return { deposits, newestSignature };
}

/** Build a tree from a dense, index-ordered leaf array. */
function buildTree(leaves: bigint[]): MerkleTree {
  const tree = new MerkleTree(20);
  for (const leaf of leaves) tree.insert(leaf);
  return tree;
}

/**
 * Fetch a pool's deposit leaves and rebuild the Merkle tree.
 *
 * Two properties matter here and both are enforced below rather than assumed:
 *
 * 1. The result is verified against on-chain pool state before it is returned (H-5). A tree
 *    rebuilt from transaction logs is silently wrong whenever a deposit is missed, and
 *    public RPC endpoints prune history and rate-limit. An unverified tree yields a proof
 *    against a root the chain never had, which fails as RootNotFound/InvalidProof and cannot
 *    be recovered by retrying.
 *
 * 2. Known leaves are cached locally, so a repeat withdrawal costs one round-trip per NEW
 *    deposit instead of per deposit ever made. The cache is never trusted: if the rebuilt
 *    root does not match the chain, it is discarded and a full scan runs once. So the cache
 *    can only affect speed, never correctness.
 *
 * This still does not scale to a full pool — a cold cache pays O(deposits). Serving leaves
 * from an indexer is the actual fix.
 */
export async function rebuildMerkleTree(
  connection: Connection,
  poolAddress: PublicKey,
  onProgress?: (loaded: number, total: number) => void
): Promise<MerkleTree> {
  await initPoseidon();

  // Read pool state first so the rebuild can be checked against it.
  const poolAccount = await connection.getAccountInfo(poolAddress);
  if (!poolAccount) {
    throw new Error(
      'Pool account not found on-chain. Check the pool address in your note.'
    );
  }
  const onChain = readPoolTreeState(poolAccount.data);
  const poolKey = poolAddress.toBase58();

  const cached = loadCache(PROGRAM_ID, poolKey);
  let leaves = cached.leaves.map(leafToBigInt);
  let newestSignature = cached.lastSignature;

  // Nothing new on-chain: the cache alone is enough, so no transaction fetches at all.
  // Still verified below, so a stale or tampered cache cannot slip through.
  if (leaves.length !== onChain.nextIndex) {
    const scan = await scanDeposits(connection, poolAddress, cached.lastSignature, onProgress);
    newestSignature = scan.newestSignature ?? cached.lastSignature;

    // Merge by leaf index. Indices are authoritative and assigned on-chain, so this
    // tolerates duplicates and out-of-order delivery.
    const byIndex = new Map<number, bigint>();
    leaves.forEach((leaf, i) => byIndex.set(i, leaf));
    for (const d of scan.deposits) byIndex.set(d.leafIndex, d.leaf);

    // The tree can only be built from a dense prefix; a gap means the incremental scan
    // missed history, so fall back to a single full rescan from scratch.
    const dense: bigint[] = [];
    for (let i = 0; i < byIndex.size; i++) {
      const leaf = byIndex.get(i);
      if (leaf === undefined) break;
      dense.push(leaf);
    }

    // Rescan whenever the merged result is incomplete, regardless of what the cache held. This
    // was previously gated on `cached.leaves.length > 0`, which meant a cache carrying a
    // lastSignature but no leaves could never recover: the `until` bound skipped the history it
    // needed, and the gap check then refused to retry without it.
    if (dense.length !== onChain.nextIndex) {
      clearCache(PROGRAM_ID, poolKey);
      const full = await scanDeposits(connection, poolAddress, undefined, onProgress);
      newestSignature = full.newestSignature;
      const fresh = new Map<number, bigint>();
      for (const d of full.deposits) fresh.set(d.leafIndex, d.leaf);
      leaves = [];
      for (let i = 0; i < fresh.size; i++) {
        const leaf = fresh.get(i);
        if (leaf === undefined) break;
        leaves.push(leaf);
      }
    } else {
      leaves = dense;
    }
  }

  let tree = buildTree(leaves);

  // Authoritative check: leaf count and root must agree with the chain.
  try {
    verifyTreeMatchesPool(tree, poolAccount.data);
  } catch (e) {
    // The cache was the only untrusted input, so retry once without it before giving up.
    if (cached.leaves.length === 0) throw e;
    clearCache(PROGRAM_ID, poolKey);
    const full = await scanDeposits(connection, poolAddress, undefined, onProgress);
    const fresh = new Map<number, bigint>();
    for (const d of full.deposits) fresh.set(d.leafIndex, d.leaf);
    const rebuilt: bigint[] = [];
    for (let i = 0; i < fresh.size; i++) {
      const leaf = fresh.get(i);
      if (leaf === undefined) break;
      rebuilt.push(leaf);
    }
    leaves = rebuilt;
    newestSignature = full.newestSignature;
    tree = buildTree(leaves);
    verifyTreeMatchesPool(tree, poolAccount.data); // throws with an actionable message
  }

  saveCache(PROGRAM_ID, poolKey, leaves, newestSignature);
  return tree;
}
