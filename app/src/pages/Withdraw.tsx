import { useState, useCallback } from 'react';
import { PublicKey } from '@solana/web3.js';
import ProgressIndicator, { type ProgressStep } from '../components/ProgressIndicator';
import { RELAYER_URL } from '../config';

type Step = 'paste' | 'recipient' | 'confirm' | 'progress' | 'done';

const PROGRESS_STEPS: ProgressStep[] = [
  { label: 'Generating proof', estimatedSeconds: 15 },
  { label: 'Submitting to relayer', estimatedSeconds: 5 },
  { label: 'Confirming on-chain', estimatedSeconds: 10 },
];

interface ParsedNote {
  raw: string;
  poolHint: string;
  denominationLamports: bigint;
  denominationSol: number;
}

function parseNote(raw: string): ParsedNote | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('sndo_')) return null;
  const parts = trimmed.split('_');
  if (parts.length < 4) return null;
  try {
    const poolHint = parts[1];
    const denomHex = parts[2];
    const denominationLamports = BigInt('0x' + denomHex);
    const denominationSol = Number(denominationLamports) / 1e9;
    return { raw: trimmed, poolHint, denominationLamports, denominationSol };
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

  // Withdrawal logic — lifted out so it can be called from confirm AND retry
  const executeWithdraw = useCallback(async () => {
    setStep('progress');
    setProgressStep(0);
    setProgressError(null);

    try {
      // ┌──────────────────────────────────────────────────────────────────┐
      // │ PLACEHOLDER — Remove this entire block for production.          │
      // │ Replace with:                                                   │
      // │   import { decodeNote, generateWithdrawProof, ... } from SDK;   │
      // │   const note = decodeNote(parsedNote.raw);                      │
      // │   const quote = await getFeeQuote(RELAYER_URL, note.poolAddress)│
      // │   const { proof, publicSignals } = await generateWithdrawProof( │
      // │     note, quote, recipient, merkleTree, circuitPaths);          │
      // │   // Then submit real proof + publicSignals to relayer           │
      // │ The dummy proof/signals below will be rejected by the on-chain  │
      // │ program — they only test the relayer communication path.        │
      // └──────────────────────────────────────────────────────────────────┘

      // Step 0: Generate proof (placeholder — simulates ~2s proof gen)
      await new Promise((r) => setTimeout(r, 2000));
      setProgressStep(1);

      // Step 1: Submit to relayer
      const res = await fetch(`${RELAYER_URL}/submit_proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // FIXME(production): use real Groth16 proof from SDK
          proof: { pi_a: [], pi_b: [], pi_c: [], protocol: 'groth16', curve: 'bn128' },
          publicSignals: ['0', '0', '0'],
          poolAddress: parsedNote?.poolHint || '',
          recipient,
          relayerFeeMax: '50000',
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(body.error || `Relayer error (${res.status})`);
      }

      const data = await res.json();
      setProgressStep(2);

      // Step 2: Wait for on-chain confirmation
      await new Promise((r) => setTimeout(r, 1500));

      setTxSig(data.txSignature || null);
      setFeeTaken(data.feeTaken || null);
      setStep('done');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Withdrawal failed';
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        setProgressError(
          'Could not reach the relayer service. Make sure it is running:\n' +
          'cd relayer && npm start'
        );
      } else if (msg.includes('InvalidAddress')) {
        setProgressError('Invalid address in note or recipient. The note may have been generated with an older format — try a new deposit.');
      } else if (msg.includes('NullifierSpent')) {
        setProgressError('This note has already been used. Each note can only be withdrawn once.');
      } else if (msg.includes('InvalidProof')) {
        setProgressError('The proof could not be verified. Please try again.');
      } else if (msg.includes('RelayerBusy')) {
        setProgressError('The relayer is busy. Please wait a moment and try again.');
      } else {
        setProgressError(msg);
      }
    }
  }, [parsedNote, recipient]);

  // Step 1: Paste note
  if (step === 'paste') {
    const handleNext = () => {
      const parsed = parseNote(noteInput);
      if (!parsed) {
        setNoteError('Invalid note. It should start with "sndo_" and contain your deposit data.');
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
    const handleNext = () => {
      if (!isValidSolanaAddress(recipient)) {
        setRecipientError('Enter a valid Solana wallet address.');
        return;
      }
      setRecipientError(null);
      setStep('confirm');
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
            It can be any wallet — no link to your deposit.
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

        <button
          onClick={handleNext}
          disabled={!recipient.trim()}
          className={`w-full py-3.5 rounded-xl font-semibold text-sm transition-all ${
            recipient.trim()
              ? 'bg-cyan-600 hover:bg-cyan-500 text-white'
              : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
          }`}
        >
          Continue
        </button>
      </div>
    );
  }

  // Step 3: Confirm
  if (step === 'confirm') {
    const treasuryFee = parsedNote ? parsedNote.denominationSol / 500 : 0;

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
            A relayer will submit this transaction for you so nobody
            can identify you. Review the details below.
          </p>
        </div>

        <div className="bg-zinc-800/50 rounded-xl p-5 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Amount</span>
            <span className="text-zinc-100 font-semibold">
              {parsedNote?.denominationSol} SOL
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Privacy fee (0.2%)</span>
            <span className="text-zinc-300">{treasuryFee} SOL</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-400">Relayer fee (estimated)</span>
            <span className="text-zinc-300">~0.000005 SOL</span>
          </div>
          <div className="border-t border-zinc-700 pt-3 flex justify-between text-sm">
            <span className="text-zinc-400">Recipient</span>
            <span className="text-zinc-300 font-mono text-xs">
              {recipient.slice(0, 4)}...{recipient.slice(-4)}
            </span>
          </div>
        </div>

        <button
          onClick={executeWithdraw}
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
            This may take up to 30 seconds. Do not close this page.
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
              onClick={executeWithdraw}
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
            href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
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
