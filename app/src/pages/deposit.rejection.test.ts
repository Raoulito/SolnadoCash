// app/src/pages/deposit.rejection.test.ts
//
// FE-11: whether the staged note is discarded hinges entirely on distinguishing "the wallet
// refused to sign" from "the send failed somehow". sendTransaction signs AND submits, so only
// the first proves nothing reached the network; anything else may have broadcast a transaction
// that lands, and discarding the note then destroys the deposit.
//
// The classifier is therefore asymmetric on purpose: it must never call an ambiguous failure a
// rejection. These tests pin both directions, because a false positive here loses funds.

import { describe, expect, it } from 'vitest';
import { isWalletRejection } from './Deposit';

describe('isWalletRejection', () => {
  it('recognises the standard EIP-1193 style rejection code', () => {
    expect(isWalletRejection(Object.assign(new Error('nope'), { code: 4001 }))).toBe(true);
  });

  it('recognises the wallet-adapter and Phantom rejection messages', () => {
    for (const msg of [
      'User rejected the request.',
      'User rejected the request',
      'user denied transaction signature',
      'Request rejected',
    ]) {
      expect(isWalletRejection(new Error(msg))).toBe(true);
    }
  });

  it('does NOT treat a send timeout as a rejection', () => {
    // The dangerous case: the transaction may be in the mempool and may land.
    for (const msg of [
      'Transaction was not confirmed in 30.00 seconds',
      'failed to send transaction: Node is behind by 42 slots',
      'fetch failed',
      'Network request failed',
      'socket hang up',
      '503 Service Unavailable',
      'blockhash not found',
    ]) {
      expect(isWalletRejection(new Error(msg))).toBe(false);
    }
  });

  it('does not treat a missing or odd error as a rejection', () => {
    expect(isWalletRejection(undefined)).toBe(false);
    expect(isWalletRejection(null)).toBe(false);
    expect(isWalletRejection({})).toBe(false);
    expect(isWalletRejection('some string')).toBe(false);
  });

  it('does not mistake an unrelated 4001-like value for the code', () => {
    expect(isWalletRejection(new Error('error 4001 occurred while sending'))).toBe(false);
  });
});
