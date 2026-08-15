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
 * Pools are keyed by `address` rather than `label`: labels are display strings and two rungs
 * could in principle share one, whereas the pool PDA is unique by construction. The grid is
 * sized for the current three rungs; widen the column count if the ladder grows.
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
      <div className="grid grid-cols-3 gap-2">
        {POOLS.map((pool) => {
          const isSelected = selected?.address === pool.address;
          const undeployed = !pool.address;
          return (
            <button
              key={pool.address || pool.label}
              onClick={() => onSelect(pool)}
              disabled={undeployed}
              title={undeployed ? 'Not deployed on this network' : `${pool.denominationSol} SOL`}
              className={`relative py-3.5 rounded-xl text-center font-semibold transition-all ${
                isSelected
                  ? 'bg-cyan-500/15 ring-2 ring-cyan-400/80 text-cyan-200 shadow-lg shadow-cyan-950/40 -translate-y-0.5'
                  : undeployed
                    ? 'bg-zinc-900/60 ring-1 ring-white/5 text-zinc-700 cursor-not-allowed'
                    : 'bg-zinc-800/70 ring-1 ring-white/[0.06] text-zinc-300 hover:ring-zinc-500/60 hover:bg-zinc-800 hover:-translate-y-0.5'
              }`}
            >
              <span className="block text-lg leading-tight tnum">{short(pool.denominationSol)}</span>
              <span className="block text-[10px] text-zinc-500 mt-0.5">SOL</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
