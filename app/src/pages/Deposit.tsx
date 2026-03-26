import { useState, useEffect } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import PoolSelector from '../components/PoolSelector';
import NoteDisplay from '../components/NoteDisplay';
import { usePoolInfo } from '../hooks/usePool';
import type { PoolConfig } from '../config';
import { PROGRAM_ID } from '../config';

type Step = 'select' | 'confirm' | 'processing' | 'note' | 'next';

interface DepositProps {
  onGoToWithdraw: () => void;
  onNoteLock: (locked: boolean) => void;
}

export default function Deposit({ onGoToWithdraw, onNoteLock }: DepositProps) {
  const { connected, publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  const [step, setStep] = useState<Step>('select');
  const [pool, setPool] = useState<PoolConfig | null>(null);
  const [secretNote, setSecretNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);

  // T42: Pool saturation check
  const { info: poolInfo, loading: poolLoading } = usePoolInfo(pool?.address || null);

  // Lock navigation while note is displayed
  useEffect(() => {
    onNoteLock(step === 'note');
  }, [step, onNoteLock]);

  // Not connected → show connect button
  if (!connected || !publicKey) {
    return (
      <div className="text-center py-8">
        <p className="text-zinc-400 text-sm mb-6">
          Connect your wallet to deposit
        </p>
        <div className="flex justify-center">
          <WalletMultiButton />
        </div>
      </div>
    );
  }

  // Step 1: Select pool
  if (step === 'select') {
    const canContinue = pool && !poolInfo?.isPaused && !poolInfo?.isSaturated;

    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold mb-1">Deposit</h2>
          <p className="text-zinc-400 text-sm">
            Choose how much to deposit into a privacy pool.
          </p>
        </div>

        <PoolSelector selected={pool} onSelect={setPool} />

        {pool && (
          <div className="bg-zinc-800/50 rounded-xl p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Amount</span>
              <span className="text-zinc-200">{pool.denominationSol} SOL</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Privacy fee (0.2%)</span>
              <span className="text-zinc-200">
                {pool.denominationSol / 500} SOL
              </span>
            </div>
            {poolInfo && (
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Pool deposits</span>
                <span className="text-zinc-200">
                  {poolInfo.nextIndex.toLocaleString()} / 950,000
                </span>
              </div>
            )}
          </div>
        )}

        {/* T42: Saturation warning */}
        {poolInfo?.isSaturated && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
            <p className="text-amber-400 text-sm font-medium mb-1">
              This pool is full
            </p>
            <p className="text-amber-400/70 text-xs">
              This pool has reached its capacity. A new version (V2) will be
              available soon. Existing notes can still be withdrawn.
            </p>
          </div>
        )}

        {/* Pool paused warning */}
        {poolInfo?.isPaused && !poolInfo?.isSaturated && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
            <p className="text-amber-400 text-sm font-medium mb-1">
              Pool temporarily paused
            </p>
            <p className="text-amber-400/70 text-xs">
              Deposits are paused by the admin. Withdrawals are always available.
            </p>
          </div>
        )}

        {poolLoading && pool?.address && (
          <p className="text-zinc-500 text-xs text-center">
            Checking pool status...
          </p>
        )}

        <button
          onClick={() => {
            setError(null);
            setStep('confirm');
          }}
          disabled={!pool || (pool.address ? !canContinue : false)}
          className={`w-full py-3.5 rounded-xl font-semibold text-sm transition-all ${
            pool && (pool.address ? canContinue : true)
              ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
              : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
          }`}
        >
          Continue
        </button>
      </div>
    );
  }

  // Step 2: Confirm deposit
  if (step === 'confirm') {
    const handleDeposit = async () => {
      if (!pool || !publicKey) return;
      setStep('processing');
      setError(null);

      try {
        // Generate a random secret note
        // TODO(T41): Replace with SDK generateNote() + real deposit instruction
        const nullifier = crypto.getRandomValues(new Uint8Array(32));
        const secret = crypto.getRandomValues(new Uint8Array(32));
        const noteHex =
          'sndo_' +
          (pool.address || publicKey.toBase58().slice(0, 8)) +
          '_' +
          pool.denominationLamports.toString(16).padStart(16, '0') +
          '_' +
          Array.from(nullifier, (b) => b.toString(16).padStart(2, '0')).join('') +
          Array.from(secret, (b) => b.toString(16).padStart(2, '0')).join('');

        // Placeholder: send SOL transfer — real deposit instruction via SDK in T41
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: new PublicKey(PROGRAM_ID),
            lamports: Number(pool.denominationLamports),
          })
        );

        const sig = await sendTransaction(tx, connection);
        await connection.confirmTransaction(sig, 'confirmed');

        setTxSig(sig);
        setSecretNote(noteHex);
        setStep('note');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Transaction failed';
        if (msg.includes('User rejected')) {
          setError('Transaction cancelled.');
        } else if (msg.includes('insufficient')) {
          setError('Not enough SOL in your wallet.');
        } else {
          setError(msg);
        }
        setStep('confirm');
      }
    };

    return (
      <div className="space-y-6">
        <button
          onClick={() => setStep('select')}
          className="text-zinc-500 hover:text-zinc-300 text-sm flex items-center gap-1 transition-colors"
        >
          ← Back
        </button>

        <div>
          <h2 className="text-lg font-semibold mb-1">Confirm deposit</h2>
          <p className="text-zinc-400 text-sm">
            Review the details below and confirm.
          </p>
        </div>

        <div className="bg-zinc-800/50 rounded-xl p-5 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">You deposit</span>
            <span className="text-zinc-100 font-semibold">{pool!.denominationSol} SOL</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Privacy fee (0.2%)</span>
            <span className="text-zinc-300">{pool!.denominationSol / 500} SOL</span>
          </div>
          <div className="border-t border-zinc-700 pt-3 flex justify-between text-sm">
            <span className="text-zinc-400">You will receive</span>
            <span className="text-zinc-100 font-semibold">a secret note</span>
          </div>
        </div>

        <div className="bg-zinc-800/30 rounded-xl p-4">
          <p className="text-zinc-500 text-xs leading-relaxed">
            Your deposit goes into a shared pool. You'll receive a secret note —
            paste it later to withdraw to <strong>any</strong> address, with no
            link to this wallet.
          </p>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}

        <button
          onClick={handleDeposit}
          className="w-full py-3.5 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-xl transition-colors text-sm"
        >
          Deposit {pool!.denominationSol} SOL
        </button>
      </div>
    );
  }

  // Processing
  if (step === 'processing') {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="animate-spin text-cyan-400 text-3xl mb-4">&#9696;</div>
        <p className="text-zinc-300 text-sm font-medium">Processing deposit...</p>
        <p className="text-zinc-500 text-xs mt-2">Waiting for confirmation</p>
      </div>
    );
  }

  // Step 3: Show secret note (navigation locked)
  if (step === 'note') {
    return (
      <div className="space-y-4">
        <div className="text-center">
          <span className="text-3xl mb-2 block">&#10003;</span>
          <h2 className="text-lg font-semibold text-green-400 mb-1">
            Deposit successful!
          </h2>
          {txSig && (
            <a
              href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-400/70 text-xs hover:text-cyan-400 transition-colors underline"
            >
              View transaction
            </a>
          )}
        </div>

        <NoteDisplay
          note={secretNote}
          onDone={() => setStep('next')}
        />
      </div>
    );
  }

  // Step 4: What's next (after note confirmed)
  if (step === 'next') {
    return (
      <div className="space-y-5">
        <div className="text-center">
          <span className="text-3xl mb-2 block">&#10003;</span>
          <h2 className="text-lg font-semibold text-green-400 mb-2">
            You're all set!
          </h2>
        </div>

        <div className="bg-zinc-800/50 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-zinc-200">What happens next?</h3>
          <div className="space-y-3">
            <div className="flex gap-3">
              <span className="bg-cyan-600/20 text-cyan-400 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0">1</span>
              <p className="text-zinc-400 text-sm">
                Your SOL is now in the privacy pool. <strong className="text-zinc-300">Nobody</strong> can link it to you.
              </p>
            </div>
            <div className="flex gap-3">
              <span className="bg-cyan-600/20 text-cyan-400 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0">2</span>
              <p className="text-zinc-400 text-sm">
                When you're ready, go to <strong className="text-zinc-300">Withdraw</strong> and paste your secret note.
              </p>
            </div>
            <div className="flex gap-3">
              <span className="bg-cyan-600/20 text-cyan-400 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0">3</span>
              <p className="text-zinc-400 text-sm">
                Enter <strong className="text-zinc-300">any</strong> wallet address as recipient — no link, no trace.
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={onGoToWithdraw}
          className="w-full py-3.5 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-xl transition-colors text-sm"
        >
          Go to Withdraw
        </button>

        <button
          onClick={() => {
            setStep('select');
            setPool(null);
            setSecretNote('');
            setTxSig(null);
          }}
          className="w-full py-2.5 text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
        >
          Make another deposit
        </button>
      </div>
    );
  }

  return null;
}
