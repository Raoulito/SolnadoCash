import { useState, useEffect } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { RPC_ENDPOINT } from '../config';

// Pool struct offsets (after 8-byte Anchor discriminator):
//   next_index: offset 80 (absolute 88)
//   is_paused:  offset 123 (absolute 131)
const DISCRIMINATOR = 8;
const NEXT_INDEX_OFFSET = DISCRIMINATOR + 80;
const IS_PAUSED_OFFSET = DISCRIMINATOR + 123;

export interface PoolInfo {
  nextIndex: number;
  isPaused: boolean;
  isSaturated: boolean;
}

export function usePoolInfo(poolAddress: string | null) {
  const [info, setInfo] = useState<PoolInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!poolAddress) {
      setInfo(null);
      return;
    }

    let cancelled = false;
    const conn = new Connection(RPC_ENDPOINT);
    setLoading(true);
    setError(null);

    conn.getAccountInfo(new PublicKey(poolAddress))
      .then((account) => {
        if (cancelled) return;
        if (!account) {
          setError('Pool not found on-chain');
          return;
        }
        const data = account.data;
        const nextIndex = Number(data.readBigUInt64LE(NEXT_INDEX_OFFSET));
        const isPaused = data[IS_PAUSED_OFFSET] === 1;

        setInfo({
          nextIndex,
          isPaused,
          isSaturated: nextIndex >= 950_000,
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to read pool');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [poolAddress]);

  return { info, loading, error };
}
