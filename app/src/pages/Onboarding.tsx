import { useEffect, useState } from 'react';

interface OnboardingProps {
  onDismiss: () => void;
}

/**
 * Seconds the splash screen stays locked before it can be dismissed.
 *
 * The point is to make a first-time user actually read the screen. Losing a note means losing
 * the deposit permanently, and there is no support desk to recover it, so a few forced seconds
 * here are cheaper than a confused first deposit. Change this one constant to adjust it.
 */
const LOCK_SECONDS = 10;

const examples = [
  {
    icon: '💼',
    title: 'Your salary is public',
    description:
      'Your employer, colleagues, and anyone with your wallet address can see exactly how much you earn: every paycheck, every bonus.',
  },
  {
    icon: '📊',
    title: 'Your trades are visible',
    description:
      'Competitors, market makers, and bots can track your every trade in real time, front-running you before you even confirm.',
  },
  {
    icon: '🛒',
    title: 'Your spending is tracked',
    description:
      'Every purchase, donation, and transfer is permanently recorded. Anyone can build a complete profile of your financial life.',
  },
];

export default function Onboarding({ onDismiss }: OnboardingProps) {
  // Measured against a wall-clock deadline rather than by decrementing a counter once per
  // second. Browsers throttle timers in background tabs, so a pure decrement can take far
  // longer than LOCK_SECONDS of real time to reach zero, which would leave the button stuck for
  // a user who switched tabs and came back.
  const [deadline] = useState(() => Date.now() + LOCK_SECONDS * 1000);
  const [secondsLeft, setSecondsLeft] = useState(LOCK_SECONDS);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [deadline]);

  const countdownDone = secondsLeft <= 0;
  const canContinue = countdownDone && acknowledged;

  return (
    // There is deliberately no close button and no click-outside handler: this screen is shown
    // once and must be passed, not skipped.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="w-full max-w-lg card p-5 sm:p-7 my-6 animate-rise">
        {/* Header */}
        <div className="text-center mb-5">
          <span className="grid place-items-center w-14 h-14 mx-auto mb-3 rounded-2xl bg-zinc-800/80 border border-white/10 text-2xl shadow-xl shadow-cyan-950/30">🌀</span>
          <h2 id="onboarding-title" className="text-xl sm:text-2xl font-bold mb-2 tracking-tight">
            On Solana, everything is public
          </h2>
          <p className="text-zinc-400 text-sm leading-relaxed">
            Every transaction you make is visible to everyone, forever.
            <br />
            SornadoCash breaks the on-chain link between sender and receiver.
          </p>
        </div>

        {/* Examples */}
        <div className="space-y-2 mb-5">
          {examples.map((ex) => (
            <div
              key={ex.title}
              className="flex gap-3 p-3 bg-zinc-800/40 rounded-xl ring-1 ring-white/[0.05]"
            >
              <span className="text-xl shrink-0 mt-0.5">{ex.icon}</span>
              <div>
                <h3 className="font-semibold text-sm mb-1">{ex.title}</h3>
                <p className="text-zinc-400 text-xs leading-relaxed">
                  {ex.description}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* How it works (ultra-simple) */}
        <div className="text-center mb-4">
          <p className="text-zinc-500 text-xs mb-3">How SornadoCash works:</p>
          <div className="flex items-center justify-center gap-2 text-sm">
            <span className="bg-zinc-800 px-3 py-1.5 rounded-lg">Deposit</span>
            <span className="text-zinc-600">→</span>
            <span className="bg-zinc-800 px-3 py-1.5 rounded-lg">Get a secret note</span>
            <span className="text-zinc-600">→</span>
            <span className="bg-zinc-800 px-3 py-1.5 rounded-lg">Withdraw anywhere</span>
          </div>
          <p className="text-zinc-500 text-xs mt-2">No on-chain link. No jargon.</p>
        </div>

        {/* The one thing that actually loses people money */}
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3.5 mb-4">
          <p className="text-amber-400 text-sm font-medium mb-1">
            Your secret note is everything
          </p>
          <p className="text-amber-400/70 text-xs leading-relaxed">
            When you deposit, you get a secret note. It is the only way to withdraw your
            funds. Nobody can recover it for you, so save it before you close the page.
          </p>
        </div>

        {/* Acknowledgement */}
        <label className="flex items-start gap-3 cursor-pointer group mb-4">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-cyan-500 focus:ring-cyan-500/30 shrink-0"
          />
          <span className="text-zinc-300 text-sm leading-relaxed group-hover:text-zinc-100 transition-colors">
            I understand how to use SornadoCash
          </span>
        </label>

        {/* CTA */}
        <button
          onClick={onDismiss}
          disabled={!canContinue}
          aria-describedby="onboarding-gate-hint"
          className={`w-full py-3.5 rounded-xl font-semibold transition-colors text-sm ${
            canContinue ? 'btn-primary' : 'btn-muted'
          }`}
        >
          {countdownDone ? 'Get Started' : `Please read (${secondsLeft}s)`}
        </button>

        <p
          id="onboarding-gate-hint"
          aria-live="polite"
          className="text-zinc-500 text-xs text-center mt-3 min-h-[1rem]"
        >
          {!countdownDone
            ? 'Take a moment to read this. The button unlocks shortly.'
            : !acknowledged
              ? 'Tick the box above to continue.'
              : ''}
        </p>
      </div>
    </div>
  );
}
