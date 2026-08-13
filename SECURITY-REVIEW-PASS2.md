# SolnadoCash — Second-Pass Adversarial Audit

Scope: re-audit of the repository *after* the first-pass fixes (C-1, H-1…H-6, M-1…M-10,
L-1…L-10), approached as an attacker rather than a reviewer. Explicit goals: find bugs
the first pass missed, and find bugs the first pass **introduced**.

Method: fresh read of the hardened withdraw path; dependency-source review of the
BN254 syscalls; economic modelling of the fee cap against real relayer cost; empirical
probing of Solana runtime rules on a local validator.

**Three new exploitable findings. Two of them are regressions from my own first-pass
fixes.** Four further attack hypotheses were tested and found safe; they are recorded
so nobody has to re-derive them.

| ID | Severity | Finding | Origin |
|---|---|---|---|
| N-1 | High | Relayer refuses the 0.1 SOL pool outright — fee ceiling exceeds the on-chain cap | regression from H-3 |
| N-2 | High | Relayer spends real SOL on transactions it can prove will fail — pool account never validated | regression from M-4 |
| N-3 | High | Pools can be created whose deposits are permanently unwithdrawable to a fresh address | pre-existing, missed in pass 1 |
| N-4 | Low | Root-ring flush griefing invalidates in-flight proofs | pre-existing, by design |

**Status: N-1, N-2 and N-3 are FIXED and verified** — 23 Rust unit, 32 local on-chain,
96 SDK, 40 relayer, and 38/38 on-chain checks against the deployed devnet program.
N-4 is documented and deliberately not "fixed".

---

## N-1 — The 0.1 SOL pool is unusable through any relayer (High)

**Origin: my own H-3 fix.** I capped `relayer_fee_max` at `denomination / 50` on-chain
and made `/fee_quote` refuse to issue a ceiling above that cap. Both are correct in
isolation. Together they make the smallest advertised pool unrelayable, because the
dominant cost of a withdrawal is **fixed**, not proportional to the denomination:

```
relayer cost at zero priority fee = 5_000 (base) + 1_447_680 (nullifier rent) = 1_452_680
quoted ceiling                    = cost × 1.5 margin                        = 2_179_020
on-chain cap for a 0.1 SOL pool   = 100_000_000 / 50                          = 2_000_000
                                                     2_179_020 > 2_000_000  → refused
```

Reproduced directly against `relayer/src/fees.js`:

```
0.1 SOL   cap=      2000000  feeMax= 2179020  *** RELAYER REFUSES (FeeAbovePoolCap) ***
1 SOL     cap=     20000000  feeMax= 2179020  OK
10 SOL    cap=    200000000  feeMax= 2179020  OK
```

**Impact is a privacy failure, not just an outage.** A user holding a 0.1 SOL note gets
`503 FeeAbovePoolCap` from every honest relayer, so their only route is to submit the
withdrawal themselves — paying gas from a wallet they control, which is precisely the
link the protocol exists to break. The pool is advertised in the app's default list, so
this is the path a real user hits first.

Relaying only becomes possible above `50 × nullifier_rent ≈ 72.4M lamports` (cap covers
rent), and only comfortable above `75 × cost ≈ 109M lamports` (cap covers cost plus
margin). 0.1 SOL sits in the gap.

**Fix.** Quote `min(cost × margin, cap)` and refuse only when the *actual cost* exceeds
the cap. For a 0.1 SOL pool that yields a 2,000,000 ceiling against a 1,452,680 cost —
still 38% headroom for congestion — instead of refusing service.

## N-2 — The relayer pays for transactions it can prove will fail (High)

**Origin: my own M-4 fix.** I added `preflight()` to stop the relayer spending fees on
doomed submissions. It validates the root against the pool's root history and the
withdrawal commitment against `(relayer, feeMax, recipient)` — but it reads those from
whatever account the **caller** names as the pool:

```js
const poolInfo = await connection.getAccountInfo(poolPubkey);
if (!poolInfo) return res.status(404).json({ error: "PoolNotFound" });
// treasury at offset 8 + 88 = 96, 32 bytes
const treasuryAddress = new PublicKey(poolInfo.data.subarray(96, 128));
```

No owner check. No discriminator check. Both endpoints read raw byte offsets from an
arbitrary account.

