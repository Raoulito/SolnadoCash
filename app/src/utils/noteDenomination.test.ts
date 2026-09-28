// app/src/utils/noteDenomination.test.ts
//
// L-4. A note's denomination is its own claim; nothing ties it to the pool. A leaf built for
// 100 SOL can be deposited into the 0.1 SOL pool for 0.1 SOL, withdrawn, and paid 0.0997 SOL, while
// the app displayed "100 SOL" (reproduced on a local validator). Sold or given as payment, such a
// note is a scam the app used to vouch for.

import { describe, expect, it } from 'vitest';
import { denominationMismatch } from './noteDenomination';

describe('denominationMismatch (L-4)', () => {
  it('is silent when the note and its pool agree', () => {
    expect(denominationMismatch(100_000_000n, 100_000_000n)).toBeNull();
  });

  it('names both amounts, and which one is paid, when they disagree', () => {
    const msg = denominationMismatch(100_000_000_000n, 100_000_000n)!;
    expect(msg).toMatch(/100 SOL/);
    expect(msg).toMatch(/0\.1 SOL/);
    expect(msg).toMatch(/most you can receive/);
  });
});
