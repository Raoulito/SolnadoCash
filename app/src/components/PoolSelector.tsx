import { POOLS, type PoolConfig } from '../config';

interface PoolSelectorProps {
  selected: PoolConfig | null;
  onSelect: (pool: PoolConfig) => void;
}

/**
 * Format a denomination compactly so the tiles stay readable across the ladder:
 * 0.1 … 1000 in the same grid.
 */
function short(sol: number): string {
  if (sol >= 1000) return `${sol / 1000}k`;
  return String(sol);
}

/**
 * Denomination picker.
 *
 * A fixed 3-column grid worked for three pools and breaks for thirteen, so this is a
 * responsive wrapping grid. Pools are keyed by `address` rather than `label`: labels are
 * display strings and two rungs could in principle share one, whereas the pool PDA is
 * unique by construction.
 */
export default function PoolSelector({ selected, onSelect }: PoolSelectorProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-300 mb-1">
        Choose an amount
      </label>
      <p className="text-zinc-500 text-xs mb-3">
        Each amount is a separate pool with its own anonymity set. Larger amounts usually have
        fewer deposits, so they hide you less.
      </p>
      <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
        {POOLS.map((pool) => {
          const isSelected = selected?.address === pool.address;
          const undeployed = !pool.address;
          return (
            <button
              key={pool.address || pool.label}
              onClick={() => onSelect(pool)}
              disabled={undeployed}
              title={undeployed ? 'Not deployed on this network' : `${pool.denominationSol} SOL`}
              className={`py-3 rounded-xl text-center font-semibold transition-all ${
                isSelected
                  ? 'bg-cyan-600/20 border-2 border-cyan-500 text-cyan-400'
                  : undeployed
                    ? 'bg-zinc-900 border-2 border-transparent text-zinc-700 cursor-not-allowed'
                    : 'bg-zinc-800 border-2 border-transparent text-zinc-300 hover:border-zinc-600'
              }`}
            >
              <span className="block text-base leading-tight">{short(pool.denominationSol)}</span>
              <span className="block text-[10px] text-zinc-500 mt-0.5">SOL</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
