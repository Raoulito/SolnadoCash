// @vitest-environment node
//
// Node rather than jsdom: under jsdom the hash library web3.js uses and the test's typed arrays come
// from different realms, so PublicKey.findProgramAddressSync fails with "Uint8Array expected" for
// any seeds. A browser has one realm, so this is a property of the test environment only.
//
// app/src/utils/withdrawalCheck.test.ts
//
// M-4. Every way a relayer can claim a withdrawal it did not make must be caught before the app says
// "funds have been sent". The chain is mocked at the RPC boundary; everything above it is real.

import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { PROGRAM_ID } from '../config';
import {
  confirmWithdrawalOnChain,
  nullifierAccount,
  WithdrawalNotConfirmedError,
} from './withdrawalCheck';

const POOL = Keypair.generate().publicKey;
const NULLIFIER_HASH = 123456789n;
const SIG = bs58.encode(new Uint8Array(64).fill(7));
const OTHER = Keypair.generate().publicKey.toBase58();

interface Chain {
  tx?: unknown;
  appearsAfter?: number;
  nullifier?: { owner: PublicKey; data: Uint8Array } | null;
}

function chain({ tx, appearsAfter = 0, nullifier }: Chain) {
  let calls = 0;
  return {
    _rpcRequest: async (method: string) => {
      expect(method).toBe('getTransaction');
      return { result: calls++ >= appearsAfter ? (tx ?? null) : null };
    },
    getAccountInfo: async () => nullifier ?? null,
  } as never;
}

function withdrawalTx(keys: string[], err: unknown = null) {
  return { transaction: { message: { accountKeys: keys } }, meta: { err } };
}

const pda = () => nullifierAccount(POOL, NULLIFIER_HASH).toBase58();
const spent = { owner: new PublicKey(PROGRAM_ID), data: new Uint8Array(80) };
const fast = { timeoutMs: 50, intervalMs: 5 };
const check = (conn: never, signature = SIG) =>
  confirmWithdrawalOnChain(conn, { signature, pool: POOL, nullifierHash: NULLIFIER_HASH }, fast);

describe('confirmWithdrawalOnChain (M-4)', () => {
  it('accepts a landed withdrawal that created this note’s nullifier account', async () => {
    await expect(check(chain({ tx: withdrawalTx([OTHER, pda()]), nullifier: spent }))).resolves.toBeUndefined();
  });

  it('waits for an RPC node that is a few slots behind', async () => {
    const conn = chain({ tx: withdrawalTx([pda()]), appearsAfter: 3, nullifier: spent });
    await expect(check(conn)).resolves.toBeUndefined();
  });

  it('rejects something that is not a transaction signature', async () => {
    const conn = chain({ tx: withdrawalTx([pda()]), nullifier: spent });
    await expect(check(conn, 'totally-not-a-signature')).rejects.toBeInstanceOf(WithdrawalNotConfirmedError);
    await expect(check(conn, bs58.encode(new Uint8Array(32)))).rejects.toThrow(/not a transaction signature/);
  });

  it('rejects a signature the chain has never seen', async () => {
    await expect(check(chain({ tx: null, nullifier: spent }))).rejects.toThrow(/no such transaction/);
  });

  it('rejects a transaction that reverted', async () => {
    const conn = chain({ tx: withdrawalTx([pda()], { InstructionError: [0, { Custom: 6004 }] }), nullifier: spent });
    await expect(check(conn)).rejects.toThrow(/failed on-chain/);
  });

  it('rejects the real signature of SOMEONE ELSE’s withdrawal', async () => {
    const conn = chain({ tx: withdrawalTx([OTHER, Keypair.generate().publicKey.toBase58()]), nullifier: spent });
    await expect(check(conn)).rejects.toThrow(/not a withdrawal of this note/);
  });

  it('rejects when the note is not recorded as spent', async () => {
    await expect(check(chain({ tx: withdrawalTx([pda()]), nullifier: null }))).rejects.toThrow(/not recorded as spent/);
    const funded = { owner: new PublicKey('11111111111111111111111111111111'), data: new Uint8Array(0) };
    await expect(check(chain({ tx: withdrawalTx([pda()]), nullifier: funded }))).rejects.toThrow(/not recorded as spent/);
  });

  it('tells the user to keep the note', async () => {
    await expect(check(chain({ tx: null }))).rejects.toThrow(/Do not discard your note/);
  });
});
