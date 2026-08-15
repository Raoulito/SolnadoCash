/**
 * Anonymity set indicator (M-1).
 *
 * Privacy here is bounded by how many OTHER deposits share the pool: a withdrawal
 * from a pool with 3 deposits is trivially linkable by elimination, regardless of
 * the ZK proof. The UI previously showed the deposit count only as a capacity bar
 * ("N / 950,000"), which reads as "plenty of room left" rather than "this is how
 * hidden you are".
 *
 * Pool PDA seeds include the admin key, so every deployer creates a disjoint pool
 * per denomination and sets do not merge across deployments — another reason to
 * show the real number for the specific pool being used.
 */
export function anonymityTier(depositCount: number): {
  label: string;
  tone: 'weak' | 'fair' | 'good';
} {
  if (depositCount < 10) return { label: 'very small', tone: 'weak' };
  if (depositCount < 50) return { label: 'small', tone: 'weak' };
  if (depositCount < 200) return { label: 'moderate', tone: 'fair' };
  return { label: 'reasonable', tone: 'good' };
}

const TONE_CLASSES: Record<string, string> = {
  weak: 'bg-amber-500/10 border-amber-500/30 text-amber-400',
  fair: 'bg-zinc-800/50 border-zinc-700 text-zinc-300',
  good: 'bg-green-500/10 border-green-500/30 text-green-400',
};

export default function AnonymitySet({
  depositCount,
  context,
}: {
  depositCount: number;
  context: 'deposit' | 'withdraw';
}) {
  const tier = anonymityTier(depositCount);

  return (
    <div className={`rounded-xl border p-4 ${TONE_CLASSES[tier.tone]}`}>
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-sm font-medium">Anonymity set</span>
        <span className="text-sm font-semibold">
          {depositCount.toLocaleString()} deposit{depositCount === 1 ? '' : 's'}
        </span>
      </div>
      <p className="text-xs leading-relaxed opacity-80">
        {tier.tone === 'weak' ? (
          context === 'deposit' ? (
            <>
              This pool is {tier.label}, so your withdrawal could be linked to this
              deposit by elimination. Privacy improves as more people deposit the
              same amount; consider waiting before withdrawing.
            </>
          ) : (
            <>
              This pool is {tier.label} ({depositCount} deposits), so an observer
              has few alternatives to consider. The ZK proof hides which deposit is
              yours, but not within a crowd this thin.
            </>
          )
        ) : (
          <>
            Your withdrawal is indistinguishable from any of these {depositCount}{' '}
            deposits. The set covers this pool only. Pools from other deployers do
            not merge.
          </>
        )}
      </p>
    </div>
  );
}
