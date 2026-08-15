import { useState, useEffect } from 'react';
import { useWallet, useConnection, useAnchorWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PublicKey } from '@solana/web3.js';
import { generateNote, initPoseidon, poseidonHash } from '@solnadocash/sdk';
import PoolSelector from '../components/PoolSelector';
import AnonymitySet from '../components/AnonymitySet';
import NoteDisplay from '../components/NoteDisplay';
import { usePoolInfo } from '../hooks/usePool';
import { getProgram, buildDepositTx } from '../utils/program';
import { markDepositedThisSession } from '../components/PrivacyNotice';
import { stageNote, markNoteStatus, clearNote } from '../utils/noteVault';
import { explorerTxUrl, type PoolConfig } from '../config';

type Step = 'select' | 'confirm' | 'processing' | 'note' | 'next';

/**
 * Did the wallet definitively refuse to sign?
 *
 * Only this case proves no transaction reached the network. Everything else must be treated
 * as "may have been broadcast", because sendTransaction submits as well as signs.
 */
export function isWalletRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === 4001 ||
    /user rejected|rejected the request|user denied|request rejected/i.test(msg)
  );
}

interface DepositProps {
  onGoToWithdraw: () => void;
  onNoteLock: (locked: boolean) => void;
}

export default function Deposit({ onGoToWithdraw, onNoteLock }: DepositProps) {
  const { connected, publicKey, sendTransaction } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();

  const [step, setStep] = useState<Step>('select');
  const [pool, setPool] = useState<PoolConfig | null>(null);
  const [secretNote, setSecretNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [confirmUnknown, setConfirmUnknown] = useState(false);

  // T42: Pool saturation check
  const { info: poolInfo, loading: poolLoading } = usePoolInfo(pool?.address || null);

  // Lock navigation while note is displayed
  useEffect(() => {
    onNoteLock(step === 'note');
  }, [step, onNoteLock]);

  // Not connected
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
    const canContinue = pool && pool.address && !poolInfo?.isPaused && !poolInfo?.isSaturated;

    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold mb-1">Deposit</h2>
          <p className="text-zinc-400 text-sm">
            Choose how much to deposit into a privacy pool.
          </p>
        </div>

        <PoolSelector selected={pool} onSelect={setPool} />

        {pool && !pool.address && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
            <p className="text-red-400 text-sm font-medium mb-1">
              Pool not deployed
            </p>
            <p className="text-red-400/70 text-xs">
              This pool has not been initialized on devnet yet. Contact the admin
              or run the deploy script.
            </p>
          </div>
        )}

        {pool && pool.address && (
          <div className="bg-zinc-800/50 rounded-xl p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Amount</span>
              <span className="text-zinc-200">{pool.denominationSol} SOL</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Privacy fee (0.2%, on withdrawal)</span>
              <span className="text-zinc-200">
                {pool.denominationSol / 500} SOL
              </span>
            </div>
            {poolInfo && (
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Pool capacity used</span>
                <span className="text-zinc-200">
                  {poolInfo.nextIndex.toLocaleString()} / 950,000
                </span>
              </div>
            )}
          </div>
        )}

        {poolInfo && (
          <AnonymitySet depositCount={poolInfo.nextIndex} context="deposit" />
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
          disabled={!canContinue}
          className={`w-full py-3.5 rounded-xl font-semibold text-sm transition-all ${
            canContinue
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
      if (!pool || !pool.address || !publicKey || !anchorWallet) return;
      setStep('processing');
      setError(null);
      setConfirmUnknown(false);

      try {
        // Initialize Poseidon hash (loads WASM, cached after first call)
        await initPoseidon();

        // Generate a real secret note with the SDK
        const poolPda = new PublicKey(pool.address);
        const note = generateNote(pool.denominationLamports, poolPda);

        // Compute Poseidon commitment = H(nullifier, secret, denomination)
        const commitment = poseidonHash(
          note.nullifier,
          note.secret,
          note.denomination
        );

        // Build the transaction BEFORE staging the note, so a build failure (an RPC hiccup
        // fetching a blockhash, say) cannot leave a staged note behind for a deposit that
        // was never attempted.
        const program = getProgram(connection, anchorWallet);
        const tx = await buildDepositTx(program, poolPda, publicKey, commitment);

        // FE-1: persist the note BEFORE broadcasting. Once the transaction is in flight the
        // deposit may land whatever happens next in this browser, and the note is the only
        // way to ever withdraw it. If storage is unavailable, refuse to deposit rather than
        // risk an unrecoverable deposit — a blocked deposit is recoverable, a lost note is
        // not.
        if (
          !stageNote({
            note: note.encoded,
            poolAddress: pool.address,
            denominationSol: pool.denominationSol,
          })
        ) {
          setError(
            'Cannot save your secret note to this browser\'s storage, so the deposit was ' +
              'not sent. Without saved storage a network interruption could lose the note ' +
              'and the funds with it. Disable private browsing or allow site storage, then ' +
              'try again.'
          );
          setStep('confirm');
          return;
        }

        // The note is safe from here on, so surface it immediately: every later failure
        // path can show it rather than discard it.
        setSecretNote(note.encoded);

        // Sign and send via wallet adapter.
        let sig: string;
        try {
          sig = await sendTransaction(tx, connection);
        } catch (sendErr) {
          // FE-11: only a definite wallet rejection proves nothing reached the network.
          // sendTransaction both signs AND submits, so any other failure — a send-RPC
          // timeout, a dropped response — may still have broadcast a transaction that
          // lands. Discarding the note in that case would recreate the fund-loss bug this
          // whole mechanism exists to prevent, so the note is kept and the recovery banner
          // will offer it on the next load.
          if (isWalletRejection(sendErr)) {
            clearNote(note.encoded);
            setSecretNote('');
          }
          throw sendErr;
        }
        markNoteStatus(note.encoded, 'sent', sig);
        setTxSig(sig);

        // Record the deposit so the withdraw flow can warn about same-session
        // correlation (H-6).
        markDepositedThisSession();

        try {
          await connection.confirmTransaction(sig, 'confirmed');
          markNoteStatus(note.encoded, 'confirmed', sig);
        } catch {
          // The transaction was broadcast and may well have succeeded — confirmation
          // timeouts are routine under congestion. Showing an error here and dropping the
          // note was the original fund-loss bug. Show the note, and say what is unknown.
          setConfirmUnknown(true);
        }
        setStep('note');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Transaction failed';
        if (isWalletRejection(err)) {
          setError('Transaction cancelled.');
        } else if (msg.includes('insufficient') || msg.includes('not enough')) {
          setError('Not enough SOL in your wallet.');
        } else if (msg.includes('PoolPaused')) {
          setError('This pool is currently paused by the admin.');
        } else if (msg.includes('PoolSaturated') || msg.includes('TreeFull')) {
          setError('This pool is full. Try a different denomination.');
        } else {
          // The note is still in storage at this point and may correspond to a deposit that
          // landed, so do not imply the attempt simply failed.
          setError(
            `${msg}\n\nYour secret note has been saved in this browser in case the ` +
              `deposit went through. Check the pool before depositing again. See the ` +
              `unsaved-notes banner.`
          );
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
            <span className="text-zinc-400">Leaves your wallet now</span>
            <span className="text-zinc-100 font-semibold">{pool!.denominationSol} SOL</span>
          </div>
          {/* FE-6: the fee is deducted from the withdrawal, not added to the deposit. Listing
              it beside "You deposit" read as though the wallet was paying 1.002 SOL today. */}
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Privacy fee (0.2%)</span>
            <span className="text-zinc-300">
              {pool!.denominationSol / 500} SOL, later
            </span>
          </div>
          <div className="border-t border-zinc-700 pt-3 flex justify-between text-sm">
            <span className="text-zinc-400">You will receive</span>
            <span className="text-zinc-100 font-semibold">a secret note</span>
          </div>
          <p className="text-zinc-500 text-xs leading-relaxed">
            Exactly {pool!.denominationSol} SOL leaves your wallet now. The 0.2% fee and the
            relayer fee are taken out of the amount you withdraw later, not charged today.
          </p>
        </div>

        <div className="bg-zinc-800/30 rounded-xl p-4">
          <p className="text-zinc-500 text-xs leading-relaxed">
            Your deposit goes into a shared pool. You'll receive a secret note.
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
          <span className="text-3xl mb-2 block">
            {confirmUnknown ? '\u26A0' : '\u2713'}
          </span>
          <h2
            className={`text-lg font-semibold mb-1 ${
              confirmUnknown ? 'text-amber-400' : 'text-green-400'
            }`}
          >
            {confirmUnknown ? 'Deposit sent, confirmation unknown' : 'Deposit successful!'}
          </h2>
          {txSig && (
            <a
              href={explorerTxUrl(txSig)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-400/70 text-xs hover:text-cyan-400 transition-colors underline"
            >
              View transaction
            </a>
          )}
        </div>

        {confirmUnknown && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
            <p className="text-amber-400 text-sm font-medium mb-1">
              We could not confirm the transaction
            </p>
            <p className="text-amber-400/70 text-xs leading-relaxed">
              The deposit was broadcast but the network did not confirm it in time. It has
              probably succeeded. Save the note below either way, then check the transaction
              link: if it succeeded the note is your only way to withdraw, and if it failed
              the note is simply unusable. Do not deposit again until you have checked, or
              you may deposit twice.
            </p>
          </div>
        )}

        <NoteDisplay
          note={secretNote}
          onDone={() => {
            // Only now is the note safe to drop from storage: the user has stated they
            // have it somewhere else.
            clearNote(secretNote);
            setStep('next');
          }}
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
                Your SOL is now in the privacy pool. There is no <strong className="text-zinc-300">on-chain</strong> link between this deposit and a future withdrawal.
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
                Enter <strong className="text-zinc-300">any</strong> wallet address as recipient. Wait before withdrawing. Withdrawing immediately, from this same network, lets the relayer and your RPC provider correlate the two by timing.
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