**Exploit.** The attacker creates an ordinary data account they control, writes their
own Merkle root at the pool root-history offset, and builds a genuinely valid Groth16
proof against a tree they constructed themselves — the proving key is public, so this
costs a couple of seconds. `verifyProofOffChain` passes (the proof is valid). `preflight`
passes (the attacker authored the root history it checks against, and can compute a
correct commitment for the relayer's own pubkey). The relayer signs, pays, and the
transaction dies on-chain at the very first check — `pool_info.owner == program_id`.

Each attempt burns the relayer's base fee plus priority fee for nothing. Rate limits
(5/min per IP, 3/min per nullifier) slow but do not stop it: the nullifier limiter is
keyed on a value the attacker varies freely, and IPs rotate. The preflight I added is
worthless against this, because it trusts attacker-supplied data as its source of truth.

**Fix.** Validate the pool account before reading any offset from it: owner must be the
program, and the first 8 bytes must be the `Pool` discriminator.

## N-3 — Pools whose deposits can never be withdrawn to a fresh address (High)

`initialize_pool` enforces `denomination >= 500` lamports (BF-14). Solana's runtime
enforces something the program never accounts for: **a transaction may not leave an
account below its rent-exempt minimum.** Measured on a local validator, transferring to
a fresh (0-byte) account:

```
      1 lamports -> REJECTED (insufficient funds for rent)
   1000 lamports -> REJECTED
 100000 lamports -> REJECTED
 500000 lamports -> REJECTED
 890879 lamports -> REJECTED
 890880 lamports -> OK          ← exactly rent.minimum_balance(0)
```

A withdrawal pays `user_amount = denomination − treasury_fee − relayer_fee_taken` to the
recipient. Privacy requires that recipient to be a **fresh** address. So any pool whose
worst-case `user_amount` falls below 890,880 lamports accepts deposits that can never be
withdrawn privately — the transaction is rejected by the runtime before the program's
own logic is reached, so no error message points at the cause.

Solving `denom − denom/500 − denom/50 ≥ 890_880` gives a true floor of **≈ 910,900
lamports (0.00091 SOL)** — about 1,822× the limit the program actually enforces. Anyone
can create such a pool, including by typo, and the funds are stranded. The only escape
is withdrawing to an already-funded address, which reveals the link and defeats the
protocol.

**Fix.** Require on-chain that the worst-case user amount clears
`Rent::minimum_balance(0)`, computed from the live rent sysvar rather than a constant.

## N-4 — Root-ring flush griefing (Low, by design)

The pool keeps 256 historical roots. An attacker who makes 256 deposits rotates every
existing root out of the ring, so any proof generated but not yet submitted becomes
invalid (`RootNotFound`). The capital is recoverable — the attacker can withdraw their
own deposits afterwards — so the real cost is transaction fees plus temporarily locked
funds.

Not fixed, and I do not recommend "fixing" it: enlarging the ring costs account space
linearly, and the failure is now graceful (the relayer's preflight rejects a stale root
before spending anything, and the SDK tells the user to regenerate). Tornado Cash has
the same property with a 100-root window. Worth knowing it exists, and worth monitoring
for in production: a burst of deposits immediately followed by withdrawals of the same
deposits is the signature.

---

## Attack hypotheses tested and found safe

Recorded so future reviewers need not re-derive them.

**BN254 proof points cannot carry small-subgroup attacks.** `solana-program`'s
`TryFrom<PodG1>`/`TryFrom<PodG2>` deserialise with `Validate::Yes` and then call
`is_on_curve()` explicitly. Arkworks' validation covers both curve membership and
prime-order subgroup membership, so a proof built from a low-order point is rejected by
the syscall before any pairing is computed.

**Cross-pool root collision is possible but unprofitable.** An attacker can replay
another pool's leaves into a pool of their own, making the two pools share roots. It buys
nothing: the vault is per-pool, every insert costs that pool's own denomination, and the
nullifier PDA is seeded with the pool key, so a proof valid in both pools can only ever
draw funds the attacker themselves deposited.

**The vault cannot be drained below rent-exemption.** Balance is always
`rent + (deposits − withdrawals) × denomination`, and each withdrawal is gated on
`vault.lamports() >= denomination`, so the floor is the initial rent. The vault PDA
cannot be deleted out from under the pool.

**Every ZK public input is constrained.** `nullifierHash` is bound by C1, `root` by
`MerkleProof`'s final equality, and `withdrawalCommitment` by C4. There is no dangling
public input the prover could choose freely — the classic under-constraint bug is
absent. `denomination` and `relayerFeeMax` are unconstrained *private* inputs, which is
sound: the former must hash to a leaf that exists in the tree, and the latter is pinned
to a `u64` by the on-chain commitment recomputation.

---

*Second pass performed 2026-08-13 against commit `d5bf8e8`. Every finding here was
reproduced — by direct execution of the affected code, by dependency-source inspection,
or by probing the runtime on a local validator.*
