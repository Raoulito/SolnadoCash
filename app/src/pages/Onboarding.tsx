interface OnboardingProps {
  onDismiss: () => void;
}

const examples = [
  {
    icon: '💼',
    title: 'Your salary is public',
    description:
      'Your employer, colleagues, and anyone with your wallet address can see exactly how much you earn — every paycheck, every bonus.',
  },
  {
    icon: '📊',
    title: 'Your trades are visible',
    description:
      'Competitors, market makers, and bots can track your every trade in real-time — front-running you before you even confirm.',
  },
  {
    icon: '🛒',
    title: 'Your spending is tracked',
    description:
      'Every purchase, donation, and transfer is permanently recorded. Anyone can build a complete profile of your financial life.',
  },
];

export default function Onboarding({ onDismiss }: OnboardingProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4">
      <div className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl p-6 sm:p-8">
        {/* Header */}
        <div className="text-center mb-8">
          <span className="text-4xl mb-3 block">🌀</span>
          <h2 className="text-2xl font-bold mb-2">
            On Solana, everything is public
          </h2>
          <p className="text-zinc-400 text-sm leading-relaxed">
            Every transaction you make is visible to everyone, forever.
            <br />
            SolnadoCash breaks the link between sender and receiver.
          </p>
        </div>

        {/* Examples */}
        <div className="space-y-3 mb-8">
          {examples.map((ex) => (
            <div
              key={ex.title}
              className="flex gap-4 p-4 bg-zinc-800/50 rounded-xl"
            >
              <span className="text-2xl shrink-0 mt-0.5">{ex.icon}</span>
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
        <div className="text-center mb-6">
          <p className="text-zinc-500 text-xs mb-3">How SolnadoCash works:</p>
          <div className="flex items-center justify-center gap-2 text-sm">
            <span className="bg-zinc-800 px-3 py-1.5 rounded-lg">Deposit</span>
            <span className="text-zinc-600">→</span>
            <span className="bg-zinc-800 px-3 py-1.5 rounded-lg">Get a secret note</span>
            <span className="text-zinc-600">→</span>
            <span className="bg-zinc-800 px-3 py-1.5 rounded-lg">Withdraw anywhere</span>
          </div>
          <p className="text-zinc-500 text-xs mt-2">No link. No trace. No jargon.</p>
        </div>

        {/* CTA */}
        <button
          onClick={onDismiss}
          className="w-full py-3.5 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold rounded-xl transition-colors text-sm"
        >
          Get Started
        </button>
      </div>
    </div>
  );
}
