// /tmp/hostile_relayer.mjs
// A deliberately malicious relayer, to attack the SolnadoCash frontend's trust boundary.
// Mode is selected per-request via the ?attack= query param or the X-Attack header so one
// server can serve every scenario.
//
// Run: node /tmp/hostile_relayer.mjs 3999

import { createServer } from 'http';

const PORT = Number(process.argv[2] || 3999);
const DENOM = 1_000_000_000n;            // 1 SOL pool
const TREASURY = DENOM / 500n;           // 2_000_000
const CAP = DENOM / 50n;                 // 20_000_000 (the on-chain 2% ceiling)
const HONEST_FEE = 3_066_420n;
const REAL_RELAYER = '4PLXgVX9MumeLLjcyvYFNoKq1dECdEneiFA8StLCnf1c';
const ATTACKER_RELAYER = '9eQQp4q3cxwnhd5LJ6ENxS65uyDSFME7DQzU282DQBpF';

function quote(fee, extra = {}) {
  return {
    relayerAddress: REAL_RELAYER,
    relayerFeeMax: fee.toString(),
    validUntil: Date.now() + 300_000, // ms, matching the real relayer
    estimatedUserReceives: (DENOM - TREASURY - fee).toString(),
    treasuryFee: TREASURY.toString(),
    denomination: DENOM.toString(),
    ...extra,
  };
}

// Per-scenario responses. Each returns [status, body, contentType?].
const ATTACKS = {
  // Baseline: an honest quote, to prove the harness works.
  honest: () => [200, quote(HONEST_FEE)],

  // 1. Escalate to the on-chain ceiling. If the app binds this into the proof without
  //    comparing against what it showed the user, the relayer takes 2% instead of 0.3%.
  escalate_to_cap: () => [200, quote(CAP)],

  // 2. Exceed the on-chain cap. Must be refused before a proof is generated; otherwise the
  //    user burns ~60s of CPU on a proof the chain will reject.
  above_cap: () => [200, quote(CAP + 1n)],

  // 3. Absurd fee: the whole denomination.
  whole_denomination: () => [200, quote(DENOM)],

  // 4. Lie about what the user receives while quoting an honest fee.
  lying_receives: () => [
    200,
    quote(HONEST_FEE, { estimatedUserReceives: (DENOM - TREASURY).toString() }),
  ],

  // 5. Swap the relayer identity.
  swapped_relayer: () => [200, quote(HONEST_FEE, { relayerAddress: ATTACKER_RELAYER })],

  // 6. Missing required field.
  missing_fee: () => {
    const q = quote(HONEST_FEE);
    delete q.relayerFeeMax;
    return [200, q];
  },

  // 7. Non-numeric fee — reaches BigInt() and throws a bare SyntaxError if unguarded.
  nan_fee: () => [200, quote(HONEST_FEE, { relayerFeeMax: 'not-a-number' })],

  // 8. Negative fee. BigInt accepts it; downstream arithmetic may not.
  negative_fee: () => [200, quote(HONEST_FEE, { relayerFeeMax: '-5000000' })],

  // 9. Prototype pollution attempt through the JSON body.
  proto_pollution: () => [
    200,
    JSON.parse(
      `{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}},` +
        `"relayerAddress":"${REAL_RELAYER}","relayerFeeMax":"${HONEST_FEE}",` +
        `"validUntil":${Date.now() + 300_000},` +
        `"estimatedUserReceives":"1","treasuryFee":"1","denomination":"${DENOM}"}`
    ),
  ],

  // 10. Not JSON at all (a proxy error page).
  html_error: () => [502, '<html><body>Bad Gateway</body></html>', 'text/html'],

  // 11. Enormous body — try to exhaust the client.
  huge_body: () => [200, quote(HONEST_FEE, { padding: 'A'.repeat(5_000_000) })],

  // 12. A submit response claiming success with no signature.
  success_no_signature: () => [200, { feeTaken: HONEST_FEE.toString() }],

  // 13. XSS attempt through the transaction signature, which the UI renders into a link.
  xss_signature: () => [
    200,
    {
      txSignature: '"><img src=x onerror=alert(1)>javascript:alert(document.cookie)',
      feeTaken: HONEST_FEE.toString(),
    },
  ],

  // 14. feeTaken above the agreed ceiling, reported after the fact.
  overcharged: () => [200, { txSignature: 'sig_overcharge', feeTaken: (CAP * 5n).toString() }],

  // 15. Never respond, to test client timeouts.
  hang: () => null,
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const mode = url.searchParams.get('attack') || req.headers['x-attack'] || 'honest';
  const handler = ATTACKS[mode];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (!handler) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'UnknownAttackMode', mode }));
  }

  const result = handler();
  if (result === null) return; // hang: hold the socket open forever

  const [status, body, contentType] = result;
  res.writeHead(status, { 'Content-Type': contentType || 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
});

server.listen(PORT, () => {
  console.log(`hostile relayer on http://localhost:${PORT} — modes: ${Object.keys(ATTACKS).join(', ')}`);
});
