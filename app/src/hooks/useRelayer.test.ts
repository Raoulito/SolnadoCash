// app/src/hooks/useRelayer.test.ts
//
// FE-4/FE-10: a relayer that never answers used to hang the UI forever, and a 200 with no
// signature used to read as a completed withdrawal. Both are asserted here with a fake fetch,
// including that the timeout actually aborts rather than merely being configured.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fetchFeeQuote, submitProof, checkRelayerHealth } from './useRelayer';

const GOOD_QUOTE = {
  relayerAddress: '4PLXgVX9MumeLLjcyvYFNoKq1dECdEneiFA8StLCnf1c',
  relayerFeeMax: '3066420',
  validUntil: 1_800_000_000,
  estimatedUserReceives: '994933580',
  treasuryFee: '2000000',
  denomination: '1000000000',
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const SUBMIT_ARGS = {
  proof: {},
  publicSignals: ['1', '2', '3'],
  poolAddress: 'pool',
  recipient: 'rcpt',
  relayerFeeMax: '3066420',
};

describe('relayer client', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns a well-formed quote', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(GOOD_QUOTE)));
    await expect(fetchFeeQuote('pool')).resolves.toMatchObject({
      relayerFeeMax: '3066420',
    });
  });

  it('aborts a hanging fee quote instead of waiting forever', async () => {
    // A fetch that only settles when aborted, like a black-holed connection.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }))
    );

    const promise = fetchFeeQuote('pool');
    const assertion = expect(promise).rejects.toThrow(/did not respond within 15s/);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('aborts a hanging submission', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }))
    );

    const promise = submitProof(SUBMIT_ARGS);
    const assertion = expect(promise).rejects.toThrow(/did not respond within 120s/);
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });

  it('rejects a quote missing required fields rather than failing later in BigInt()', async () => {
    const { relayerFeeMax: _omitted, ...incomplete } = GOOD_QUOTE;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(incomplete)));
    await expect(fetchFeeQuote('pool')).rejects.toThrow(/missing "relayerFeeMax"/);
  });

  it('explains a non-JSON response instead of throwing a syntax error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>gateway error</html>',
    } as unknown as Response)));
    await expect(fetchFeeQuote('pool')).rejects.toThrow(/not JSON/);
  });

  it('surfaces a relayer error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ error: 'PoolPaused', message: 'deposits paused' }, false, 400)
    ));
    await expect(submitProof(SUBMIT_ARGS)).rejects.toThrow(/PoolPaused: deposits paused/);
  });

  it('refuses to report success without a transaction signature', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ feeTaken: '3000000' })));
    await expect(submitProof(SUBMIT_ARGS)).rejects.toThrow(/no transaction signature/);
  });

  it('accepts a submission that includes a signature', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ txSignature: 'abc123', feeTaken: '3000000' })
    ));
    await expect(submitProof(SUBMIT_ARGS)).resolves.toMatchObject({
      txSignature: 'abc123',
    });
  });

  it('reports an unhealthy relayer as false rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    await expect(checkRelayerHealth()).resolves.toBe(false);
  });
});
