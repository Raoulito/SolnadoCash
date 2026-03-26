import { useState, useEffect } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { NETWORK } from './config';
import Onboarding from './pages/Onboarding';
import Deposit from './pages/Deposit';
import Withdraw from './pages/Withdraw';
import NetworkGuard from './components/NetworkGuard';

type Tab = 'deposit' | 'withdraw';

const ONBOARDING_KEY = 'solnadocash_onboarded';

export default function App() {
  const [tab, setTab] = useState<Tab>('deposit');
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(ONBOARDING_KEY)) {
      setShowOnboarding(true);
    }
  }, []);

  const dismissOnboarding = () => {
    localStorage.setItem(ONBOARDING_KEY, '1');
    setShowOnboarding(false);
  };

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
                onClick={() => setTab(t)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors capitalize ${
                  tab === t
                    ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Card */}
          <div className="bg-zinc-900 rounded-2xl border border-zinc-800/50 p-6">
            {tab === 'deposit' ? (
              <Deposit onGoToWithdraw={() => setTab('withdraw')} />
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
