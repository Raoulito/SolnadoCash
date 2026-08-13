# SolnadoCash — Nuclear-Grade Code Review

Scope: full repository at commit `4d74d9e` — on-chain program, Circom circuits, trusted setup,
TypeScript SDK, relayer, React app, tests, scripts, docs.
Method: line-by-line read of every source file, plus experimental verification of every claim
marked **[verified]** below (dependency source inspection, numeric reproduction, live devnet RPC).

**Verdict: do not deploy to mainnet.** Three independent issues each allow complete loss of all
pooled funds. One of them (C-1) requires no privileged position, no cryptography and no capital
beyond a single deposit.

| Severity | Count | IDs |
|---|---|---|
| Critical | 3 | C-1 … C-3 |
| High | 6 | H-1 … H-6 |
| Medium | 10 | M-1 … M-10 |
| Low | 10 | L-1 … L-10 |

---

## 1. What the code gets right

Before the findings, the parts that are genuinely correct — they matter because they narrow
where the bugs actually are.

- **Field/endianness discipline is consistent end to end.** `sol_poseidon(BN254X5, BigEndian)`
  on-chain, `circomlibjs` off-chain, and the generated `ZEROS` table agree; commitment bytes are
  big-endian in Rust (`state.rs:82`), in the SDK (`app/src/utils/program.ts:64`) and in the
  relayer (`relayer/src/tx.js:28`). This is the most common source of silent failure in
  Circom↔Solana bridges and it is handled.
- **The verifying key genuinely matches the compiled circuit. [verified]** Re-running
  `scripts/convert_vk_to_rust.js circuits/build/withdraw_vk.json` reproduces
  `programs/solnadocash/src/vk.rs` byte-for-byte, and `nPublic == 3` matches
  `nr_pubinputs: 3` and the on-chain input array.
- **Constraint counts match the README. [verified]** withdraw 12,065 / deposit 605.
- **Groth16 wire format is right.** `proof_a` y-negation mod Fq and G2 in EIP-197 order
  (`x_im‖x_re‖y_im‖y_re`) are both correct for `groth16-solana`, in both the converter and the
  relayer.
- **Incremental Merkle insert is a faithful Tornado-style implementation** (`state.rs:71-106`),
  with `filled_subtrees` updated only on left-child positions, and the depth-20 empty root
  derived as `H(ZEROS[19], ZEROS[19])`.
- **The bare-metal `withdraw` does perform the account validation it needs**: program ownership
  and Anchor discriminator on the pool, `create_program_address` on the vault plus vault
  ownership, `treasury == pool.treasury`, system-program identity, relayer signer, account-count
  guard, canonical nullifier bump, `checked_sub` on the fee split, and a vault balance floor.
  For hand-rolled Solana code this is above average.
- **`reduce_mod_fr` itself is arithmetically correct** (big-endian compare-and-subtract,
  5 iterations is sufficient because `⌊2²⁵⁶/Fr⌋ = 5`). Its *use* is the problem — see H-2.
- **The Merkle circuit's selector is correctly binary-constrained**
  (`pathIndices[i] * (1 - pathIndices[i]) === 0`) and uses one multiplication per branch.

---

## 2. Critical

### C-1 — Double-spend via non-canonical public inputs: any depositor drains the pool

**Files:** `programs/solnadocash/src/withdraw.rs:186`, `:192`, `:251`

```rust
let (expected_nullifier, canonical_bump) = Pubkey::find_program_address(
    &[b"nullifier", pool_info.key.as_ref(), &args.nullifier_hash],  // raw 32 bytes as seed
    program_id,
);
...
let public_inputs = [args.nullifier_hash, args.root, args.withdrawal_commitment];
```

`args.nullifier_hash` is never checked to be a canonical BN254 scalar (`< Fr`). Two facts make
this fatal:

1. **`groth16-solana` 0.0.3 performs no range check on public inputs. [verified]**
   `prepare_inputs` passes the raw 32 bytes straight into `alt_bn128_multiplication`
   (`groth16-solana-0.0.3/src/groth16.rs:88-104`).
