import { useState, useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import {
  decodeNote,
  initPoseidon,
  generateWithdrawProof,
  validateFeeQuote,
  type SecretNote,
  type FeeQuote,
  type FeeBreakdown,
} from '@solnadocash/sdk';
import ProgressIndicator, { type ProgressStep } from '../components/ProgressIndicator';
import { rebuildMerkleTree } from '../utils/merkle';
import { fetchFeeQuote, submitProof } from '../hooks/useRelayer';
import PrivacyNotice, { depositedThisSession } from '../components/PrivacyNotice';
import AnonymitySet from '../components/AnonymitySet';
import { usePoolInfo } from '../hooks/usePool';
import { explorerTxUrl } from '../config';

type Step = 'paste' | 'recipient' | 'confirm' | 'progress' | 'done';

const PROGRESS_STEPS: ProgressStep[] = [
  { label: 'Fetching fee quote & Merkle tree', estimatedSeconds: 10 },
  { label: 'Generating ZK proof', estimatedSeconds: 30 },
  { label: 'Submitting to relayer', estimatedSeconds: 10 },
];

const CIRCUIT_PATHS = {
  wasmPath: '/circuits/withdraw.wasm',
  zkeyPath: '/circuits/withdraw_final.zkey',
};

interface ParsedNote {
  raw: string;
  poolAddress: string;
  denominationLamports: bigint;
  denominationSol: number;
}

function parseNote(raw: string): ParsedNote | null {
  try {
    const note = decodeNote(raw.trim());
    return {
      raw: note.encoded,
      poolAddress: note.poolAddress.toBase58(),
      denominationLamports: note.denomination,
      denominationSol: Number(note.denomination) / 1e9,
    };
  } catch {
    return null;
  }
}

function isValidSolanaAddress(addr: string): boolean {
  try {
    new PublicKey(addr);
    return true;
  } catch {
    return false;
  }
}

export default function Withdraw() {
  const { connection } = useConnection();
  const { publicKey: connectedWallet } = useWallet();

  const [step, setStep] = useState<Step>('paste');
  const [noteInput, setNoteInput] = useState('');
  const [parsedNote, setParsedNote] = useState<ParsedNote | null>(null);
  const [recipient, setRecipient] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [progressStep, setProgressStep] = useState(-1);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [feeTaken, setFeeTaken] = useState<string | null>(null);
  const [breakdown, setBreakdown] = useState<FeeBreakdown | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // H-6: honest linkability warnings
  const isOwnWallet =
    !!connectedWallet && recipient.trim() === connectedWallet.toBase58();
  const sameSession = depositedThisSession();

  // M-1: surface the real anonymity set for the pool this note belongs to.
  const { info: poolInfo } = usePoolInfo(parsedNote?.poolAddress ?? null);

  // Withdrawal logic — lifted out so it can be called from confirm AND retry
  // F-3: a stale root is the expected outcome of root-ring griefing — an attacker making
  // 256 deposits rotates every prior root out, invalidating any proof generated but not
  // yet submitted. Making the user notice and click "retry" is what turns a cheap,
  // repeatable nuisance into a denial of service. Retrying automatically against a fresh
  // tree means the attacker has to sustain 256 deposits for every single attempt, which
  // is no longer cheap.
  const MAX_STALE_ROOT_RETRIES = 2;

  const executeWithdraw = useCallback(async (attempt = 0) => {
    if (!parsedNote) return;

    setStep('progress');
    setProgressStep(0);
    setProgressError(null);

    try {
      // Decode the full note with SDK (validates all fields)
      const note: SecretNote = decodeNote(parsedNote.raw);
      const poolPubkey = note.poolAddress;

      // Step 0: Fetch fee quote + rebuild Merkle tree in parallel
      await initPoseidon();

      // Re-fetch the quote: the one shown on the confirm screen may have expired
      // during review. Validate again and abort if the terms got worse, so the
      // user is never silently committed to a fee they did not see (H-4).
      const [feeQuoteRaw, merkleTree] = await Promise.all([
        fetchFeeQuote(poolPubkey.toBase58()),
        rebuildMerkleTree(connection, poolPubkey),
      ]);

      const quote: FeeQuote = {
        relayerAddress: new PublicKey(feeQuoteRaw.relayerAddress),
        relayerFeeMax: BigInt(feeQuoteRaw.relayerFeeMax),
        validUntil: feeQuoteRaw.validUntil,
        estimatedUserReceives: BigInt(feeQuoteRaw.estimatedUserReceives),
      };
      const shownMax = breakdown?.relayerFeeMax ?? quote.relayerFeeMax;
      validateFeeQuote(note.denomination, quote, { maxRelayerFee: shownMax });

      // Step 1: Generate ZK proof (CPU-intensive, ~15-60s)
      setProgressStep(1);

      const { proof, publicSignals } = await generateWithdrawProof(
        note,
        quote,
        new PublicKey(recipient),
        merkleTree,
        CIRCUIT_PATHS
      );

      // Step 2: Submit to relayer
      setProgressStep(2);

      const result = await submitProof({
        proof: proof,
        publicSignals: publicSignals.map((s) => s.toString()),
        poolAddress: poolPubkey.toBase58(),
        recipient,
        relayerFeeMax: feeQuoteRaw.relayerFeeMax,
      });

      setTxSig(result.txSignature || null);
      setFeeTaken(result.feeTaken || null);
      setStep('done');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Withdrawal failed';

      // Network / relayer unreachable
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        setProgressError(
          'Could not reach the relayer service. Make sure it is running:\n' +
          'cd relayer && npm start'
        );
      }
      // Fee quote failure
      else if (msg.includes('fee_quote') || msg.includes('Fee quote')) {
        setProgressError('Could not get a fee quote from the relayer. Make sure it is running.');
      }
      // Merkle tree / commitment errors
      else if (msg.includes('Commitment not found')) {
        setProgressError(
          'Your deposit was not found in the Merkle tree. ' +
          'This can happen if the pool address in the note doesn\'t match a deployed pool, ' +
          'or if the deposit transaction hasn\'t been confirmed yet.'
        );
      }
      // On-chain program errors (mapped by relayer)
      else if (msg.includes('InvalidAddress')) {
        setProgressError('Invalid address in note or recipient.');
      } else if (msg.includes('NullifierSpent')) {
        setProgressError('This note has already been used. Each note can only be withdrawn once.');
      } else if (msg.includes('InvalidProof')) {
        setProgressError('Proof verification failed. The Merkle tree may be out of sync — try again.');
      } else if (msg.includes('StaleRoot') || msg.includes('RootNotFound')) {
        if (attempt < MAX_STALE_ROOT_RETRIES) {
          // Rebuild from current state and prove again. No user action required.
          setProgressError(null);
          setProgressStep(0);
          void executeWithdraw(attempt + 1);
          return;
        }
        setProgressError(
          'The Merkle root kept changing while your proof was being generated, after ' +
          `${MAX_STALE_ROOT_RETRIES + 1} attempts. This can happen under heavy deposit ` +
          'traffic. Your note is unspent and still valid — try again in a few minutes.'
        );
      } else if (msg.includes('InvalidWithdrawalCommitment')) {
        setProgressError('Withdrawal commitment mismatch. The relayer address or fee may have changed — try again.');
      } else if (msg.includes('RelayerFeeExceedsMax')) {
        setProgressError('The relayer fee exceeds the maximum agreed in the proof. Try again with a fresh fee quote.');
      } else if (msg.includes('FeeInvariantViolated')) {
        setProgressError('Fee invariant check failed on-chain. This is a bug — please report it.');
      }
      // Relayer operational errors
      else if (msg.includes('RelayerInsufficientFunds')) {
        setProgressError('The relayer wallet has insufficient SOL to submit the transaction. Contact the operator.');
      } else if (msg.includes('BlockhashExpired')) {
        setProgressError('Transaction expired before confirmation. Try again.');
      } else if (msg.includes('AccountNotFound')) {
        setProgressError('A required on-chain account was not found. The pool may not be deployed.');
      } else if (msg.includes('SimulationFailed')) {
        setProgressError('Transaction simulation failed on-chain.\n' + msg);
      } else if (msg.includes('RelayerBusy') || msg.includes('TooManyRequests')) {
        setProgressError('The relayer is busy. Please wait a moment and try again.');
      }
      // Fallback — show the raw message
      else {
        setProgressError(msg);
      }
    }
  }, [parsedNote, recipient, connection]);

  // Step 1: Paste note
  if (step === 'paste') {
    const handleNext = () => {
      const parsed = parseNote(noteInput);
      if (!parsed) {
        setNoteError(
          'Invalid note. It should start with "sndo_" and contain your deposit data ' +
          '(pool address, denomination, nullifier, and secret).'
        );
        return;
      }
      setParsedNote(parsed);
      setNoteError(null);
      setStep('recipient');
    };

    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold mb-1">Withdraw</h2>
          <p className="text-zinc-400 text-sm">
            Paste the secret note you received when you deposited.
          </p>
        </div>

        <div>
          <textarea
            value={noteInput}
            onChange={(e) => {
              setNoteInput(e.target.value);
              setNoteError(null);
            }}
            placeholder="sndo_..."
            rows={3}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-sm font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 resize-none transition-colors"
            spellCheck={false}
            autoComplete="off"
          />
          {noteError && (
            <p className="text-red-400 text-xs mt-2">{noteError}</p>
          )}
        </div>

        <button
          onClick={handleNext}
          disabled={!noteInput.trim()}
          className={`w-full py-3.5 rounded-xl font-semibold text-sm transition-all ${
            noteInput.trim()
              ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
              : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
          }`}
        >
          Continue
        </button>
      </div>
    );
  }

  // Step 2: Enter recipient
  if (step === 'recipient') {
    const handleNext = async () => {
      if (!isValidSolanaAddress(recipient)) {
        setRecipientError('Enter a valid Solana wallet address.');
        return;
      }
      if (!parsedNote) return;

      // H-4: the relayer fee ceiling is bound into the ZK proof, and the relayer
      // may then claim all of it. So fetch and validate the quote BEFORE showing
      // the confirmation, and show the real numbers rather than a placeholder.
      setRecipientError(null);
      setQuoteLoading(true);
      setQuoteError(null);
      try {
        const raw = await fetchFeeQuote(parsedNote.poolAddress);
        const quote: FeeQuote = {
          relayerAddress: new PublicKey(raw.relayerAddress),
          relayerFeeMax: BigInt(raw.relayerFeeMax),
          validUntil: raw.validUntil,
          estimatedUserReceives: BigInt(raw.estimatedUserReceives),
        };
        // Every displayed figure is recomputed locally from the denomination;
        // the relayer's own claim is only cross-checked.
        const b = validateFeeQuote(parsedNote.denominationLamports, quote);
        setBreakdown(b);
        setStep('confirm');
      } catch (err: unknown) {
        setQuoteError(
          err instanceof Error ? err.message : 'Could not get a usable fee quote'
        );
      } finally {
        setQuoteLoading(false);
      }
    };

    return (
      <div className="space-y-6">
        <button
          onClick={() => setStep('paste')}
          className="text-zinc-500 hover:text-zinc-300 text-sm flex items-center gap-1 transition-colors"
        >
          ← Back
        </button>

        <div>
          <h2 className="text-lg font-semibold mb-1">Where to withdraw?</h2>
          <p className="text-zinc-400 text-sm">
            Enter the Solana address that will receive the funds.
            It can be any wallet. There is no on-chain link to your deposit.
          </p>
        </div>

        {parsedNote && (
          <div className="bg-zinc-800/50 rounded-xl p-4">
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Amount</span>
              <span className="text-zinc-200 font-medium">
                {parsedNote.denominationSol} SOL
              </span>
            </div>
          </div>
        )}

        <div>
          <input
            type="text"
            value={recipient}
            onChange={(e) => {
              setRecipient(e.target.value);
              setRecipientError(null);
            }}
            placeholder="Recipient wallet address"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-sm font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 transition-colors"
            spellCheck={false}
            autoComplete="off"
          />
          {recipientError && (
            <p className="text-red-400 text-xs mt-2">{recipientError}</p>
          )}
        </div>

        {quoteError && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
            <p className="text-red-400 text-sm">{quoteError}</p>
          </div>
        )}

        <button
          onClick={handleNext}
          disabled={!recipient.trim() || quoteLoading}
          className={`w-full py-3.5 rounded-xl font-semibold text-sm transition-all ${
            recipient.trim() && !quoteLoading
              ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
              : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
          }`}
        >
          {quoteLoading ? 'Getting fee quote…' : 'Continue'}
        </button>
      </div>
    );
  }

  // Step 3: Confirm
  if (step === 'confirm') {
    const sol = (lamports: bigint) => Number(lamports) / 1e9;

    return (
      <div className="space-y-6">
        <button
          onClick={() => setStep('recipient')}
          className="text-zinc-500 hover:text-zinc-300 text-sm flex items-center gap-1 transition-colors"
        >
          ← Back
        </button>

        <div>
          <h2 className="text-lg font-semibold mb-1">Confirm withdrawal</h2>
          <p className="text-zinc-400 text-sm">
            A relayer will submit this transaction for you. Review the amounts —
            the relayer fee below is the <strong>maximum</strong> it can take, and
            it is locked into your proof.
          </p>
        </div>

        {isOwnWallet && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
            <p className="text-amber-400 text-sm font-medium mb-1">
              This is your connected wallet
            </p>
            <p className="text-amber-400/70 text-xs leading-relaxed">
              Withdrawing to the wallet you have connected here defeats the point:
              anyone watching this wallet sees the funds arrive. Use a fresh address.
            </p>
          </div>
        )}

        <div className="bg-zinc-800/50 rounded-xl p-5 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Amount</span>
            <span className="text-zinc-100 font-semibold">
              {parsedNote?.denominationSol} SOL
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Privacy fee (0.2%)</span>
            <span className="text-zinc-300">
              {breakdown ? sol(breakdown.treasuryFee) : '—'} SOL
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">
              Relayer fee (max{breakdown ? ` — ${breakdown.relayerFeePct.toFixed(2)}%` : ''})
            </span>
            <span className="text-zinc-300">
              {breakdown ? sol(breakdown.relayerFeeMax) : '—'} SOL
            </span>
          </div>
          <div className="border-t border-zinc-700 pt-3 flex justify-between text-sm">
            <span className="text-zinc-300 font-medium">You receive at least</span>
            <span className="text-zinc-100 font-semibold">
              {breakdown ? sol(breakdown.userReceivesMin) : '—'} SOL
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Recipient</span>
            <span className="text-zinc-300 font-mono text-xs">
              {recipient.slice(0, 4)}...{recipient.slice(-4)}
            </span>
          </div>
        </div>

        <div className="bg-zinc-800/30 rounded-xl p-4">
          <p className="text-zinc-500 text-xs leading-relaxed">
            Proof generation takes <strong className="text-zinc-400">30-60 seconds</strong>.
            The ZK proof is computed in your browser — your secret note never leaves this device.
          </p>
        </div>

        {poolInfo && (
          <AnonymitySet depositCount={poolInfo.nextIndex} context="withdraw" />
        )}

        <PrivacyNotice sameSession={sameSession} />

        <button
          onClick={() => executeWithdraw(0)}
          className="w-full py-3.5 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-xl transition-colors text-sm"
        >
          Withdraw
        </button>
      </div>
    );
  }

  // Progress
  if (step === 'progress') {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold mb-1">Withdrawing...</h2>
          <p className="text-zinc-400 text-sm">
            This may take up to 60 seconds. Do not close this page.
          </p>
        </div>

        <ProgressIndicator
          steps={PROGRESS_STEPS}
          currentStep={progressStep}
          error={progressError}
        />

        {progressError && (
          <div className="space-y-3">
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
              {progressError.split('\n').map((line, i) => (
                <p key={i} className={`text-sm ${
                  i === 0 ? 'text-red-400' : 'text-red-400/70 font-mono text-xs mt-2'
                }`}>
                  {line}
                </p>
              ))}
            </div>

            {/* Summary of what will be retried */}
            <div className="bg-zinc-800/50 rounded-xl p-3 space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Amount</span>
                <span className="text-zinc-400">{parsedNote?.denominationSol} SOL</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-zinc-500">Recipient</span>
                <span className="text-zinc-400 font-mono">
                  {recipient.slice(0, 4)}...{recipient.slice(-4)}
                </span>
              </div>
            </div>

            <button
              onClick={() => executeWithdraw(0)}
              className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 text-white font-medium rounded-xl transition-colors text-sm"
            >
              Retry withdrawal
            </button>

            <button
              onClick={() => {
                setStep('confirm');
                setProgressError(null);
                setProgressStep(-1);
              }}
              className="w-full py-2.5 text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
            >
              Back to details
            </button>
          </div>
        )}
      </div>
    );
  }

  // Done
  if (step === 'done') {
    return (
      <div className="space-y-6 text-center py-4">
        <div>
          <span className="text-4xl mb-3 block text-green-400">&#10003;</span>
          <h2 className="text-lg font-semibold text-green-400 mb-1">
            Withdrawal complete!
          </h2>
          <p className="text-zinc-400 text-sm">
            Funds have been sent to the recipient address.
          </p>
        </div>

        <div className="bg-zinc-800/50 rounded-xl p-5 space-y-2 text-left">
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Recipient</span>
            <span className="text-zinc-300 font-mono text-xs">
              {recipient.slice(0, 4)}...{recipient.slice(-4)}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Amount</span>
            <span className="text-zinc-200">{parsedNote?.denominationSol} SOL</span>
          </div>
          {feeTaken && (
            <div className="flex justify-between text-sm">
              <span className="text-zinc-400">Relayer fee</span>
              <span className="text-zinc-300">
                {(Number(feeTaken) / 1e9).toFixed(6)} SOL
              </span>
            </div>
          )}
        </div>

        {txSig && (
          <a
            href={explorerTxUrl(txSig)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-cyan-400 text-sm hover:text-cyan-300 transition-colors underline"
          >
            View on Solana Explorer
          </a>
        )}

        <button
          onClick={() => {
            setStep('paste');
            setNoteInput('');
            setParsedNote(null);
            setRecipient('');
            setTxSig(null);
            setFeeTaken(null);
            setBreakdown(null);
            setQuoteError(null);
          }}
          className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium rounded-xl transition-colors text-sm"
        >
          New withdrawal
        </button>
      </div>
    );
  }

  return null;
}
