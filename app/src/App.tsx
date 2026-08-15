import { useState, useEffect, useCallback } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { NETWORK, fatalConfigProblems } from './config';
import Onboarding from './pages/Onboarding';
import Deposit from './pages/Deposit';
import Withdraw from './pages/Withdraw';
import Faq from './pages/Faq';
import NetworkGuard from './components/NetworkGuard';
import NoteRecovery from './components/NoteRecovery';

type Tab = 'deposit' | 'withdraw' | 'faq';

const ONBOARDING_KEY = 'sornadocash_onboarded';

export default function App() {
  const [tab, setTab] = useState<Tab>('deposit');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [noteLocked, setNoteLocked] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(ONBOARDING_KEY)) {
      setShowOnboarding(true);
    }
  }, []);

  const dismissOnboarding = () => {
    localStorage.setItem(ONBOARDING_KEY, '1');
    setShowOnboarding(false);
  };

  const handleTabClick = (t: Tab) => {
    if (noteLocked) return; // Block navigation while note is displayed
    setTab(t);
  };

  const handleNoteLock = useCallback((locked: boolean) => {
    setNoteLocked(locked);
  }, []);

  // M-8: refuse to operate on a real-money network with development config
  // rather than silently pointing mainnet funds at a local relayer.
  const configProblems = fatalConfigProblems();
  if (configProblems.length > 0) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-lg bg-red-500/10 border border-red-500/30 rounded-2xl p-6">
          <h1 className="text-red-400 font-semibold mb-2">Unsafe configuration</h1>
          <p className="text-red-400/80 text-sm mb-3">
            This build targets {NETWORK} but is configured for development. Fix the
            following before using real funds:
          </p>
          <ul className="text-red-400/70 text-xs space-y-2 list-disc pl-4">
            {configProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="text-red-400/60 text-xs mt-4">See app/.env.example.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {showOnboarding && <Onboarding onDismiss={dismissOnboarding} />}

      {/* Network warning — shown after wallet connect */}
      <NetworkGuard />

      {/* Header */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-zinc-800/50">
        <div className="flex items-center gap-2.5">
          <span className="relative grid place-items-center w-9 h-9 rounded-xl bg-zinc-900 border border-white/10 text-lg shadow-lg shadow-cyan-950/30">
            <span aria-hidden="true">🌀</span>
            <span className="absolute inset-0 rounded-xl bg-cyan-400/10 blur-md" aria-hidden="true" />
          </span>
          <div className="leading-none">
            <h1 className="text-lg font-bold tracking-tight brand-text">SornadoCash</h1>
            <p className="text-[10px] text-zinc-500 mt-0.5 tracking-wide">sornado.cash</p>
          </div>
        </div>
        <WalletMultiButton />
      </header>

      {/* Main */}
      <main className="flex-1 flex items-start justify-center px-4 pt-8 sm:pt-16 pb-8">
        <div className="w-full max-w-md">
          {/* Hero. The landing state is otherwise a single small card on a large empty page,
              and the one thing worth saying up front is what the protocol does and does not
              hide. */}
          {/* Hidden on the FAQ tab: that page opens with "Why would I want this?", so the hero
              only repeats it and pushes the answer below the fold. */}
          {tab !== 'faq' && (
          <div className="text-center mb-6">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Break the <span className="brand-text">on-chain link</span>
            </h2>
            <p className="text-zinc-400 text-sm mt-2 leading-relaxed">
              Deposit a fixed amount, get a secret note, withdraw to any address.
            </p>
            <p className="text-base font-semibold mt-3 brand-text">
              Own your financial privacy
            </p>
            <div className="flex items-center justify-center gap-4 mt-4 text-[11px] text-zinc-500">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1 h-1 rounded-full bg-cyan-400/80" aria-hidden="true" />
                Groth16 proofs
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1 h-1 rounded-full bg-violet-400/80" aria-hidden="true" />
                Proof runs in your browser
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1 h-1 rounded-full bg-cyan-400/80" aria-hidden="true" />
                Open relayer
              </span>
            </div>
          </div>
          )}

          {/* Tabs */}
          <div className="flex bg-zinc-900/70 backdrop-blur border border-white/[0.06] rounded-xl p-1 mb-4">
            {(['deposit', 'withdraw', 'faq'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => handleTabClick(t)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  t === 'faq' ? 'uppercase tracking-wide' : 'capitalize'
                } ${
                  tab === t
                    ? 'bg-gradient-to-b from-zinc-700/80 to-zinc-800 text-zinc-50 shadow-lg shadow-black/40 border border-white/[0.06]'
                    : noteLocked
                      ? 'text-zinc-700 cursor-not-allowed'
                      : 'text-zinc-500 hover:text-zinc-200'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* FE-1: a note stranded by an interrupted session is the only key to a deposit
              that may have landed, so it is surfaced above everything else. */}
          <NoteRecovery />

          {/* Lock banner */}
          {noteLocked && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-4">
              <p className="text-amber-400 text-xs text-center">
                Save your secret note before leaving this page.
              </p>
            </div>
          )}

          {/* Card */}
          <div className="card p-6 animate-rise">
            {tab === 'deposit' ? (
              <Deposit
                onGoToWithdraw={() => setTab('withdraw')}
                onNoteLock={handleNoteLock}
              />
            ) : tab === 'withdraw' ? (
              <Withdraw />
            ) : (
              <Faq onGoToDeposit={() => setTab('deposit')} />
            )}
          </div>

          {/* Footer */}
          <p className="text-center text-zinc-600 text-xs mt-6">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400/70" aria-hidden="true" />
              {NETWORK}
            </span>
            <span className="mx-2 text-zinc-800">|</span>
            sornado.cash
            <span className="mx-2 text-zinc-800">|</span>
            v0.1.0
          </p>
        </div>
      </main>
    </div>
  );
}