2. **The syscall treats the scalar as an unreduced 256-bit integer. [verified]**
   `solana-program-1.18.26/src/alt_bn128/mod.rs:214-219`:
   ```rust
   let fr = BigInteger256::deserialize_uncompressed_unchecked(...)?;   // no modulus check
   let result_point: G1 = p.mul_bigint(fr).into();
   ```
   The upstream test vector `cdetrio1` uses scalar `0xffff…ff` and expects success, confirming
   unreduced scalars are accepted. Since `IC[i]` has order `r = Fr`,
   `IC[i] · (h + k·Fr) = IC[i] · h` exactly.

Therefore `nullifier_hash = h` and `nullifier_hash = h + k·Fr` produce **identical** prepared
inputs, an identical pairing result — and **different PDA addresses**, because the PDA is derived
from the raw seed bytes.

`root` and `withdrawal_commitment` are immune (both are compared byte-wise against stored /
recomputed values). `nullifier_hash` is the one public input whose *bytes* carry semantic weight.

**Exploit (no privileges, no forgery, ~6 transactions):**

1. Deposit 1 SOL, obtain note `(n, s)`.
2. Generate one honest withdraw proof with `relayerAddress = attacker`, `recipient = attacker`,
   `relayerFeeMax = 0`. The attacker is its own relayer, so the `relayer_info.is_signer` and
   commitment checks are satisfied by construction.
3. Submit the *same* `proof_a/b/c`, `root` and `withdrawal_commitment` 6 times, varying only
   `nullifier_hash ∈ {h, h+Fr, h+2Fr, h+3Fr, h+4Fr, h+5Fr}`.
   `h < Fr ≈ 2.19·10⁷⁶` and `2²⁵⁶ ≈ 1.16·10⁷⁷`, so 5 aliases always fit in 32 bytes and a 6th
   fits for ~29% of hashes.
4. Every submission passes Groth16 verification, hits a fresh empty nullifier PDA, and pays out
   `denomination − treasury_fee`. Net: **~5.99 SOL out for 1 SOL in**, repeatable until the vault
   is empty.

The reference relayer would reject these (snarkjs `publicInputsAreValid` *does* enforce
canonicity **[verified]**) — which is irrelevant: the attacker never uses a relayer.

**Fix.** Before `Groth16Verifier::new`, reject any non-canonical public input:

```rust
#[inline(always)]
fn is_canonical_fr(be: &[u8; 32]) -> bool {
    for i in 0..32 {
        if be[i] < BN254_FR[i] { return true; }
        if be[i] > BN254_FR[i] { return false; }
    }
    false // equal to Fr is out of range
}
require!(is_canonical_fr(&args.nullifier_hash), ErrorCode::NonCanonicalInput);
require!(is_canonical_fr(&args.root), ErrorCode::NonCanonicalInput);
require!(is_canonical_fr(&args.withdrawal_commitment), ErrorCode::NonCanonicalInput);
```

Apply the same rule to *any* future public input, and add a regression test that submits
`h + Fr` and expects failure. Do not rely on `groth16-solana` to do this.

### C-2 — Single-party trusted setup: the operator can forge unlimited withdrawals

**File:** `scripts/trusted_setup.sh:88-104` (withdraw), `:115-131` (deposit)

```bash
snarkjs zkey contribute withdraw_0.zkey withdraw_1.zkey \
    --name="SolnadoCash-Contributor1" -e="$(openssl rand -hex 32)"
snarkjs zkey beacon withdraw_1.zkey withdraw_final.zkey "$(openssl rand -hex 32)" 10
```

Phase 1 uses the public Hermez `pot17` ceremony — fine. Phase 2 is the problem:

- **One contributor**, whose entropy is generated on the same machine that holds the result.
- The **beacon is `openssl rand`**, i.e. a second *secret* contribution. A beacon must be public,
  verifiable randomness fixed after the ceremony (e.g. a named future block hash). As written,
  the operator knows both exponents.
