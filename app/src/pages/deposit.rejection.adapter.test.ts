// @vitest-environment node
//
// app/src/pages/deposit.rejection.adapter.test.ts
//
// L-1. The staged note is deleted when isWalletRejection says the wallet refused to sign, because
// only that proves nothing reached the network. The classifier matched message TEXT, and for a
// wallet that only signs, the app's own RPC performs the broadcast: its error message is wrapped by
// the adapter and surfaces verbatim. A malicious or compromised RPC could accept the transaction and
// answer "User rejected the request", and the note of a deposit that lands was deleted.
//
// These drive the real wallet-adapter base class and a real web3.js Connection, with only the
// wallet's signing step and the RPC's HTTP response faked, so the errors have exactly the shape the
// app receives in production.

import { describe, expect, it } from 'vitest';
import {
  BaseSignerWalletAdapter,
  WalletReadyState,
  WalletSignTransactionError,
  type WalletName,
} from '@solana/wallet-adapter-base';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { isWalletRejection } from './Deposit';

const payer = Keypair.generate().publicKey;

/** A sign-only wallet: the adapter broadcasts through the app's connection. */
class SignOnlyWallet extends BaseSignerWalletAdapter {
  name = 'Test' as WalletName<'Test'>;
  url = 'https://example.test';
  icon = '';
  readyState = WalletReadyState.Installed;
  publicKey: PublicKey | null = payer;
  connecting = false;
  supportedTransactionVersions = new Set([0] as const);
  constructor(private readonly behaviour: 'approve' | 'reject') {
    super();
  }
  async connect() {}
  async disconnect() {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async signTransaction(tx: any) {
    if (this.behaviour === 'reject') {
      // What a wallet's signTransaction does when the user declines.
      throw new WalletSignTransactionError('User rejected the request.', { code: 4001 });
    }
    return tx;
  }
}

/** A connection to an RPC that answers every request with the given JSON-RPC error. */
function rpcReturning(error: { code: number; message: string }) {
  return new Connection('http://rpc.test', {
    fetch: (async (_url: string, init: { body: string }) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, error }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
  });
}

function depositTx() {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 })],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

async function sendError(wallet: SignOnlyWallet, connection: Connection): Promise<unknown> {
  try {
    await wallet.sendTransaction(depositTx(), connection);
  } catch (e) {
    return e;
  }
  throw new Error('expected sendTransaction to fail');
}

describe('isWalletRejection against real adapter errors (L-1)', () => {
  it('an RPC that answers "User rejected the request" is NOT a wallet rejection', async () => {
    // The wallet signed; the transaction went to the app's RPC. Whatever that RPC says, it may
    // have broadcast the deposit, so the note must be kept.
    const err = await sendError(
      new SignOnlyWallet('approve'),
      rpcReturning({ code: -32002, message: 'User rejected the request' })
    );
    expect(String((err as Error).message)).toMatch(/User rejected the request/);
    expect(isWalletRejection(err)).toBe(false);
  });

  it('an RPC that also sets error code 4001 is still NOT a wallet rejection', async () => {
    const err = await sendError(
      new SignOnlyWallet('approve'),
      rpcReturning({ code: 4001, message: 'User denied transaction signature' })
    );
    expect(isWalletRejection(err)).toBe(false);
  });

  it('the wallet declining to sign IS a rejection', async () => {
    const err = await sendError(new SignOnlyWallet('reject'), rpcReturning({ code: -1, message: 'unused' }));
    expect(isWalletRejection(err)).toBe(true);
  });
});
