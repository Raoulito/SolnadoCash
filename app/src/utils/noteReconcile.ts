// app/src/utils/noteReconcile.ts
//
// Checks, against the chain, whether a staged note's deposit landed, and records what it finds. It
// never removes a note.
//
// Why this exists. `sendTransaction` signs AND submits, so when it throws we cannot know
// synchronously whether the deposit reached the network: wallets throw "Unexpected error" after the
// transaction is already on-chain. That uncertainty is why the note is persisted at all (FE-1).
//
// Asynchronously the question can usually be answered. A deposit that landed inserted its commitment
// as a leaf, so recompute `Poseidon(nullifier, secret, denomination)` and ask whether the pool's tree
// contains it. A positive answer is recorded as 'confirmed', which is what the recovery banner shows.
//
// H-4. A negative answer used to DELETE the note, on the reasoning that `rebuildMerkleTree` throws
// unless its tree verifies against the on-chain root, so a verified tree without the leaf proves the
// deposit never landed. That proof only holds if the RPC is honest and current, and it is the same
// RPC that answers both the history and the pool state the tree is checked against. A malicious
// endpoint can serve an empty pool whose empty-tree root "verifies"; an honest node that is a few
// minutes behind serves a consistent snapshot from before the deposit. Either way the note, which is
// the only key to the deposit, was deleted on page load with no user action, and that was reachable
// even for notes this app had itself already seen confirmed.
//
// Deleting on an inference is the one mistake here that cannot be undone, and keeping a worthless
// note costs only a line in the banner that the user can dismiss. So removal is left entirely to the
// user, and a negative answer is only counted, never acted on.

import type { Connection } from '@solana/web3.js';
import { decodeNote, initPoseidon, poseidonHash } from '@solnadocash/sdk';
import { rebuildMerkleTree } from './merkle';
import { markNoteStatus, pendingNotes } from './noteVault';

/**
 * How long to leave a broadcast note alone before judging it.
 *
 * Measured from the moment the deposit was handed to `sendTransaction`, never from when the note was
 * staged (SEC-03) — see the guard in the loop below for why the distinction matters.
 *
 * Solana confirms in a second or two, and a transaction's blockhash expires after roughly 150 slots,
 * so two minutes after broadcast a deposit that has not appeared is unlikely to appear later. That
 * makes "not found" worth reporting after this point. It does not make it safe to act on (H-4).
 */
const GRACE_MS = 2 * 60 * 1000;

export interface ReconcileResult {
  /** Deposits found on-chain in this pass. The note was marked 'confirmed' and kept. */
  confirmed: number;
  /**
   * Checked against a tree that verified, and the commitment was not in it. Kept anyway: the answer
   * is only as trustworthy as the RPC that gave it (H-4).
   */
  notFound: number;
  /** Not judged: too recent, never broadcast, unreadable, or the chain could not be read. */
  unresolved: number;
}

/**
 * Check pending notes against the chain and mark the ones whose deposit is found. Never removes a
 * note; only the user can, from the recovery banner.
 */
export async function reconcilePendingNotes(
  connection: Connection
): Promise<ReconcileResult> {
  const result: ReconcileResult = { confirmed: 0, notFound: 0, unresolved: 0 };
  const notes = pendingNotes();
  if (notes.length === 0) return result;

  await initPoseidon();

  for (const entry of notes) {
    // Already seen on-chain. There is nothing left to learn about it, and the only thing a second
    // look could produce is a wrong negative from a lying or lagging RPC (H-4).
    if (entry.status === 'confirmed') continue;

    // SEC-03. Only a note whose deposit was actually BROADCAST may be judged, and the clock runs
    // from the broadcast, not from when the note was written to storage.
    //
    // The two are different instants. `stageNote` persists the note before the wallet is asked to
    // sign — that ordering is deliberate and is what stops a crash mid-signature losing the only key
    // to a deposit. But it means `createdAt` starts running while no transaction exists at all.
    //
    // The path that lost funds: stage at t=0, user spends three minutes approving on a hardware
    // wallet, a second tab remounts the recovery banner at t=120s and reconciles. Nothing has been
    // broadcast, so the chain is entirely self-consistent — `pool.next_index` and the deposit logs
    // agree, the rebuilt tree verifies as complete, and the commitment is genuinely absent. The
    // completeness guard below cannot fire because nothing is missing. The note was therefore
    // deleted as worthless, and the deposit landed moments later against a note that no longer
    // existed.
    //
    // A note with no `sentAt` is unjudgeable rather than worthless, so it is left alone. That also
    // covers notes stored before this field existed.
    if (entry.status === 'unsent' || entry.sentAt === undefined) {
      result.unresolved++;
      continue;
    }

    // Broadcast, but not long enough ago for the deposit to have landed or expired. A transaction
    // carries a blockhash that expires after roughly 150 slots, so checking earlier than this would
    // only report deposits that are still in flight as not found.
    if (Date.now() - entry.sentAt < GRACE_MS) {
      result.unresolved++;
      continue;
    }

    try {
      const note = decodeNote(entry.note);
      const commitment = poseidonHash(note.nullifier, note.secret, note.denomination);

      // Throws unless the rebuilt tree matches the pool's root and leaf count as this RPC reports
      // them, so a thrown error means "do not know".
      const tree = await rebuildMerkleTree(connection, note.poolAddress);

      if (tree.hasLeaf(commitment)) {
        markNoteStatus(entry.note, 'confirmed');
        result.confirmed++;
      } else {
        // Probably never landed, if the RPC is honest and current. That is exactly the condition
        // this code cannot check, so the note stays and the user decides.
        result.notFound++;
      }
    } catch {
      // Unreadable pool, pruned history, incomplete tree, malformed note: all mean "do not know".
      result.unresolved++;
    }
  }

  return result;
}
