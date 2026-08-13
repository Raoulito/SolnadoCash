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

## Structured audit pass (Phases 1–4)

Executed against commit `70938d3`.

### Phase 1 — Automated static analysis

| Tool | Result |
|---|---|
| `cargo clippy --all-targets --all-features -- -D warnings` | **clean** (was 2 compile errors + 3 lints) |
| `cargo audit` | **clean** (was 2 vulnerabilities) |
| `cargo machete` | **clean** (was 1 unused dependency) |
| Sec3 / Soteria | not run — see below |

**Real defect found: the crate did not compile under `--features benchmark,cpi`.** The
`cpi` feature makes `#[program]` generate CPI wrappers referencing `Benchmark<'info>`,
but an empty accounts struct has no lifetime parameter. Anyone integrating this program
via CPI with benchmarks enabled hit a compile error, and `--all-features` — what
auditors and CI run — failed outright. Fixed by giving `Benchmark` a `system_program`
field, which Anchor resolves automatically. All six feature combinations now compile.

Three `needless_range_loop` lints: two were plain array fills in `initialize_pool`,
replaced with whole-array assignment. The third, in `Pool::insert`, is deliberately
`#[allow]`ed with a written reason — that index addresses two arrays and tracks tree
position, and contorting security-critical Merkle code into an iterator chain to satisfy
a style lint is the wrong trade.

`cargo audit` found two advisories:
- RUSTSEC-2026-0204 (crossbeam-epoch, invalid pointer deref) — fixed by `cargo update`
  to 0.9.20. Build-time only, reached via `solana-frozen-abi`.
- RUSTSEC-2024-0344 (curve25519-dalek 3.2.1, timing variability in `Scalar::sub`) —
  **accepted** in `.cargo/audit.toml` with justification. It is reachable transitively
  via `solana-program` 1.18.26 and used for PDA derivation, but the advisory concerns a
  side channel on *secret* ed25519 scalars and this program has none: note secrets are
  BN254 elements handled off-chain, proof verification uses the `alt_bn128` syscalls, and
  PDA seeds are public by the time they reach the chain. 3.2.1 is pinned by
  `solana-program`, so the real fix is the Solana stack upgrade before mainnet.

Unmaintained/unsound *warnings* (bincode, im, rand, memmap2, sized-chunks, …) are all
transitive Solana 1.18 dependencies and are deliberately **not** ignored, so the stack
upgrade stays visible.

`cargo machete` flagged `bytemuck`. It was genuinely unused — Anchor's `zero_copy` macro
uses its own re-export — verified by building and testing without it. Removed.

**Sec3 / Soteria was not run.** The open-source `soteria` CLI is effectively
unmaintained and pinned to old Solana versions; the successor is a hosted commercial
product. Its published rule set — missing signer checks, incorrect owner validation,
integer overflow, PDA misuse — is covered explicitly by Phase 4 below and by the
`overflow-checks = true` profile. This is a gap in tooling coverage, not in reasoning,
and running the hosted product before mainnet is worth doing.

### Phase 2 — Fuzzing and property-based testing

`proptest` added with **11 properties over the real on-chain functions**. The refactor
that made this possible matters more than the tests: the fee arithmetic and denomination
floor were inline in the instruction handlers, so properties could only test a *mirrored
copy* — which drifts and then constrains nothing. Extracted `compute_fee_split()` and
`worst_case_user_amount()` as pure functions called by both.

Properties: conservation, user keeps ≥97.8%, user amount never zero, relayer fee doubly
bounded, no panic on any `u64` triple, accepted denominations always withdrawable (N-3),
treasury fee bounded, canonical-field check matches numeric comparison, values ≥ Fr
always rejected, pubkey encoding always in-field, distinct pubkeys never collide (H-2
regression guard).

**The suite was validated by mutation testing rather than assumed to work**, which
exposed two generator defects that made it far weaker than it looked:

| Mutation | Before | After |
|---|---|---|
| 2% fee cap removed | 1 property failed | 2 properties fail |
| conservation broken | caught | caught |
| `is_canonical_fr` accepts exactly Fr | **missed** | caught |
| `user_amount > 0` removed | not caught | not caught — *unreachable, see below* |

- Fees drawn uniformly from `0..u64::MAX/4` almost always overflowed into the rejected
  branch, so the region around the 2% cap — where bugs live — was never explored. Fees
  are now generated *relative to the denomination*, spanning the cap.
- Uniform 32-byte draws never hit `x == Fr` (probability 2⁻²⁵⁶), so an off-by-one
  accepting exactly Fr passed every property while the hand-written boundary unit test
  caught it immediately. The generator now mixes uniform draws with Fr, Fr±1, zero and
  all-ones. This is a good illustration of why fuzzing and boundary unit tests are
  complements, not substitutes.
