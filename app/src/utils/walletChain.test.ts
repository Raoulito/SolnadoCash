// @vitest-environment node
//
// app/src/utils/walletChain.test.ts
//
// Which network Phantom is asked to sign for. The Wallet Standard adapter (used for Phantom and
// Solflare's extension) does not ask the wallet which network it is on; it works it out from the
// app's RPC URL with getChainForEndpoint, which says devnet only if the URL contains "devnet" and
// says MAINNET for any URL it does not recognise.
//
// Locally the RPC was https://devnet.helius-rpc.com/..., so deposits worked. The deployed build
// used https://<server>/rpc, so Phantom was asked to sign and simulate on mainnet: "not enough
// SOL", "simulation failed", for a wallet holding devnet SOL. The dev server never showed it.
//
// These run the real adapter against a fake Phantom that records the chain it is asked for, and
// require a production build to refuse an RPC URL that would put the wallet on another network.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { StandardWalletAdapter } from '@solana/wallet-standard-wallet-adapter-base';
import { loadConfigFromFile } from 'vite';
import { createWallets } from '../wallets';
import { NETWORK } from '../config';

/** A Wallet Standard wallet shaped like Phantom: it advertises every chain, whatever is selected. */
function fakePhantom() {
  const kp = Keypair.generate();
  const asked: string[] = [];
  const account = {
    address: kp.publicKey.toBase58(),
    publicKey: kp.publicKey.toBytes(),
    chains: ['solana:mainnet', 'solana:devnet', 'solana:testnet'],
    features: ['solana:signAndSendTransaction', 'solana:signTransaction'],
  };
  const wallet = {
    version: '1.0.0',
    name: 'Fake Phantom',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    chains: account.chains,
    accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async (...inputs: { chain: string }[]) => {
          asked.push(...inputs.map((i) => i.chain));
          return inputs.map(() => ({ signature: new Uint8Array(64) }));
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
          inputs.map((i) => ({ signedTransaction: i.transaction })),
      },
    },
  };
  return { wallet, asked, payer: kp.publicKey };
}

/** The chain the real adapter asks the wallet to sign and send on, for an app using `endpoint`. */
async function chainAskedFor(endpoint: string): Promise<string> {
  const { wallet, asked, payer } = fakePhantom();
  // The adapter reports itself "Unsupported" unless window and document exist; it reads nothing
  // from them. Node, not jsdom, because web3.js PDA code breaks across jsdom's realm.
  // It only reads them in its constructor, so they are removed again straight after, before they
  // can change how any other adapter behaves.
  const g = globalThis as Record<string, unknown>;
  const had = { window: 'window' in g, document: 'document' in g };
  if (!had.window) g.window = globalThis;
  if (!had.document) g.document = {};
  let adapter: StandardWalletAdapter;
  try {
    adapter = new StandardWalletAdapter({ wallet: wallet as never });
  } finally {
    if (!had.window) delete g.window;
    if (!had.document) delete g.document;
  }
  await adapter.connect();
  const tx = new Transaction({ feePayer: payer, recentBlockhash: '11111111111111111111111111111111' }).add(
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 })
  );
  await adapter.sendTransaction(tx, new Connection(endpoint));
  expect(asked).toHaveLength(1);
  return asked[0];
}

describe('the network wallets are asked to sign for', () => {
  it('is inferred from the RPC URL: an unrecognised URL means mainnet (the deployed bug)', async () => {
    expect(await chainAskedFor('https://203.0.113.10/rpc')).toBe('solana:mainnet');
  });

  it('was devnet locally only because the provider hostname says devnet', async () => {
    expect(await chainAskedFor('https://devnet.helius-rpc.com/?api-key=x')).toBe('solana:devnet');
  });

  it('is devnet for a proxy path that names the network, which the deploy now uses', async () => {
    expect(await chainAskedFor('https://203.0.113.10/rpc/devnet')).toBe('solana:devnet');
  });
});

const CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vite.config.ts');

async function build(envFile: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const cwd = process.cwd();
  try {
    writeFileSync(path.join(dir, '.env.production'), envFile);
    process.chdir(dir);
    return await loadConfigFromFile({ command: 'build', mode: 'production' }, CONFIG, dir, 'silent');
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a production build', () => {
  // vitest loads app/.env.local into process.env, and the config lets the shell win over files.
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!k.startsWith('VITE_')) continue;
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  });

  it('refuses an RPC URL that would make wallets sign for a different network', async () => {
    await expect(
      build('VITE_SOLANA_NETWORK=devnet\nVITE_RPC_ENDPOINT=https://203.0.113.10/rpc\n')
    ).rejects.toThrow(/solana:mainnet.*devnet/s);
  });

  it('accepts one that names the network, and the default endpoint', async () => {
    await expect(build('VITE_SOLANA_NETWORK=devnet\nVITE_RPC_ENDPOINT=https://203.0.113.10/rpc/devnet\n')).resolves.toBeTruthy();
    await expect(build('VITE_SOLANA_NETWORK=devnet\n')).resolves.toBeTruthy();
  });

  it('never prints the API key when it refuses', async () => {
    const err = await build('VITE_SOLANA_NETWORK=devnet\nVITE_RPC_ENDPOINT=https://rpc.example/x?api-key=SECRET123\n').catch((e) => e);
    expect(String(err)).not.toContain('SECRET123');
  });
});

describe('the Solflare adapter used without its extension', () => {
  it("is told the app's network instead of defaulting to mainnet", () => {
    const solflare = createWallets().find((w) => w.name === 'Solflare') as unknown as {
      _config: { network?: string };
    };
    expect(solflare._config.network).toBe(NETWORK);
  });
});