- No transcript, no attestations, no `zkey verify` output published; `circuits/build/` is
  gitignored (see M-7), so nobody can audit the contributions.

Anyone holding that toxic waste can produce valid proofs for statements that are false — withdraw
from every pool without ever depositing, with no on-chain trace distinguishable from an honest
withdrawal. This is unfixable after the fact: it requires a new ceremony and new keys, which
invalidates every outstanding note.

**Fix.** Multi-party ceremony (≥5 independent contributors, ideally with a public coordinator),
a real beacon with a pre-announced source, published transcript + per-contribution attestations,
and committed `withdraw.r1cs` / `withdraw_vk.json` so third parties can run `snarkjs zkey verify`
themselves. Delete the deposit ceremony entirely (see M-9 — that circuit is unused).

### C-3 — Program upgrade authority == pool admin == treasury: single-key custody backdoor

**Verified live on devnet:**

```
program      DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59  (bpf-upgradeable-loader)
programData  2JyVYf7Px1zAAKYkjrUg4ZnJyExThMCv2TCwXwNHS731
  authority  4PLXgVX9MumeLLjcyvYFNoKq1dECdEneiFA8StLCnf1c   ← still set
```

That authority is the same key as the pool admin and the treasury
(`app/src/config.ts:19`, `scripts/deploy_pools.js:97` — `Treasury: same as admin`). The upgrade
authority can replace the program with one that transfers every vault's lamports to itself; the
vaults are program-owned PDAs, so the new code needs no signature from anyone.

This contradicts three README claims outright:

| README claim | Reality |
|---|---|
| "The contract is immutable once deployed (standard Solana BPF program)" | Upgradeable; authority live |
| "The admin cannot access the vault — only ZK proofs can authorize withdrawals" | Upgrade → arbitrary vault access |
| "No Admin Backdoors" | One key = code + pause + treasury |

**Fix.** Before any real value is deposited: `solana program set-upgrade-authority --final`, or
transfer to a timelocked multisig with a published delay; separate admin, treasury and upgrade
roles onto distinct keys; correct the README to state the actual authority model and link to the
on-chain proof.

---

## 3. High

### H-1 — 1 lamport permanently freezes any note (nullifier PDA pre-funding)

**File:** `programs/solnadocash/src/withdraw.rs:238-253`