- Removing `user_amount > 0` is provably undetectable: with the 2% cap the user always
  keeps ≥97.8%, so a zero payout is unreachable. That check is defence-in-depth against
  a future cap change, exactly as its comment claims.

**Trident and `cargo fuzz` were not run.** Both need a dedicated harness (honggfuzz /
libFuzzer plus a Solana-aware corpus) that is a project in itself. Partial equivalent
coverage exists: malformed instruction data is rejected by Borsh deserialisation before
reaching any logic; every account-substitution vector Trident would explore is covered
by explicit on-chain negative tests (wrong pool, wrong vault, wrong treasury, vault as
recipient, pre-funded nullifier, aliased public inputs); and the pure arithmetic that
`cargo fuzz` would target is now covered by proptest with mutation-validated
generators. A real Trident harness remains worthwhile before mainnet.

### Phase 3 — ZK circuit analysis

`circomspect` (Trail of Bits) on every circuit:

```
withdraw.circom      2 issues (both INFO, benign — see below)
merkle_proof.circom  No issues found
deposit.circom       No issues found
poseidon.circom      No issues found
```

The two notes on `withdraw.circom` are field-arithmetic and field-comparison warnings on
the loop counter `i < levels`, where `levels` is the compile-time constant 20 — standard
false positives for bounded `for` loops.

**No under-constrained signals reported**, which corroborates the manual finding that
all three public inputs are constrained (`nullifierHash` by C1, `root` by `MerkleProof`'s
final equality, `withdrawalCommitment` by C4).

Stated precisely: circomspect is a static analyser and does not *prove* the absence of
under-constraints. **Ecne was not run** — it is a Julia R1CS solver whose setup is
substantial. Given that a single-party trusted setup (C-2) already lets the operator
forge proofs, circuit soundness is not currently the binding constraint on trust; it
becomes the binding constraint the moment the ceremony is redone, and Ecne or an
equivalent R1CS analysis should run before that.

### Phase 4 — Manual logic review

Each item verified against the code, with the evidence rather than an assurance.

**Missing signer checks** — every state-changing instruction requires a signature:
`withdraw` takes `relayer: Signer<'info>` *and* re-checks `relayer_info.is_signer`
in the bare-metal path (belt and braces, since the shim's guarantee is easy to lose in a
refactor); `initialize_pool` and `pause`/`unpause` take `admin: Signer`, with the
handlers additionally asserting `pool.admin == admin.key()`; `deposit` takes
`depositor: Signer`. No instruction mutates state or moves lamports without one.

**Incorrect owner checks** — `withdraw` uses `UncheckedAccount` throughout, so every
check is manual and explicit: pool is `owner == program_id` **plus** an 8-byte
discriminator match (ownership alone is insufficient — vaults and nullifier accounts are
program-owned too); vault is re-derived and `owner == program_id`; nullifier is
`data_is_empty()` and, on the top-up path, asserted system-owned; treasury is checked by
*identity* against `pool.treasury`, which is stronger than an owner check; system program
is checked by ID. `recipient` deliberately has no owner check — it is credit-only, and
crediting any account is permitted by the runtime.

**PDA derivation** — the nullifier PDA uses `find_program_address`, so only the canonical
bump is ever accepted; the caller-supplied bump was removed entirely (L-4) because
accepting one is precisely the shape of the original double-spend. Vault and pool use
`create_program_address` with bumps *stored in the authenticated pool account* and then
compare against the passed key. Seeds are collision-resistant by construction: every
component is fixed-length (`"pool"` + admin32 + mint32 + denom8 + version1), so no
concatenation ambiguity exists.

**CPI spoofing** — the only CPI target anywhere is the System Program. In `withdraw` its
address is asserted equal to `system_program::ID` before use; in `deposit` it is typed
`Program<'info, System>`, which Anchor validates. There is no call into a user-supplied
program, so there is no CPI to spoof.

**Re-entrancy / state staleness** — Solana forbids re-entrancy, and the ordering is
correct regardless. In `deposit` the Merkle insert completes and the pool borrow is
released before the transfer CPI, so no borrow is held across a CPI boundary and a failed
transfer reverts the insert atomically.

**ZK-specific: nullifier re-use** — traced line by line. The nullifier PDA is checked
empty (`withdraw.rs:289`), the account is created (`:360`), its data is written
(`:426`), and only then do lamports move (`:441`–`:444`). **The nullifier is committed to
state before any funds leave the vault**, so a duplicate is impossible even under
partial failure: a second withdrawal finds a non-empty account and reverts. This is
reinforced by the canonical-input guard from C-1, without which the *same* note produced
5–6 distinct nullifier PDAs.

---

*Structured audit executed 2026-08-13. Tooling actually run: cargo clippy, cargo audit,
cargo machete, proptest (with mutation validation), circomspect. Not run, with reasons
given: Sec3/Soteria, Trident, cargo fuzz, Ecne.*
