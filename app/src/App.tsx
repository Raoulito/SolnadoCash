import { useState, useEffect, useCallback } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { NETWORK, fatalConfigProblems } from './config';
import Onboarding from './pages/Onboarding';
import Deposit from './pages/Deposit';
import Withdraw from './pages/Withdraw';
import NetworkGuard from './components/NetworkGuard';
import NoteRecovery from './components/NoteRecovery';

type Tab = 'deposit' | 'withdraw';

const ONBOARDING_KEY = 'solnadocash_onboarded';

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
        <div className="flex items-center gap-2">
          <span className="text-2xl">🌀</span>
          <h1 className="text-lg font-bold tracking-tight">SolnadoCash</h1>
        </div>
        <WalletMultiButton />
      </header>

      {/* Main */}
      <main className="flex-1 flex items-start justify-center px-4 pt-8 sm:pt-16 pb-8">
        <div className="w-full max-w-md">
          {/* Tabs */}
          <div className="flex bg-zinc-900 rounded-xl p-1 mb-4">
            {(['deposit', 'withdraw'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => handleTabClick(t)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors capitalize ${
                  tab === t
                    ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                    : noteLocked
                      ? 'text-zinc-700 cursor-not-allowed'
                      : 'text-zinc-500 hover:text-zinc-300'
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
          <div className="bg-zinc-900 rounded-2xl border border-zinc-800/50 p-6">
            {tab === 'deposit' ? (
              <Deposit
                onGoToWithdraw={() => setTab('withdraw')}
                onNoteLock={handleNoteLock}
              />
            ) : (
              <Withdraw />
            )}
          </div>

          {/* Footer */}
          <p className="text-center text-zinc-600 text-xs mt-6">
            {NETWORK} · v0.1.0
          </p>
        </div>
      </main>
    </div>
  );
}