`system_instruction::create_account` fails with `SystemError::AccountAlreadyInUse` when the target
already holds lamports — this is long-standing, documented Solana behaviour
(solana-labs/solana#6863: *"we fail the transaction if the account is already in use
(lamports > 0)"*) **[verified]**. There is no fallback path.

The nullifier PDA address is `["nullifier", pool, nullifier_hash]` — fully determined by the note.
Anyone who learns `nullifier_hash` before the withdrawal is finalised can send it 1 lamport and
the note becomes **permanently unspendable**: no code path can allocate that address afterwards,
and no one holds a private key for it, so the lamports can never be moved. Who learns it early:

- the relayer, which receives the full proof before submitting;
- any leader/RPC/mempool observer that sees the transaction and front-runs it with a priority fee.

Cost to the attacker: 1 lamport + one signature. Cost to the victim: the entire deposit. A hostile
relayer can burn every note it is asked to relay while still collecting its fee.

**Fix.** Use the ATA-program pattern: if `nullifier_info.lamports() > 0`, top up the difference
with `system_instruction::transfer` and then `allocate` + `assign` via `invoke_signed`
(both succeed on a system-owned, zero-data account); otherwise `create_account` as today.
Add a test that pre-funds the PDA and expects the withdrawal to still succeed.

### H-2 — Recipient can be swapped for an unspendable alias (relayer griefing, funds burned)

**Files:** `programs/solnadocash/src/withdraw.rs:74-107` (`reduce_mod_fr`), `:206-215`;
`sdk/src/proof.ts:76-81` (`pubkeyToField`)

The recipient is bound into the ZK proof only through
`recipient_field = pubkey mod Fr`. Because pubkeys are 256-bit and `Fr` is ~254-bit, **81% of
addresses have at least one distinct 32-byte alias with the same field element [verified]**:

```
6PW8Wj3wGLKniRSM9rJAVSsDfY3EJPMfzxXotrvdNx6E
9eQQp4q3cxwnhd5LJ6ENxS65uyDSFME7DQzU282DQBpF   ← R + Fr, identical recipient_field
```

A malicious relayer substitutes the alias in the `recipient` account slot. The Poseidon
commitment check at `:215` still passes, the nullifier is consumed, `relayer_fee_taken` is still
paid to the relayer, and `user_amount` lands at an address for which nobody can produce a
signature — an irreversible burn. The alias is not attacker-chosen (finding a *controllable*
alias would require an ed25519 discrete log or a SHA-256 preimage for a PDA), so this is
destruction rather than theft — but from the user's side the loss is total, and BF-20's stated
guarantee ("swapping any of the three invalidates the hash") is false.

**Fix.** Bind the recipient by its full 32-byte identity. Cleanest: split into two field elements
and hash both — `withdrawalCommitment = Poseidon(relayer_hi, relayer_lo, feeMax, recip_hi,
recip_lo)` (e.g. hi = 16 high bytes, lo = 16 low bytes), computed identically in
`withdraw.circom`, `sdk/src/proof.ts` and `withdraw.rs`. Requires a circuit change → new
ceremony, so bundle it with C-2's redo.

### H-3 — Relayer fee is computed in the wrong unit: 10⁶× overcharge

**File:** `relayer/src/fees.js:35-37`

```js
const priorityFee = priorityFeePerCU * COMPUTE_UNITS;      // µlamports/CU × CU
const gasCost = BASE_FEE + priorityFee + NULLIFIER_RENT;   // …added to lamports
```

`getRecentPrioritizationFees` returns **micro-lamports per compute unit**. The `/ 1e6` is missing.
Reproduced numerically **[verified]**, for a 1 SOL pool:

| 90th-pct priority fee | quoted `relayerFeeMax` (as coded) | correct |
|---|---|---|
| 0 µL/CU | 0.003066 SOL | 0.003066 SOL |
| 100 µL/CU | 0.033 SOL (3.3% of the withdrawal) | 0.003066 SOL |
| 1 000 µL/CU | **0.303 SOL (30%)** | 0.003067 SOL |
| 10 000 µL/CU | **3.003 SOL → withdrawal impossible** | 0.003069 SOL |

The user locks this number into the proof, and `api.js:175-177` sets
`feeTaken = computeRelayerFeeMax(...)` — the relayer **always claims its own maximum**, so the
overcharge is actually taken. Above ~3 300 µL/CU the quote exceeds
`denomination − treasury_fee`, `checked_sub` underflows and every withdrawal reverts with
`ArithmeticOverflow`: a network-wide outage triggered by ordinary congestion.

Two aggravating factors: the transaction never attaches `setComputeUnitPrice`
(`relayer/src/tx.js:171-176`), so the relayer charges for a priority fee it does not pay; and the
on-chain program imposes **no cap** on `relayer_fee_max`, so nothing bounds this.

**Fix.** `const priorityFee = Math.ceil(priorityFeePerCU * COMPUTE_UNITS / 1e6);`; attach a
matching `ComputeBudgetProgram.setComputeUnitPrice`; charge measured cost rather than the ceiling;
and add an on-chain guard such as `require!(args.relayer_fee_max <= pool_denomination / 50)`
plus `require!(user_amount > 0)`.

### H-4 — The confirmation screen shows a fabricated relayer fee

**File:** `app/src/pages/Withdraw.tsx:351-354`

```tsx
<span>Relayer fee (estimated)</span>
<span>~0.000005 SOL</span>   {/* hardcoded string */}
```

The real quote is fetched at `:96` — *after* the user has already pressed **Withdraw** — and is
committed into the proof at `:113` without ever being displayed. Nothing in the app calls
`computeMinUserReceives`, and `estimatedUserReceives` from the relayer is parsed but never shown
**[verified by grep]**. So the user consents to `0.000005 SOL` and can be charged 30%+ (H-3), or
arbitrarily more by a hostile relayer, with no on-chain ceiling to save them.

**Fix.** Fetch the quote before rendering the confirm step; display `relayerFeeMax` and the
locally recomputed guaranteed minimum received; block the flow if
`relayerFeeMax > userMaxFee` (a user-visible setting with a sane default such as 1% of
denomination); show the fee actually taken on the success screen (that part already exists at
`:473`).

### H-5 — Merkle tree rebuilt from RPC history, unverified and unscalable → notes become unprovable

**File:** `app/src/utils/merkle.ts:40-103`

The withdrawal path reconstructs the entire tree client-side by paginating
`getSignaturesForAddress` over the pool and calling `getTransaction` **once per signature,
sequentially**, then parsing `DepositEvent` logs. Problems, in order of severity:

- **The rebuilt root is never checked against `pool.root_history[current_root_index]`
  [verified by grep].** Any missed or pruned transaction yields a tree that silently disagrees
  with the chain: either the leaf index is wrong (→ `InvalidProof`) or the root is unknown
  (→ `RootNotFound`), with error copy that blames "out of sync, try again" and never converges.
- Public RPC endpoints prune transaction history and rate-limit aggressively. Once a deposit's
  transaction is no longer retrievable, that note is **permanently unprovable** — directly
  breaking the protocol's core promise ("Users can always recover their funds").
- O(n) sequential round-trips: a few hundred deposits already means minutes and near-certain
  429s; at the advertised 950 000-deposit capacity this is impossible.

**Fix.** Ship an indexer (or a signed, verifiable leaf snapshot) as the primary source; verify
`tree.root` against the on-chain root history *before* proving and fail loudly with an actionable
message; batch/parallelise fetches with `getSignaturesForAddress` + `getParsedTransactions` and
cache leaves in IndexedDB keyed by pool and leaf index. Consider emitting leaves in a compact
append-only on-chain account so the tree can be rebuilt from account state instead of logs.

### H-6 — The relayer and the app together defeat the privacy the protocol exists to provide

**Files:** `app/src/config.ts:5`, `relayer/src/api.js:25-33`, `:220-224`

The browser calls the relayer directly, so the relayer observes
`(source IP, nullifierHash, recipient, timestamp)` for every withdrawal and logs errors including
program logs. The same browser session, on the same RPC endpoint, performed the deposit with a
connected wallet. A relayer — or the RPC provider — correlates deposit and withdrawal by IP and
timing with no cryptography at all. Additional exposure: `RELAYER_URL` is plaintext
`http://localhost:3000`, `Access-Control-Allow-Origin: *`, and there is no Tor/onion or
proxy guidance anywhere in the app or README.

Meanwhile `Deposit.tsx:335` tells the user *"Your SOL is now in the privacy pool. **Nobody** can
link it to you"* and `Withdraw.tsx:334` *"A relayer will submit this transaction for you so nobody
can identify you."* Both are false against the relayer and the RPC provider.

**Fix.** HTTPS-only relayer endpoints plus a published onion address; explicit UI copy naming the
relayer and RPC provider as parties that see the request; warn when a deposit and a withdrawal
happen in the same browser session or against the same RPC; recommend a delay and a different
network path; strip recipient/nullifier from relayer logs by default and document the retention
policy.

---

## 4. Medium

**M-1 — Anonymity sets are fragmented by design and currently tiny.** Pool PDA seeds include
`admin` (`lib.rs:51-58`), so every deployer creates a disjoint pool per denomination; the app
hard-codes three pools from one admin. Anonymity is bounded by *that* pool's deposit count, which
the UI never surfaces (it shows `nextIndex / 950,000` as a capacity bar, not as a privacy
indicator). With single-digit deposits, timing analysis alone links deposits to withdrawals.
→ Publish a canonical pool registry, display the effective anonymity set, and warn below a
threshold.

**M-2 — The advertised fee invariant is a tautology.** `withdraw.rs:228-231` asserts
`treasury_fee + relayer_fee_taken + user_amount == denomination` immediately after computing
`user_amount` as that exact difference; it can never fire. The README presents it as a core
protection. The checks that would actually matter — `user_amount > 0`, a cap on
`relayer_fee_max`, vault-balance conservation — are absent.

**M-3 — "Pause never blocks withdrawals" is untested, and dead error handling suggests
confusion.** `withdraw` correctly ignores `is_paused`, but no test asserts it, while
`relayer/src/api.js:245` and `Withdraw.tsx:190` both map a `PoolPaused` error that the withdraw
path can never return.

**M-4 — The relayer submits transactions it could have rejected, and its fee behaviour
contradicts the README.** It never checks that `publicSignals[2]` equals
`Poseidon(relayer, feeMax, recipient)`, nor that the root is in the pool's history — so any
client can burn the relayer's SOL on doomed transactions within the rate limit. And the README's
"relayers that always claim the maximum are ranked lower … the SDK publishes each relayer's
historical `fee_taken / fee_max` ratio" describes code that does not exist anywhere in the repo,
while the reference relayer always claims the maximum.

**M-5 — Rate limiting is IP-based with no proxy configuration.** `express-rate-limit` with
default `req.ip` and no `app.set('trust proxy', …)`: behind any reverse proxy or CDN every user
shares one bucket, making the 5 submissions/minute limit a trivial global DoS; deployed directly,
IP rotation defeats it. → Configure `trust proxy` explicitly and key the submit limiter on the
nullifier as well as the IP.

**M-6 — Wrong rent constant, and nullifier rent is never reclaimable.**
`relayer/src/fees.js:9` uses `2_039_280` (the rent for a 165-byte SPL token account); the actual
minimum for the 80-byte nullifier account is `(128 + 80) × 3480 × 2 = 1_447_680` **[verified]** —
a 41% overcharge on that component. There is also no instruction to close spent nullifier
accounts, so every withdrawal permanently locks ~0.0014 SOL. At scale this is the protocol's
largest cost sink. → Fix the constant; add a `close_nullifier` instruction gated on age
(the `slot` field is already stored, `state.rs:66`) that refunds the closer.

**M-7 — `circuits/build/` is gitignored while the setup script instructs you to commit it.**
`.gitignore:15` excludes the directory that `trusted_setup.sh:186-193` says to `git add`. Net
effect on a fresh clone: `relayer/src/verify.js:12` cannot find `withdraw_vk.json` and the relayer
crashes on first use; no ceremony transcript exists to audit. The proving key survives only by
accident, because `app/public/circuits/withdraw_final.zkey` happens to be tracked. → Commit
`withdraw_vk.json`, `withdraw.r1cs` and the ceremony transcript (with LFS if needed); have the
relayer resolve the VK via an env var with a pinned SHA-256 checked against `vk.rs`.

**M-8 — Devnet configuration is hardcoded into the shipped app.** `app/src/config.ts` pins
devnet, `http://localhost:3000`, three pool addresses; explorer links hardcode
`?cluster=devnet`. Mixed-content policy will block the HTTP relayer from any HTTPS deployment.
→ Move to `import.meta.env` with per-network config and fail closed on mismatch.

**M-9 — The deposit circuit is decorative and its stated protection does not exist.**
`deposit.circom:14-17` claims *"The Anchor program verifies denomination == pool.denomination
before inserting"*. The on-chain `deposit` handler (`deposit.rs:10-56`) verifies no proof at all
and accepts any 32-byte commitment. The `denomination` field inside the commitment is therefore
only extra entropy, and BF-12's binding is unenforced. Not exploitable (a withdrawal still
requires a Merkle-included leaf you created), but it is a false security claim, and it means a
second trusted setup (`deposit_final.zkey`) exists for nothing. → Delete the deposit circuit and
its ceremony, or actually verify it on-chain.

