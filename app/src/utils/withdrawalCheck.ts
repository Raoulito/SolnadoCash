// app/src/utils/withdrawalCheck.ts
//
// M-4. Confirm on-chain that a withdrawal actually happened before telling the user it did.
//
// The app used to announce "Withdrawal complete — funds have been sent" on the relayer's word alone:
// any non-empty string in `txSignature` was accepted. A malicious or broken relayer could therefore
// report success for a withdrawal it never sent, or hand back the real signature of some other
// withdrawal so the explorer link looked convincing. A user who believed it and discarded the note
// lost the deposit: the proof the relayer withheld stays valid only until its root rotates out of the
// pool's 256-entry history, after which nobody holds anything that can spend it except the note.
//
// Three facts are checked, each from the chain rather than the relayer:
//   1. the signature names a transaction that landed and did not revert;
//   2. that transaction touched THIS note's nullifier account, so it is this withdrawal and not
//      another one's signature;
//   3. the nullifier account exists and belongs to the program, so the note is recorded as spent.
// Only a proof generated from this note can create (3), and every such proof is bound to the
// recipient the user chose, so together they mean the funds went where the user asked.

import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { PROGRAM_ID } from '../config';
import { rawRpc } from './merkle';

export class WithdrawalNotConfirmedError extends Error {
  constructor(reason: string) {
    super(
      `The relayer says it sent your withdrawal, but it could not be confirmed on-chain: ${reason}. ` +
        'Do not discard your note. Check the recipient balance; if the funds have not arrived, ' +
        'the note is still valid and you can withdraw again.'
    );
    this.name = 'WithdrawalNotConfirmedError';
  }
}

interface RawTransaction {
  transaction: { message: { accountKeys: string[] } };
  meta: {
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
}

/** The nullifier account a withdrawal of this note creates. */
export function nullifierAccount(pool: PublicKey, nullifierHash: bigint): PublicKey {
  const hash = new Uint8Array(32);
  let v = nullifierHash;
  for (let i = 31; i >= 0; i--) {
    hash[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('nullifier'), pool.toBytes(), hash],
    new PublicKey(PROGRAM_ID)
  )[0];
}

/**
 * Resolve once the withdrawal is confirmed on-chain; throw WithdrawalNotConfirmedError otherwise.
 *
 * The relayer only answers after its own confirmation, so the transaction is normally visible at
 * once. The wait exists for an RPC node that is a few slots behind the relayer's.
 */
export async function confirmWithdrawalOnChain(
  connection: Connection,
  params: { signature: string; pool: PublicKey; nullifierHash: bigint },
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const { signature, pool, nullifierHash } = params;

  let decoded: Uint8Array | null = null;
  try {
    decoded = bs58.decode(signature);
  } catch {
    decoded = null;
  }
  if (!decoded || decoded.length !== 64) {
    throw new WithdrawalNotConfirmedError('what it returned is not a transaction signature');
  }

  const nullifier = nullifierAccount(pool, nullifierHash);
  const nullifierKey = nullifier.toBase58();
  const rpc = rawRpc(connection);
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const interval = opts.intervalMs ?? 2_000;

  for (;;) {
    // Raw JSON with maxSupportedTransactionVersion 1, for the reason given in merkle.ts: web3.js 1.x
    // cannot parse a v1 transaction.
    const res = await rpc('getTransaction', [
      signature,
      { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 },
    ]);
    const tx = res.error ? null : ((res.result ?? null) as RawTransaction | null);
    if (tx) {
      if (!tx.meta || tx.meta.err) {
        throw new WithdrawalNotConfirmedError('the transaction failed on-chain');
      }
      const keys = [
        ...tx.transaction.message.accountKeys,
        ...(tx.meta.loadedAddresses?.writable ?? []),
        ...(tx.meta.loadedAddresses?.readonly ?? []),
      ];
      if (!keys.includes(nullifierKey)) {
        throw new WithdrawalNotConfirmedError(
          'the transaction it named is not a withdrawal of this note'
        );
      }
      break;
    }
    if (Date.now() >= deadline) {
      throw new WithdrawalNotConfirmedError('no such transaction was found');
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  const account = await connection.getAccountInfo(nullifier, 'confirmed');
  if (!account || !account.owner.equals(new PublicKey(PROGRAM_ID)) || account.data.length === 0) {
    throw new WithdrawalNotConfirmedError('the note is not recorded as spent');
  }
}
