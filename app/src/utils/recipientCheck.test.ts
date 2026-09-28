// app/src/utils/recipientCheck.test.ts
//
// L-6. The confirm screen showed the recipient as its first and last four characters, which is
// exactly what an address-poisoning attack matches: an attacker grinds a lookalike sharing those
// eight characters (measured ~36 h on a vanity GPU) and swaps it in through clipboard malware or a
// poisoned transaction history. The user now sees the whole address and must type its last eight
// characters, which the lookalike does not share, before the withdrawal is bound into a proof.

import { describe, expect, it } from 'vitest';
import { groupAddress, recipientConfirmed, CONFIRM_CHARS } from './recipientCheck';

const REAL = '9fRtqXk2Lm8vPwZ4dNcB7hJsYuE3aG6oTqWxRzV1bV8b';
// Shares the first 4 and last 4 characters shown on the old screen, differs everywhere else.
const LOOKALIKE = REAL.slice(0, 4) + 'Z'.repeat(REAL.length - 8) + REAL.slice(-4);

describe('recipient confirmation (L-6)', () => {
  it('asks for more characters than a 4+4 lookalike shares', () => {
    expect(CONFIRM_CHARS).toBeGreaterThanOrEqual(8);
  });

  it('confirms only when the typed tail matches the address exactly', () => {
    const tail = REAL.slice(-CONFIRM_CHARS);
    expect(recipientConfirmed(REAL, tail)).toBe(true);
    expect(recipientConfirmed(REAL, ` ${tail} `)).toBe(true); // surrounding whitespace is forgiven
    expect(recipientConfirmed(REAL, tail.toLowerCase())).toBe(tail === tail.toLowerCase()); // base58 is case-sensitive
    expect(recipientConfirmed(REAL, '')).toBe(false);
    expect(recipientConfirmed(REAL, tail.slice(1))).toBe(false);
  });

  it('a lookalike sharing the old 4+4 does not confirm with the real tail', () => {
    expect(LOOKALIKE.slice(0, 4)).toBe(REAL.slice(0, 4));
    expect(LOOKALIKE.slice(-4)).toBe(REAL.slice(-4));
    expect(recipientConfirmed(LOOKALIKE, REAL.slice(-CONFIRM_CHARS))).toBe(false);
  });

  it('groups the full address for reading, losing no characters', () => {
    const g = groupAddress(REAL);
    expect(g.replace(/ /g, '')).toBe(REAL);
    expect(g.split(' ').every((part) => part.length <= 4)).toBe(true);
  });
});