**M-10 — Stealth addresses are advertised but unusable.** `sdk/src/stealth.ts` is correct in
isolation (the clamped ed25519 scalar even neutralises small-subgroup ephemeral keys), but there
is no announcement channel: the ephemeral pubkey is never written on-chain, never included in the
note format, and the module is not imported anywhere in `app/`. The README describes it as a
shipped feature. → Either wire it in (an announcement account or an event carrying `eph_pub`,
plus a scan flow) or move it to `experimental/` and adjust the README.

---

## 5. Low / hygiene

- **L-1** `randomFieldElement` (`sdk/src/note.ts:29-34`) uses `randomBytes(32) % Fr` — modulo bias
  over-weights the low ~5.5% of the range by 20%. Harmless in practice, wrong for the protocol's
  most sensitive value. Use rejection sampling.
- **L-2** Note secrecy depends on `vite-plugin-node-polyfills` shimming
  `crypto.randomBytes` in the browser. It resolves to a CSPRNG today, but this is a bundler
  configuration standing between the user and their funds. Call
  `globalThis.crypto.getRandomValues` directly with a Node fallback.
- **L-3** Duplicate commitments are accepted on deposit; the second is unspendable
  (one nullifier, one withdrawal). `MerkleTree.findLeaf` uses `indexOf`, returning the first
  match. Cheap 1:1 griefing and a plausible user footgun. Reject `commitment` already present, or
  at minimum warn.
