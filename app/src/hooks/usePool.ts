import { useState, useEffect } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useConnection } from '@solana/wallet-adapter-react';
import { PROGRAM_ID } from '../config';

// Pool struct offsets (after 8-byte Anchor discriminator):
//   next_index: offset 80 (absolute 88)
//   is_paused:  offset 123 (absolute 131)
const DISCRIMINATOR = 8;
const NEXT_INDEX_OFFSET = DISCRIMINATOR + 80;
const IS_PAUSED_OFFSET = DISCRIMINATOR + 123;

/** Anchor discriminator for the Pool account. */
const POOL_DISCRIMINATOR = new Uint8Array([0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc]);

/** Minimum size of a real Pool account (root ring + filled subtrees). */
const POOL_MIN_LEN = 8 + 8968;

/**
 * Deposits at which a pool stops accepting new ones, enforced on-chain by the program
 * (SATURATION_THRESHOLD in state.rs). Exported so the UI cannot drift from the check below.
 */
export const SATURATION_THRESHOLD = 950_000;

/**
 * Capacity as a percentage, never as a raw count.
 *
 * The question this answers is only "can this pool still take deposits", so the exact number of
 * deposits is not shown: on a young pool that figure reads as a privacy score and discourages
 * the first depositors, which is why the anonymity panel stopped displaying it too.
 *
 * A non-empty pool that rounds to zero is reported as "<1%" rather than "0%", so a pool that is
 * in use is never described as untouched.
 */
export function capacityLabel(nextIndex: number): string {
  if (nextIndex <= 0) return '0%';
  const pct = (nextIndex / SATURATION_THRESHOLD) * 100;
  if (pct >= 99.5) return '100%';
  if (pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

export interface PoolInfo {
  nextIndex: number;
  isPaused: boolean;
  isSaturated: boolean;
}

/**
 * Read the display-relevant fields of a pool account.
 *
 * FE-3: this used to decode whatever account the given address named, with no owner or
 * discriminator check — the same mistake that was fixed in the relayer as N-2. It matters
 * here because in the withdraw flow the address comes from a note the user pasted, so an
 * arbitrary or hostile account could drive what the UI reports. The damaging case is the
 * anonymity-set display: a fabricated deposit count tells the user they are hidden among
 * thousands when they are not, which is a privacy decision made on false information. A
 * short account also made `readBigUInt64LE` throw a raw RangeError.
 *
 * So the account must be owned by this program, carry the Pool discriminator, and be long
 * enough, before a single field is believed.
 */
export function usePoolInfo(poolAddress: string | null) {
  // Reuse the provider's connection instead of constructing a second one, so a configured
  // endpoint and commitment actually apply here too.
  const { connection } = useConnection();

  const [info, setInfo] = useState<PoolInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!poolAddress) {
      setInfo(null);
      setError(null);
      return;
    }

    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(poolAddress);
    } catch {
      setInfo(null);
      setError('That pool address is not a valid Solana address.');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    connection
      .getAccountInfo(pubkey)
      .then((account) => {
        if (cancelled) return;
        if (!account) {
          setInfo(null);
          setError('Pool not found on-chain');
          return;
        }

        if (!account.owner.equals(new PublicKey(PROGRAM_ID))) {
          setInfo(null);
          setError(
            'That address is not a SornadoCash pool. It is owned by another program. ' +
              'Do not rely on any figures for it.'
          );
          return;
        }

        const data = account.data;
        if (data.length < POOL_MIN_LEN) {
          setInfo(null);
          setError('That account is not a pool (wrong size).');
          return;
        }
        for (let i = 0; i < 8; i++) {
          if (data[i] !== POOL_DISCRIMINATOR[i]) {
            setInfo(null);
            setError('That account is owned by this program but is not a pool.');
            return;
          }
        }

        const nextIndex = Number(data.readBigUInt64LE(NEXT_INDEX_OFFSET));
        setInfo({
          nextIndex,
          isPaused: data[IS_PAUSED_OFFSET] === 1,
          isSaturated: nextIndex >= SATURATION_THRESHOLD,
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to read pool');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [poolAddress, connection]);

  return { info, loading, error };
}
