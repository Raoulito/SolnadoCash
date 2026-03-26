import { POOLS, type PoolConfig } from '../config';

interface PoolSelectorProps {
  selected: PoolConfig | null;
  onSelect: (pool: PoolConfig) => void;
}

export default function PoolSelector({ selected, onSelect }: PoolSelectorProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-300 mb-3">
        Choose an amount
      </label>
      <div className="grid grid-cols-3 gap-2">
        {POOLS.map((pool) => {
          const isSelected = selected?.label === pool.label;
          return (
            <button
              key={pool.label}
              onClick={() => onSelect(pool)}
              className={`py-4 rounded-xl text-center font-semibold transition-all ${
                isSelected
                  ? 'bg-cyan-600/20 border-2 border-cyan-500 text-cyan-400'
                  : 'bg-zinc-800 border-2 border-transparent text-zinc-300 hover:border-zinc-600'
              }`}
            >
              <span className="block text-lg">{pool.denominationSol}</span>
              <span className="block text-xs text-zinc-500 mt-0.5">SOL</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