- **L-4** `WithdrawArgs.nullifier_bump` (`withdraw.rs:33`) is dead since the canonical-bump fix
  but still occupies the wire format.
- **L-5** The empty-tree root stays in `root_history[0]` and is byte-identical across every pool
  of depth 20. Safe only because a Poseidon preimage of `0` is infeasible. Exclude it.
- **L-6** `POOL_SIZE` is 8 968 in code, documented as 8 964 in `CLAUDE.md` (BF-39).
- **L-7** `benchmark_groth16` / `benchmark_poseidon` are exposed unconditionally
  (`lib.rs:148-155`) despite the `benchmark` feature existing. Gate them with
  `#[cfg(feature = "benchmark")]` or delete (TASKS.md T13 says to).
- **L-8** Nothing warns the user against withdrawing to the wallet currently connected in the
  same tab, which destroys privacy in one click.
- **L-9** `NetworkGuard` calls `phantom.solana.request({ method: 'disconnect' })` on every
  connect and then shows the warning banner unconditionally — hostile and useless.
- **L-10** README drift beyond C-3: "fee invariant" (M-2), relayer reputation ranking (M-4),
  stealth addresses (M-10), and `trusted_setup.sh`'s "~25k constraints" vs the real 12 065.

---

## 6. Remediation order

