// app/src/utils/merkle.ts
// Rebuild a pool's Merkle tree from its on-chain deposit history.
// Required for generating valid ZK proofs during withdrawal.

import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, EventParser } from '@coral-xyz/anchor';
import bs58 from 'bs58';
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

/** First 8 bytes of every `deposit` instruction, taken from the IDL so it cannot drift. */
const DEPOSIT_DISCRIMINATOR = Uint8Array.from(
  (IDL as { instructions: { name: string; discriminator: number[] }[] }).instructions.find(
    (i) => i.name === 'deposit'
  )!.discriminator
);

/** An instruction as `getTransaction` returns it with `encoding: 'json'`. */
interface RawInstruction {
  programIdIndex: number;
  accounts: number[];
  /** base58 */
  data: string;
}

/** The parts of a `getTransaction` JSON response this module reads. */
interface RawTransaction {
  slot: number;
  transaction: { message: { accountKeys: string[]; instructions: RawInstruction[] } };
  meta: {
    err: unknown;
    logMessages?: string[] | null;
    innerInstructions?: { index: number; instructions: RawInstruction[] }[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
}

interface ScanResult {
  /** Deposits whose leaf index is known from their DepositEvent. */
  indexed: { leaf: bigint; leafIndex: number }[];
  /** Deposits that carried no usable event, oldest first. */
  unindexed: bigint[];
  newestSignature?: string;
}

type RpcRequest = (
  method: string,
  args: unknown[]
) => Promise<{ result?: unknown; error?: { code: number; message: string } }>;

/**
 * The connection's raw JSON-RPC call, which keeps its endpoint, headers and 429 retry.
 *
 * Needed because web3.js 1.x's typed `getTransaction` validates the response against a schema
 * that only admits versions 'legacy' and 0, so it throws on a v1 transaction whatever
 * `maxSupportedTransactionVersion` says. `_rpcRequest` is not public API, but it is what
 * Anchor itself calls for the same reason; its absence is reported rather than papered over.
 */
export function rawRpc(connection: Connection): RpcRequest {
  const rpc = (connection as unknown as { _rpcRequest?: RpcRequest })._rpcRequest;
  if (typeof rpc !== 'function') {
    throw new Error('This version of @solana/web3.js does not expose a raw RPC call.');
  }
  return rpc.bind(connection);
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
 *
 * H-2. This used to read deposits from `DepositEvent` log lines alone, which let anyone make the
 * pool's tree permanently unrebuildable for every user of this app, three different ways:
 *
 *  - Log truncation. The runtime keeps 10 KB of log text per transaction and drops the rest. A
 *    transaction that floods the log and then deposits is applied on-chain with no event line.
 *    The rebuilt tree was then one leaf short of `next_index` forever. Reproduced against the
 *    deployed binary: next_index went to 1, zero "Program data:" lines, "Log truncated" present.
 *  - Another pool's event. `DepositEvent` carries no pool. A deposit into any other pool that also
 *    lists this pool as a spare account appears in this pool's history, and its event was merged
 *    here at the other pool's index, overwriting a real leaf.
 *  - Transaction v1. It is live on devnet, web3.js 1.x rejects it in `getTransaction`'s response
 *    schema, and the RPC refuses it unless the request allows version 1. A single v1 transaction
 *    that merely mentions the pool aborted every rebuild.
 *
 * So deposits now come from the transaction itself, which none of those can alter: every
 * top-level and inner instruction of this program whose data starts with the `deposit`
 * discriminator and whose first account is this pool. Transactions are fetched as raw JSON with
 * `maxSupportedTransactionVersion: 1`, which reads legacy, v0 and v1 alike.
 *
 * Events are still used, but only for what they add, which is the leaf index. Each successful
 * deposit emits exactly one DepositEvent, and every DepositEvent line has the same length, so a
 * truncated log keeps a PREFIX of them in execution order. They are therefore paired positionally
 * with this program's deposit instructions (all pools) and checked leaf by leaf; a transaction
 * where that does not line up contributes no indices at all. Deposits left without an index are
 * placed into the gaps between known indices in chronological order, and root verification in
 * `rebuildMerkleTree` remains the final arbiter, so a wrong placement fails closed.
 */
async function scanDeposits(
  connection: Connection,
  poolAddress: PublicKey,
  until: string | undefined,
  onProgress?: (loaded: number, total: number) => void
): Promise<ScanResult> {
  const programId = new PublicKey(PROGRAM_ID);
  const programKey = programId.toBase58();
  const poolKey = poolAddress.toBase58();
  const eventParser = new EventParser(programId, new BorshCoder(IDL as never));
  const rpc = rawRpc(connection);

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
    async (sig) => {
      const res = await rpc('getTransaction', [
        sig.signature,
        { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 },
      ]);
      if (res.error) {
        throw new Error(`getTransaction ${sig.signature} failed: ${res.error.message}`);
      }
      return (res.result ?? null) as RawTransaction | null;
    },
    onProgress
  );

  const indexed: { leaf: bigint; leafIndex: number }[] = [];
  const unindexed: { leaf: bigint; slot: number; signature: string; order: number }[] = [];

  txs.forEach((tx, t) => {
    // A failed transaction changed nothing, whatever its instructions say.
    if (!tx?.meta || tx.meta.err) return;
    const signature = successful[t].signature;

    const deposits = depositInstructions(tx, programKey);
    const events: { leaf: bigint; leafIndex: number }[] = [];
    for (const event of eventParser.parseLogs(tx.meta.logMessages ?? [])) {
      if (event.name !== 'DepositEvent' && event.name !== 'depositEvent') continue;
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
      events.push({ leaf: bytesToBigInt(Array.from(data.leaf)), leafIndex });
    }

    // Positional pairing, verified leaf by leaf. Anything that does not line up means the
    // events cannot be attributed, so none of this transaction's indices are used.
    const aligned =
      events.length <= deposits.length && events.every((e, k) => e.leaf === deposits[k].leaf);

    deposits.forEach((d, k) => {
      if (d.pool !== poolKey) return;
      if (aligned && k < events.length) {
        indexed.push({ leaf: d.leaf, leafIndex: events[k].leafIndex });
      } else {
        unindexed.push({ leaf: d.leaf, slot: tx.slot, signature, order: k });
      }
    });
  });

  return {
    indexed,
    unindexed: await chronological(connection, unindexed),
    newestSignature,
  };
}

/**
 * Order deposits that carried no index, oldest first, which is the order the program assigned
 * their indices in.
 *
 * Slot first, then position within the transaction. Two such deposits in DIFFERENT transactions
 * of one slot need the block's own transaction order, which `getSignaturesForAddress` does not
 * promise, so that one case fetches the block's signature list. Any doubt is an error: a guessed
 * order would only fail later, at root verification, with a less useful message.
 */
async function chronological(
  connection: Connection,
  entries: { leaf: bigint; slot: number; signature: string; order: number }[]
): Promise<bigint[]> {
  const sigsBySlot = new Map<number, Set<string>>();
  for (const e of entries) {
    if (!Number.isInteger(e.slot)) {
      throw new Error(`Cannot order deposit ${e.signature}: the RPC did not report its slot.`);
    }
    const set = sigsBySlot.get(e.slot) ?? new Set<string>();
    set.add(e.signature);
    sigsBySlot.set(e.slot, set);
  }

  const blockPosition = new Map<string, number>();
  for (const [slot, sigs] of sigsBySlot) {
    if (sigs.size < 2) continue;
    const block = await connection.getBlockSignatures(slot, 'confirmed');
    for (const s of sigs) {
      const p = block.signatures.indexOf(s);
      if (p < 0) {
        throw new Error(`Cannot order deposits in slot ${slot}: ${s} is not in the block.`);
      }
      blockPosition.set(s, p);
    }
  }

  return [...entries]
    .sort(
      (a, b) =>
        a.slot - b.slot ||
        (blockPosition.get(a.signature) ?? 0) - (blockPosition.get(b.signature) ?? 0) ||
        a.order - b.order
    )
    .map((e) => e.leaf);
}

/**
 * Every `deposit` instruction of this program in a transaction, in execution order, with the pool
 * it targets and the commitment it inserted.
 *
 * Execution order is each top-level instruction followed by the inner instructions it invoked.
 * Anchor matches an instruction on its 8-byte discriminator and deserialises the arguments without
 * rejecting trailing bytes, so the commitment is bytes 8..40 of any data at least that long.
 */
function depositInstructions(
  tx: RawTransaction,
  programKey: string
): { pool: string; leaf: bigint }[] {
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
  const inner = new Map<number, RawInstruction[]>();
  for (const group of tx.meta?.innerInstructions ?? []) inner.set(group.index, group.instructions);

  const found: { pool: string; leaf: bigint }[] = [];
  const consider = (ix: RawInstruction) => {
    if (keys[ix.programIdIndex] !== programKey) return;
    const data = bs58.decode(ix.data);
    if (data.length < 40) return;
    for (let i = 0; i < 8; i++) if (data[i] !== DEPOSIT_DISCRIMINATOR[i]) return;
    const pool = keys[ix.accounts[0]];
    if (pool === undefined) return;
    found.push({ pool, leaf: bytesToBigInt(Array.from(data.subarray(8, 40))) });
  };

  tx.transaction.message.instructions.forEach((ix, i) => {
    consider(ix);
    for (const innerIx of inner.get(i) ?? []) consider(innerIx);
  });
  return found;
}

/**
 * Merge a scan into leaves already known, and return the dense prefix up to `nextIndex`.
 *
 * Indexed deposits go where their event says. Unindexed ones fill the remaining holes below
 * `nextIndex` in chronological order, but only when their number matches the number of holes
 * exactly; otherwise the placement would be a guess, so they are left out and the caller's
 * completeness check sends it to a full rescan. The prefix stops at `nextIndex` because the
 * pool state was read first: a deposit landing after that read belongs to a later root.
 */
function assemble(base: bigint[], scan: ScanResult, nextIndex: number): bigint[] {
  const byIndex = new Map<number, bigint>();
  base.forEach((leaf, i) => byIndex.set(i, leaf));
  for (const d of scan.indexed) byIndex.set(d.leafIndex, d.leaf);

  const holes: number[] = [];
  for (let i = 0; i < nextIndex; i++) if (!byIndex.has(i)) holes.push(i);
  if (holes.length > 0 && holes.length === scan.unindexed.length) {
    holes.forEach((h, k) => byIndex.set(h, scan.unindexed[k]));
  }

  const dense: bigint[] = [];
  for (let i = 0; i < nextIndex; i++) {
    const leaf = byIndex.get(i);
    if (leaf === undefined) break;
    dense.push(leaf);
  }
  return dense;
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
    // tolerates duplicates and out-of-order delivery. A gap means the incremental scan
    // missed history.
    const dense = assemble(leaves, scan, onChain.nextIndex);

    // Rescan whenever the merged result is incomplete, regardless of what the cache held. This
    // was previously gated on `cached.leaves.length > 0`, which meant a cache carrying a
    // lastSignature but no leaves could never recover: the `until` bound skipped the history it
    // needed, and the gap check then refused to retry without it.
    if (dense.length !== onChain.nextIndex) {
      clearCache(PROGRAM_ID, poolKey);
      const full = await scanDeposits(connection, poolAddress, undefined, onProgress);
      newestSignature = full.newestSignature;
      leaves = assemble([], full, onChain.nextIndex);
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
    leaves = assemble([], full, onChain.nextIndex);
    newestSignature = full.newestSignature;
    tree = buildTree(leaves);
    verifyTreeMatchesPool(tree, poolAccount.data); // throws with an actionable message
  }

  saveCache(PROGRAM_ID, poolKey, leaves, newestSignature);
  return tree;
}
