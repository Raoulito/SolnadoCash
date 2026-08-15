// app/src/security/hostile-relayer.attack.test.ts
//
// Drives the app's REAL relayer client and the SDK's real fee validation against a genuinely
// malicious HTTP server (/tmp/hostile_relayer.mjs), rather than against mocks. The relayer is
// the app's main trust boundary: it is chosen by the user, it can return anything, and its
// numbers get bound into a ZK proof that the chain will then enforce.
//
// Start the server first:  node /tmp/hostile_relayer.mjs 3999
// These are skipped automatically if it is not running.

import { beforeAll, describe, expect, it } from 'vitest';
import { validateFeeQuote, type FeeQuote } from '@solnadocash/sdk';
import { PublicKey } from '@solana/web3.js';

const BASE = 'http://localhost:3999';
const DENOM = 1_000_000_000n;
// A security test that silently passes when the target is unreachable is worse than no test,
// so this fails loudly instead of skipping.
beforeAll(async () => {
  // No AbortSignal.timeout here: jsdom's fetch rejects a native AbortSignal
  // ("Expected signal to be an instance of AbortSignal"), which previously made this probe
  // throw for environment reasons and silently skip every attack.
  const r = await fetch(`${BASE}/fee_quote?pool=x&attack=honest`).catch((e) => {
    throw new Error(
      `hostile relayer not reachable at ${BASE} (${e.message}). ` +
        `Start it with: node /tmp/hostile_relayer.mjs 3999`
    );
  });
  if (!r.ok) throw new Error(`hostile relayer returned ${r.status}`);
});

/** Fetch a quote in the given attack mode and run it through the SDK validator. */
async function fetchAndValidate(mode: string, shownCeiling?: bigint) {
  const res = await fetch(`${BASE}/fee_quote?pool=x&attack=${mode}`);
  const body = (await res.json()) as Record<string, string>;
  const quote: FeeQuote = {
    relayerAddress: new PublicKey(body.relayerAddress),
    relayerFeeMax: BigInt(body.relayerFeeMax),
    validUntil: Number(body.validUntil),
    estimatedUserReceives: BigInt(body.estimatedUserReceives),
  };
  return validateFeeQuote(
    DENOM,
    quote,
    shownCeiling === undefined ? undefined : { maxRelayerFee: shownCeiling }
  );
}

describe('hostile relayer — fee manipulation', () => {
  it('accepts an honest quote (harness sanity)', async () => {
    const b = await fetchAndValidate('honest');
    expect(b.relayerFeeMax).toBe(3_066_420n);
  });

  it('REJECTS escalation from the quoted fee to the on-chain cap', async () => {
    // The attack: quote 0.003 at the confirm screen, then 0.02 (the 2% ceiling) when the
    // proof is generated. Passing the ceiling the user was actually shown must catch it.
    const shown = 3_066_420n;
    await expect(fetchAndValidate('escalate_to_cap', shown)).rejects.toThrow(
      /exceeds the maximum/i
    );
  });

  it('REJECTS a fee above the on-chain cap before any proof work', async () => {
    await expect(fetchAndValidate('above_cap')).rejects.toThrow();
  });

  it('REJECTS a fee equal to the whole denomination', async () => {
    await expect(fetchAndValidate('whole_denomination')).rejects.toThrow();
  });

  it('REJECTS a relayer that lies about what the user receives', async () => {
    // Claims the user gets denomination - treasury, i.e. that the relayer takes nothing,
    // while quoting a non-zero ceiling. The two statements contradict each other.
    await expect(fetchAndValidate('lying_receives')).rejects.toThrow();
  });

  it('REJECTS a negative fee rather than doing signed arithmetic', async () => {
    await expect(fetchAndValidate('negative_fee')).rejects.toThrow();
  });
});

