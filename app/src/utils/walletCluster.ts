// app/src/utils/walletCluster.ts
//
// "Refuse to act unless the wallet is on devnet" — as close as that is actually implementable.
//
// ── What is NOT possible, so nobody re-attempts it ──────────────────────────────────────────
//
// A dApp cannot read which cluster the user's wallet has selected. Checked, not assumed:
//
//   - `WalletContextState` (@solana/wallet-adapter-react) exposes `publicKey`, `connected` and the
//     signing functions. No network, no cluster.
//   - The `Adapter` interface in @solana/wallet-adapter-base has no network field at all.
//   - Wallet Standard accounts carry `chains`, but its own docs define it as "chains supported by
//     the account" — Phantom advertises solana:mainnet, solana:devnet and solana:testnet
//     simultaneously regardless of the user's setting, so it says nothing about the selection.
//   - Phantom exposes no cluster getter on its injected provider. Its `cluster` parameter exists
//     only in mobile deeplink sessions.
//
// So a check phrased as "is the wallet on devnet?" cannot be answered. Asking it anyway and
// guessing would produce a guard that reports safety it never established, which is worse than no
// guard.
//
// ── What IS decidable, and why it is the better question ────────────────────────────────────
//
// "Can this wallet actually complete a devnet deposit?" — answerable, by reading the connected
// address's balance through the app's own devnet RPC. It is a genuine precondition rather than a
// proxy: depositing 0.1 SOL requires 0.1 devnet SOL to exist at that address, whatever the wallet's
// UI is set to.
//
// And it fires in exactly the case that matters here. A wallet switched to mainnet has never
// received a devnet airdrop, so its devnet balance is 0 and the deposit is blocked before any
// click reaches the wallet.
//
// ── The residual case, stated plainly ───────────────────────────────────────────────────────
//
// A wallet holding devnet SOL *and* switched to mainnet passes this check. That is not a funds
// risk: the transaction carries a devnet blockhash and the devnet program id, and it is submitted
// through the app's devnet connection, so mainnet lamports are unreachable by construction. The
// consequence is a signing error from the wallet, not a loss. This check removes the common,
// confusing case; the impossibility of spending mainnet funds is what removes the danger.

import type { Connection, PublicKey } from '@solana/web3.js';

/**
 * Headroom above the denomination: the signature fee plus slack for a priority fee. Deliberately
 * small — this is a "can you pay at all" gate, not a fee estimator.
 */
export const DEPOSIT_FEE_HEADROOM_LAMPORTS = 10_000n;

export type WalletClusterVerdict =
  | { ok: true; balanceLamports: bigint }
  | {
      ok: false;
      code: 'insufficient' | 'unreadable';
      balanceLamports: bigint | null;
      requiredLamports: bigint;
      message: string;
    };

export class WalletNotOnClusterError extends Error {
  readonly code: 'insufficient' | 'unreadable';

  constructor(verdict: Extract<WalletClusterVerdict, { ok: false }>) {
    super(verdict.message);
    this.name = 'WalletNotOnClusterError';
    this.code = verdict.code;
  }
}

function formatSol(lamports: bigint): string {
  // Trim trailing zeros so 0.1 does not render as 0.100000000.
  const s = (Number(lamports) / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' ? '0' : s;
}

/**
 * Decide whether `owner` can fund a deposit of `denominationLamports` on the cluster behind
 * `connection`.
 *
 * Never throws. An unreadable balance returns `ok: false`, because "we could not check" must not be
 * treated as "it is fine".
 */
export async function checkWalletCanDeposit(
  connection: Pick<Connection, 'getBalance'>,
  owner: PublicKey,
  denominationLamports: bigint,
  clusterLabel = 'devnet'
): Promise<WalletClusterVerdict> {
  const required = denominationLamports + DEPOSIT_FEE_HEADROOM_LAMPORTS;

  let balance: bigint;
  try {
    balance = BigInt(await connection.getBalance(owner));
  } catch (err) {
    return {
      ok: false,
      code: 'unreadable',
      balanceLamports: null,
      requiredLamports: required,
      message:
        `Could not read this wallet's ${clusterLabel} balance ` +
        `(${err instanceof Error ? err.message : String(err)}), so the deposit is blocked. ` +
        `Check your connection and try again.`,
    };
  }

  if (balance >= required) {
    return { ok: true, balanceLamports: balance };
  }

  const empty = balance === 0n;
  return {
    ok: false,
    code: 'insufficient',
    balanceLamports: balance,
    requiredLamports: required,
    message: empty
      ? `This wallet holds no ${clusterLabel} SOL. The most likely reason is that your wallet is ` +
        `set to Mainnet — this app only operates on ${clusterLabel}, and a ${clusterLabel} ` +
        `deposit has to be funded with ${clusterLabel} SOL.`
      : `This wallet holds ${formatSol(balance)} ${clusterLabel} SOL, but this deposit needs ` +
        `${formatSol(required)} including the transaction fee.`,
  };
}

/**
 * Gate for the deposit path. Call before generating a note or building a transaction.
 *
 * @throws WalletNotOnClusterError when the wallet cannot fund the deposit.
 */
export async function assertWalletCanDeposit(
  connection: Pick<Connection, 'getBalance'>,
  owner: PublicKey,
  denominationLamports: bigint,
  clusterLabel = 'devnet'
): Promise<void> {
  const verdict = await checkWalletCanDeposit(
    connection,
    owner,
    denominationLamports,
    clusterLabel
  );
  if (!verdict.ok) throw new WalletNotOnClusterError(verdict);
}
