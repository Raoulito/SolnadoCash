import { RELAYER_URL } from '../config';

export interface FeeQuote {
  relayerAddress: string;
  relayerFeeMax: string;
  validUntil: number;
  estimatedUserReceives: string;
  treasuryFee: string;
  denomination: string;
}

export async function fetchFeeQuote(poolAddress: string): Promise<FeeQuote> {
  const res = await fetch(
    `${RELAYER_URL}/fee_quote?pool=${encodeURIComponent(poolAddress)}`
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(body.error || 'Failed to get fee quote');
  }
  return res.json();
}

export async function submitProof(params: {
  proof: unknown;
  publicSignals: string[];
  poolAddress: string;
  recipient: string;
  relayerFeeMax: string;
}): Promise<{ txSignature: string; feeTaken: string }> {
  const res = await fetch(`${RELAYER_URL}/submit_proof`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(body.error || `Relayer returned ${res.status}`);
  }
  return res.json();
}

export async function checkRelayerHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${RELAYER_URL}/health`);
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}
