import { RELAYER_URL } from '../config';

export interface FeeQuote {
  relayerAddress: string;
  relayerFeeMax: string;
  validUntil: number;
  estimatedUserReceives: string;
  treasuryFee: string;
  denomination: string;
}

/**
 * Timeouts (FE-4). None of these calls had one, so an unresponsive or black-holing relayer
 * left the UI spinning forever with no way back — "Getting fee quote…" with a dead button, or
 * a progress screen that never resolves. An open socket is indistinguishable from slow work,
 * so the user cannot even tell whether their note has been spent.
 *
 * The submit budget is deliberately generous: it covers the relayer verifying a proof
 * off-chain and landing a transaction, and giving up too early on a submission that actually
 * succeeded is worse than waiting.
 */
const QUOTE_TIMEOUT_MS = 15_000;
const SUBMIT_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string
): Promise<Response> {
  // AbortSignal.timeout() is not available in every browser this may run in.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `The relayer did not respond within ${Math.round(timeoutMs / 1000)}s (${what}). ` +
          `It may be down or overloaded.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse JSON without letting a non-JSON response surface as a confusing syntax error. */
async function parseJson(res: Response, what: string): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `The relayer returned a response that is not JSON (${what}). ` +
        `Check that ${RELAYER_URL} is a relayer and not something else.`
    );
  }
}

export async function fetchFeeQuote(poolAddress: string): Promise<FeeQuote> {
  const res = await fetchWithTimeout(
    `${RELAYER_URL}/fee_quote?pool=${encodeURIComponent(poolAddress)}`,
    {},
    QUOTE_TIMEOUT_MS,
    'fee quote'
  );
  const body = (await parseJson(res, 'fee quote')) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error((body.error as string) || 'Failed to get fee quote');
  }
  // Check the shape here rather than letting BigInt() throw a bare SyntaxError later.
  for (const field of ['relayerAddress', 'relayerFeeMax', 'estimatedUserReceives']) {
    if (body[field] === undefined || body[field] === null) {
      throw new Error(`The relayer's fee quote is missing "${field}".`);
    }
  }
  return body as unknown as FeeQuote;
}

export async function submitProof(params: {
  proof: unknown;
  publicSignals: string[];
  poolAddress: string;
  recipient: string;
  relayerFeeMax: string;
}): Promise<{ txSignature: string; feeTaken: string }> {
  const res = await fetchWithTimeout(
    `${RELAYER_URL}/submit_proof`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
    SUBMIT_TIMEOUT_MS,
    'proof submission'
  );
  const body = (await parseJson(res, 'proof submission')) as Record<string, unknown>;
  if (!res.ok) {
    const code = (body.error as string) || `HTTP ${res.status}`;
    const detail = (body.message as string) || '';
    const logs = body.logs as string[] | undefined;
    // Include both error code and detail so the UI can show actionable info
    const parts = [code, detail].filter(Boolean);
    if (logs?.length) parts.push('Logs: ' + logs.join(' | '));
    throw new Error(parts.join(': '));
  }
  // FE-10: the UI announces "Withdrawal complete" off the back of this, so a 200 with no
  // signature must not read as success — there would be nothing to verify and no way to tell
  // whether the note was spent.
  if (typeof body.txSignature !== 'string' || body.txSignature.length === 0) {
    throw new Error(
      'The relayer reported success but returned no transaction signature, so the ' +
        'withdrawal cannot be verified. Check the recipient balance before retrying: ' +
        'your note may already be spent.'
    );
  }
  return body as unknown as { txSignature: string; feeTaken: string };
}

export async function checkRelayerHealth(): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      `${RELAYER_URL}/health`,
      {},
      HEALTH_TIMEOUT_MS,
      'health'
    );
    if (!res.ok) return false;
    const data = (await parseJson(res, 'health')) as Record<string, unknown>;
    return data.status === 'ok';
  } catch {
    return false;
  }
}
