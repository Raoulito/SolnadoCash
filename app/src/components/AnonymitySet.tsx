/**
 * Privacy timing notice.
 *
 * This previously displayed the pool's live deposit count as the anonymity set size (M-1).
 * That number is now deliberately not shown, and the tradeoff is worth recording.
 *
 * The argument for removing it: the count at the moment you are looking at it is not the set
 * you will actually hide in. On the deposit screen it is close to meaningless, because the
 * number that matters is how many deposits exist when you eventually withdraw, which is
 * unknowable at deposit time and is usually larger. A prominent "0 deposits" on a young pool
 * discourages the very first depositors, and a pool needs first depositors before it can
 * protect anyone.
 *
 * What is lost: on the withdraw screen the count IS the current anonymity set, so a user can no
 * longer see from the UI whether they are hiding among three deposits or three hundred. Anyone
 * who wants that figure can read it from the chain, and scripts/check_pools.js prints it.
 *
 * What replaces it is advice that stays true regardless of the count, and that the user can
 * actually act on: wait. Time between deposit and withdrawal is the one variable a single user
 * controls, and it defeats the timing correlation that no amount of ZK proving addresses.
 */
export default function AnonymitySet({
  context,
}: {
  context: 'deposit' | 'withdraw';
}) {
  return (
    <div className="rounded-xl border border-zinc-700/80 bg-zinc-800/40 p-4">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-sm font-medium text-zinc-200">Anonymity grows with time</span>
        <span className="text-[11px] text-zinc-500">privacy tip</span>
      </div>
      <p className="text-xs text-zinc-400 leading-relaxed">
        The longer you wait before withdrawing, the higher your anonymity. Deposits and
        withdrawals that happen close together can be linked by timing alone, whatever the proof
        guarantees.
      </p>
      <p className="text-xs text-zinc-500 leading-relaxed mt-2">
        {context === 'deposit'
          ? 'Plan to leave your funds in the pool for a while, and withdraw from a different network connection if you can.'
          : 'If you deposited recently, waiting longer will do more for your privacy than anything else on this screen.'}
      </p>
    </div>
  );
}