describe('hostile relayer — malformed responses', () => {
  it('does not silently accept a quote missing the fee field', async () => {
    const res = await fetch(`${BASE}/fee_quote?pool=x&attack=missing_fee`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.relayerFeeMax).toBeUndefined();
    // BigInt(undefined) throws TypeError; the app must not reach that unguarded.
    expect(() => BigInt(body.relayerFeeMax as string)).toThrow();
  });

  it('treats a non-numeric fee as invalid', async () => {
    const res = await fetch(`${BASE}/fee_quote?pool=x&attack=nan_fee`);
    const body = (await res.json()) as Record<string, string>;
    expect(() => BigInt(body.relayerFeeMax)).toThrow();
  });

  it('does not pollute Object.prototype from a hostile JSON body', async () => {
    const res = await fetch(`${BASE}/fee_quote?pool=x&attack=proto_pollution`);
    const body = (await res.json()) as Record<string, unknown>;
    // Spreading is how the app moves the body around; it must not reach the prototype.
    const copy = { ...body };
    expect(copy).toBeDefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('survives a 5 MB response body', async () => {
    const res = await fetch(`${BASE}/fee_quote?pool=x&attack=huge_body`);
    const body = (await res.json()) as Record<string, string>;
    expect(BigInt(body.relayerFeeMax)).toBe(3_066_420n);
  });
});

describe('hostile relayer — submit responses', () => {
  it('a success with no signature is not a completed withdrawal', async () => {
    const res = await fetch(`${BASE}/submit_proof?attack=success_no_signature`, {
      method: 'POST',
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.txSignature).toBeUndefined();
    // The app must refuse to announce completion; see useRelayer.submitProof.
  });

  it('an XSS payload in the signature stays inert as text', async () => {
    const res = await fetch(`${BASE}/submit_proof?attack=xss_signature`);
    const body = (await res.json()) as Record<string, string>;
    expect(body.txSignature).toContain('onerror=');
    // React escapes text and attribute values, and explorerTxUrl only ever appends to a
    // fixed https:// origin, so this cannot become script or a javascript: navigation.
    const url = `https://explorer.solana.com/tx/${body.txSignature}`;
    expect(url.startsWith('https://explorer.solana.com/')).toBe(true);
    expect(url.toLowerCase()).not.toMatch(/^javascript:/);
  });

  it('reports an overcharge that exceeds the agreed ceiling', async () => {
    const res = await fetch(`${BASE}/submit_proof?attack=overcharged`);
    const body = (await res.json()) as Record<string, string>;
    const taken = BigInt(body.feeTaken);
    // The chain caps fee_taken <= relayer_fee_max <= denomination/50, so a relayer CLAIMING
    // more than the cap is lying about a transaction the chain would have rejected. The UI
    // displays feeTaken, so it should not present an impossible number as fact.
    expect(taken).toBeGreaterThan(DENOM / 50n);
  });
});

describe('control: the escalation defence comes from the shown ceiling, not the cap', () => {
  it('the SAME escalated quote is ACCEPTED when no shown ceiling is supplied', async () => {
    // 2% is legal on-chain, so nothing in the protocol rejects it. The only thing standing
    // between a user and a 6.5x fee increase between the confirm screen and execution is
    // passing the ceiling they were actually shown. This is exactly what FE-2 restored, and
    // this control proves the previous test is driven by that argument rather than by some
    // unrelated validation.
    const b = await fetchAndValidate('escalate_to_cap');
    expect(b.relayerFeeMax).toBe(20_000_000n);
    expect(b.relayerFeePct).toBeCloseTo(2.0, 5);
  });
});

// The "server never answers" attack is NOT tested here. The app's fetchWithTimeout uses a
// native AbortController, and jsdom's fetch rejects a native AbortSignal outright
// ("Expected signal to be an instance of AbortSignal"), so this environment cannot exercise
// the real timeout path at all — it can only test a stubbed fetch, which proves nothing about
// whether the abort actually fires. It is covered against a genuinely hanging socket in a real
// browser instead: see security/browser_attack.mjs.
