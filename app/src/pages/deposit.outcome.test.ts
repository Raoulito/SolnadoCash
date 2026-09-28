// app/src/pages/deposit.outcome.test.ts
//
// L-5. Two ways the deposit screen misreported what happened.
//
// 1. Every send failure other than a wallet rejection was shown as "Deposit sent, it has probably
//    succeeded". A failed preflight simulation is not ambiguous: the RPC refused the transaction
//    before broadcasting it, so nothing can land. Telling the user it probably went through sends
//    them looking for funds that do not exist, and hides the real reason (paused pool, insufficient
//    balance) that the error mapping further down was written to show but could never reach.
// 2. Continue was enabled while the pool account could not be read, because the gate only looked at
//    the pool info's flags, which are absent when the read failed.

import { describe, expect, it } from 'vitest';
import { SendTransactionError } from '@solana/web3.js';
import { WalletSendTransactionError } from '@solana/wallet-adapter-base';
import { depositCanContinue, provesNotBroadcast, simulationLogs } from './Deposit';

function simulationFailure(message: string, logs: string[] = []) {
  return new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: message, logs });
}

describe('provesNotBroadcast (L-5)', () => {
  it('a failed preflight simulation proves nothing was broadcast', () => {
    const sim = simulationFailure('Transaction simulation failed: Error processing Instruction 0', [
      'Program log: AnchorError occurred. Error Code: PoolPaused.',
    ]);
    expect(provesNotBroadcast(sim)).toBe(true);
    // As a sign-only wallet's adapter wraps it.
    expect(provesNotBroadcast(new WalletSendTransactionError(sim.message, sim))).toBe(true);
  });

  it('a failure after broadcast, or of unknown origin, proves nothing', () => {
    const sent = new SendTransactionError({ action: 'send', signature: 'x', transactionMessage: 'err' });
    expect(provesNotBroadcast(sent)).toBe(false);
    expect(provesNotBroadcast(new WalletSendTransactionError('Unexpected error', new Error('Unexpected error')))).toBe(false);
    expect(provesNotBroadcast(new Error('Simulation failed.'))).toBe(false); // text alone is not evidence
    expect(provesNotBroadcast(undefined)).toBe(false);
  });
});

describe('depositCanContinue (L-5)', () => {
  const ready = {
    poolAddress: 'P', poolLoading: false, poolError: null as string | null,
    poolInfo: { isPaused: false, isSaturated: false }, clusterAllowed: true, walletBlock: null as string | null,
  };

  it('allows a readable, open pool', () => {
    expect(depositCanContinue(ready)).toBe(true);
  });

  it('refuses while the pool account cannot be read', () => {
    expect(depositCanContinue({ ...ready, poolInfo: null, poolError: 'Failed to read pool' })).toBe(false);
  });

  it('refuses while the pool is still being read', () => {
    expect(depositCanContinue({ ...ready, poolInfo: null, poolLoading: true })).toBe(false);
  });

  it('refuses a paused or full pool, a blocked cluster or wallet', () => {
    expect(depositCanContinue({ ...ready, poolInfo: { isPaused: true, isSaturated: false } })).toBe(false);
    expect(depositCanContinue({ ...ready, poolInfo: { isPaused: false, isSaturated: true } })).toBe(false);
    expect(depositCanContinue({ ...ready, clusterAllowed: false })).toBe(false);
    expect(depositCanContinue({ ...ready, walletBlock: 'no SOL' })).toBe(false);
    expect(depositCanContinue({ ...ready, poolAddress: '' })).toBe(false);
  });
});

describe('simulationLogs (L-5)', () => {
  it('exposes the program logs of a failed simulation, however the adapter wrapped it', () => {
    const logs = ['Program log: AnchorError occurred. Error Code: PoolPaused. Error Number: 6000.'];
    const sim = simulationFailure('Transaction simulation failed', logs);
    expect(simulationLogs(sim)).toEqual(logs);
    expect(simulationLogs(new WalletSendTransactionError(sim.message, sim))).toEqual(logs);
    expect(simulationLogs(new Error('x'))).toEqual([]);
  });
});
