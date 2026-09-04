// app/src/utils/walletCluster.test.ts

import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  checkWalletCanDeposit,
  assertWalletCanDeposit,
  WalletNotOnClusterError,
  DEPOSIT_FEE_HEADROOM_LAMPORTS,
} from './walletCluster';

const OWNER = Keypair.generate().publicKey;
const DENOM = 100_000_000n; // 0.1 SOL

function conn(balance: number | Error) {
  return {
    getBalance: () =>
      balance instanceof Error ? Promise.reject(balance) : Promise.resolve(balance),
  };
}

describe('walletCluster', () => {
  it('allows a wallet funded above denomination + fee headroom', async () => {
    const v = await checkWalletCanDeposit(
      conn(Number(DENOM + DEPOSIT_FEE_HEADROOM_LAMPORTS)),
      OWNER,
      DENOM
    );
    expect(v.ok).toBe(true);
  });

  // ── The case the user hit: wallet switched to mainnet ────────────────────────

  it('blocks a wallet with zero balance and names the likely cause', async () => {
    const v = await checkWalletCanDeposit(conn(0), OWNER, DENOM);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('insufficient');
      expect(v.balanceLamports).toBe(0n);
      expect(v.message).toMatch(/no devnet SOL/);
      expect(v.message).toMatch(/set to Mainnet/);
    }
  });

  it('blocks one lamport short of the requirement', async () => {
    const v = await checkWalletCanDeposit(
      conn(Number(DENOM + DEPOSIT_FEE_HEADROOM_LAMPORTS - 1n)),
      OWNER,
      DENOM
    );
    expect(v.ok).toBe(false);
  });

  it('blocks a wallet holding the denomination but nothing for the fee', async () => {
    // Exactly 0.1 SOL cannot pay 0.1 SOL plus a signature fee.
    const v = await checkWalletCanDeposit(conn(Number(DENOM)), OWNER, DENOM);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/including the transaction fee/);
  });

  it('reports the real balance in the message when partially funded', async () => {
    const v = await checkWalletCanDeposit(conn(50_000_000), OWNER, DENOM);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/0\.05 devnet SOL/);
  });

  // ── Fail closed ─────────────────────────────────────────────────────────────

  it('blocks when the balance cannot be read', async () => {
    const v = await checkWalletCanDeposit(conn(new Error('429')), OWNER, DENOM);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('unreadable');
      expect(v.balanceLamports).toBeNull();
      expect(v.message).toMatch(/429/);
    }
  });

  it('uses the cluster label it was given', async () => {
    const v = await checkWalletCanDeposit(conn(0), OWNER, DENOM, 'testnet');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/no testnet SOL/);
  });

  // ── assert form ─────────────────────────────────────────────────────────────

  it('assert resolves when funded', async () => {
    await expect(
      assertWalletCanDeposit(conn(1_000_000_000), OWNER, DENOM)
    ).resolves.toBeUndefined();
  });

  it('assert throws WalletNotOnClusterError when empty', async () => {
    await expect(assertWalletCanDeposit(conn(0), OWNER, DENOM)).rejects.toThrow(
      WalletNotOnClusterError
    );
  });

  it('assert throws when the balance is unreadable', async () => {
    await expect(
      assertWalletCanDeposit(conn(new Error('offline')), OWNER, DENOM)
    ).rejects.toThrow(/blocked/);
  });

  it('scales with the denomination — 100 SOL needs 100 SOL', async () => {
    const big = 100_000_000_000n;
    const v = await checkWalletCanDeposit(conn(Number(DENOM)), OWNER, big);
    expect(v.ok).toBe(false);
  });
});
