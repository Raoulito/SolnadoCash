// app/src/utils/leafCache.ts
//
// Persistent, append-only cache of a pool's Merkle leaves.
//
// Why this exists (H-5): rebuilding the tree costs one getTransaction round-trip per
// deposit, forever, on every withdrawal. That is fine at a hundred deposits and hopeless at
// ten thousand — public RPC endpoints rate-limit and prune history long before a pool
// reaches its advertised 950,000 capacity. Leaves are immutable and append-only, so once a
// leaf is known it never needs fetching again: a returning user pays only for deposits made
// since their last visit.
//
// This is a mitigation, not the fix. A first-time user with an empty cache still pays the
// full O(deposits) scan. The real fix is an indexer serving leaves in one request; this
// buys headroom until then and is honest about that.
//
// Safety: nothing here is trusted. The caller rebuilds the tree from cached leaves and then
// checks the root and leaf count against on-chain pool state, so a corrupted, truncated or
// attacker-written cache cannot produce a valid-looking proof — it produces a verification
// failure, and the caller clears the cache and rescans. That check is what makes caching
// safe to do at all, so it must not be skipped.

const CACHE_VERSION = 2;
const KEY_PREFIX = 'sndo_leaves';

/**
 * Above this leaf count we stop persisting. Leaves are 64 hex chars each, and localStorage
 * quota is commonly 5 MB per origin; ~20k leaves is ~1.3 MB, which leaves room for the rest
 * of the app. Past that point an indexer is required anyway, so silently filling the quota
 * would only trade one failure for a worse one.
 */
const MAX_CACHED_LEAVES = 20_000;

export interface LeafCache {
  /** Leaf values as 64-char lowercase hex, index === leafIndex. Dense, no gaps. */
  leaves: string[];
  /** Newest signature already scanned, used as the `until` bound for incremental fetches. */
  lastSignature?: string;
}

function key(programId: string, pool: string): string {
  return `${KEY_PREFIX}_v${CACHE_VERSION}_${programId}_${pool}`;
}

function toHex(v: bigint): string {
  return v.toString(16).padStart(64, '0');
}

export function leafToBigInt(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

export function loadCache(programId: string, pool: string): LeafCache {
  try {
    const raw = localStorage.getItem(key(programId, pool));
    if (!raw) return { leaves: [] };
    const parsed = JSON.parse(raw) as LeafCache;
    if (!Array.isArray(parsed.leaves)) return { leaves: [] };
    // Reject anything malformed rather than letting it reach the tree builder, where the
    // failure would surface as a confusing proof error instead of a cache miss.
    for (const l of parsed.leaves) {
      if (typeof l !== 'string' || !/^[0-9a-f]{64}$/.test(l)) return { leaves: [] };
    }
    return parsed;
  } catch {
    // Unavailable (private browsing, disabled storage) or corrupt: behave as a cold cache.
    return { leaves: [] };
  }
}

export function saveCache(
  programId: string,
  pool: string,
  leaves: bigint[],
  lastSignature?: string
): void {
  if (leaves.length > MAX_CACHED_LEAVES) return;
  try {
    const payload: LeafCache = { leaves: leaves.map(toHex), lastSignature };
    localStorage.setItem(key(programId, pool), JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage unavailable. Not fatal — the next rebuild is just slower.
  }
}

export function clearCache(programId: string, pool: string): void {
  try {
    localStorage.removeItem(key(programId, pool));
  } catch {
    /* nothing to do */
  }
}