1. **C-1** — canonical-input checks. Small, self-contained, no ceremony impact. Do this first.
2. **C-3** — finalise or timelock the upgrade authority; split admin/treasury/upgrade keys;
   correct the README.
3. **H-1** — `create_account` fallback for the nullifier PDA.
4. **H-3 / H-4** — fee unit fix, on-chain fee cap, honest fee UI. Cheap, high user impact.
5. **H-2** — recipient binding redesign (circuit change) — bundle with:
6. **C-2** — new multi-party ceremony, published transcript, drop the deposit circuit (M-9).
7. **H-5** — indexer + root verification before proving.
8. **H-6 / M-1** — privacy threat model: honest copy, HTTPS/onion, anonymity-set display.
9. Everything else, plus regression tests for each finding above.

**Test gaps to close alongside the fixes:** no test submits a non-canonical public input (C-1);
none pre-funds a nullifier PDA (H-1); none substitutes an aliased recipient (H-2); none asserts
withdrawals succeed while the pool is paused (M-3); no fuzzing of `reduce_mod_fr` or the pool
layout offsets hardcoded at `withdraw.rs:44` and `:141-152`, which will break silently if the
`Pool` struct ever changes.

---

*Review performed 2026-08-13. Findings marked **[verified]** were reproduced experimentally
(dependency source inspection, numeric reproduction, or live devnet RPC queries); the remainder
follow from direct code reading.*
