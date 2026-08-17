// app/src/utils/noteReconcile.ts
//
// Decides, from the chain, whether a staged note's deposit actually landed.
//
// Why this exists. `sendTransaction` signs AND submits, so when it throws we cannot know
// synchronously whether the deposit reached the network: wallets throw "Unexpected error" after the
// transaction is already on-chain. That uncertainty is why the note is persisted at all (FE-1), and
// it is also why a note whose deposit never landed used to linger in the recovery banner, inviting
// a withdrawal attempt that could only fail.
//
// Asynchronously the question IS decidable. A deposit that landed inserted its commitment as a leaf,
// so recompute `Poseidon(nullifier, secret, denomination)` and ask whether the pool's tree contains
// it. `rebuildMerkleTree` throws unless the tree it built verifies against the on-chain root, so a
// successful call means we hold EVERY leaf and a negative answer is conclusive rather than a
// symptom of missing history.
//
// The safety rule is one-directional: only ever discard on a definite negative. Any doubt at all,
// an RPC failure, a pruned history, a pool that cannot be read, leaves the note untouched. Losing a
// note loses the deposit, so the cost of the two mistakes is not symmetric.

import type { Connection } from '@solana/web3.js';
import { decodeNote, initPoseidon, poseidonHash } from '@solnadocash/sdk';
import { rebuildMerkleTree } from './merkle';
import { clearNote, markNoteStatus, pendingNotes } from './noteVault';

/**
 * How long to leave a note alone before judging it.
 *
 * Solana confirms in a second or two, so this is generously long. It only matters for a deposit
 * that is genuinely still in flight: judging that one too early would discard a note whose money
 * is about to exist.
 */
const GRACE_MS = 2 * 60 * 1000;

export interface ReconcileResult {
  /** Deposits found on-chain. The note is real money and was kept. */
  confirmed: number;
  /** Provably never landed. The note was worthless and has been removed. */
  discarded: number;
  /** Could not be decided. Left untouched, deliberately. */
  unresolved: number;
}

/**
 * Check every pending note against the chain, keeping the ones that matter and removing the ones
 * that cannot be spent.
 */
export async function reconcilePendingNotes(
  connection: Connection
): Promise<ReconcileResult> {
  const result: ReconcileResult = { confirmed: 0, discarded: 0, unresolved: 0 };
  const notes = pendingNotes();
  if (notes.length === 0) return result;

  await initPoseidon();

  for (const entry of notes) {
    // Too new to judge: a deposit submitted seconds ago may not be visible yet.
    if (Date.now() - entry.createdAt < GRACE_MS) {
      result.unresolved++;
      continue;
    }

    try {
      const note = decodeNote(entry.note);
      const commitment = poseidonHash(note.nullifier, note.secret, note.denomination);

      // Throws unless the rebuilt tree matches the on-chain root and leaf count, which is exactly
      // the guarantee that makes a negative answer trustworthy.
      const tree = await rebuildMerkleTree(connection, note.poolAddress);

      if (tree.hasLeaf(commitment)) {
        markNoteStatus(entry.note, 'confirmed');
        result.confirmed++;
      } else {
        // The tree is complete and this commitment is not in it, so the deposit never landed and
        // this note can never withdraw anything.
        clearNote(entry.note);
        result.discarded++;
      }
    } catch {
      // Unreadable pool, pruned history, incomplete tree, malformed note: all mean "do not know".
      // Never discard on uncertainty.
      result.unresolved++;
    }
  }

  return result;
}
