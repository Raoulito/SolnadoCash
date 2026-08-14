# SolnadoCash — Third-Pass Audit (Solana + Applied ZK)

Target: commit `e8aef51` onward, program `DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59`.

**Deployed-code correspondence.** The devnet program was verified byte-identical to
`target/deploy/solnadocash.so` (`solana program dump` + `cmp`; the 3,912 trailing bytes of
the dump are zero padding). This audit covers what is actually running, not just what is
in the repository.

**Conflict of interest.** I performed passes 1 and 2 and implemented the fixes, so this is
not an independent review. Findings were re-derived from source; where an earlier
conclusion of mine was wrong, it is corrected in place and labelled.

---

## Open findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-1 | Critical | Single-party trusted setup permits unlimited proof forgery | Accepted risk (pre-mainnet) |
| F-2 | Critical | Upgrade authority == pool admin == treasury | Accepted risk (pre-mainnet) |
| F-3 | Low | Root-ring flush invalidates in-flight proofs | Documented, not fixed by design |
| F-4 | Informational | `pool` marked mutable in `withdraw` but never written | **FIXED** |
| F-5 | Informational | Treasury may be set to a future nullifier PDA | Documented (self-inflicted only) |

### F-1 — Single-party trusted setup (Critical, accepted)

`scripts/trusted_setup.sh:88-104`. Phase 1 correctly uses the public Hermez `pot17`. Phase 2
has one contributor and a "beacon" fed from `openssl rand -hex 32` on the same machine,
making it a second *secret* contribution.

**New evidence this pass.** `snarkjs zkey verify` was run against the real artifacts
(151 MB ptau present locally) and reports the ceremony contents directly:

```
contribution #1 SolnadoCash-Contributor1:
contribution #2 :
Beacon generator: 271d98c2e7bf7e2330d2b641b0239f3f307beb5eb6b4b556077f57d08d092168
Beacon iterations Exp: 10
ZKey Ok!
```

So the artifact itself confirms exactly one human contribution plus a beacon whose
generator is an unattributable local random value. A public beacon (a drand round, or a
pre-announced Bitcoin block hash) would be independently checkable by anyone; this is not.

Whoever holds that toxic waste can produce a valid proof for a false statement — a
nullifier and root with no corresponding deposit — which passes `verifier.verify()`
(`withdraw.rs:317`) and drains any pool. No on-chain hardening mitigates it.

**Remediation:** ≥5 independent contributors, published transcript with per-contribution
attestations, a verifiable public beacon, committed `withdraw.r1cs` so third parties can
run this same verification, and an R1CS soundness analysis (Ecne or equivalent) at the
same time — circuit soundness only becomes the binding constraint once this is fixed.

### F-2 — Upgrade authority == pool admin == treasury (Critical, accepted)

ProgramData `2JyVYf7Px1zAAKYkjrUg4ZnJyExThMCv2TCwXwNHS731`, authority
`4PLXgVX9MumeLLjcyvYFNoKq1dECdEneiFA8StLCnf1c` — the same key as pool admin and treasury.
Vaults are program-owned PDAs, so a replacement program can zero them with no user
signature. Compromise of that one key equals total loss.

**Remediation before mainnet:** `--final` or a timelocked multisig, and split the three
roles onto distinct keys. Note the constraint in D-9 below: the treasury cannot be a
program-owned multisig vault.

### F-3 — Root-ring flush griefing (Low) — FIXED (impact removed client-side)

`state.rs:7`, `withdraw.rs:279-284`. 256 deposits rotate every prior root out, invalidating
proofs generated but not yet submitted (`RootNotFound`). Capital is recoverable, so the cost
is fees plus temporarily locked funds. Not fixed: enlarging the ring costs account space
linearly and the failure is graceful (relayer preflight rejects a stale root before
spending; the SDK tells the user to regenerate). Tornado Cash has the same property with a
100-root window. **Monitor** for a deposit burst followed by withdrawals of those same
deposits.

### F-4 — `pool` mutable but never written (Informational, fixed)

`lib.rs:41`. The only mutable data borrow in `withdraw` is
`nullifier_info.try_borrow_mut_data()` (`:425`); the pool is read-only throughout. No
exploit — the vault is `mut` anyway so there is no parallelism gain — but it granted a
write capability the instruction never uses, so a later edit could mutate pool state
without that appearing in the account declaration. Now declared read-only. Callers may
still pass it writable; nothing breaks.

### F-5 — Treasury aliasing a future nullifier PDA (Informational) — FIXED

`lib.rs:91`, `withdraw.rs:442`. A pool creator can set `treasury` to the PDA a specific
nullifier hash will later occupy — it is system-owned and empty at creation, so
`SystemAccount` accepts it. On the withdrawal spending that note the account becomes
program-owned and is then credited `treasury_fee`; both `AccountInfo`s share one lamport
cell so the conservation check still holds, and the fee is locked forever. Self-inflicted
only (damages the creator's own fee stream, and the treasury is immutable after creation).
Recorded because the shape — *treasury aliasing an account the program itself creates* —
would matter if a future instruction credited other accounts.

---

## Verified defenses

Re-verified against source this pass.

**D-1 Public-input binding is complete against hijack.** `withdrawal_commitment =
Poseidon(relayer, fee_max, recipient)` is constrained in-circuit (C4) and recomputed
on-chain (`withdraw.rs:320-330`). Recipient, relayer and fee ceiling are all bound, so
neither a relayer nor an MEV bot can redirect funds or raise the fee. `fee_taken` is
deliberately unbound but doubly capped (`fee_taken <= fee_max`, `fee_max <= denomination/50`),
so the user retains ≥97.8%.

**D-2 Non-canonical scalar rejection.** `withdraw.rs:152-161` rejects any public input ≥ Fr
before any other work. Load-bearing: `groth16-solana` 0.0.3 range-checks nothing and
`alt_bn128_multiplication` uses `BigInteger256::deserialize_uncompressed_unchecked` +
`mul_bigint`, so `x` and `x + k·Fr` yield identical curve points. Because `nullifier_hash`
is also a PDA seed, its absence permitted 5–6 withdrawals per note. Pinned by 11 property
tests plus a checked-in proptest regression that shrank to exactly Fr.

**D-3 G1/G2 encoding and subgroup membership.** Enforced by the syscall:
`TryFrom<PodG1>`/`TryFrom<PodG2>` deserialise with `Validate::Yes` (arkworks checks on-curve
*and* prime-order subgroup) plus an explicit `is_on_curve()`. Groth16's inherent `(A·r, B/r)`
malleability is irrelevant — it preserves the statement and no proof-uniqueness assumption
exists here.

**D-4 Deposit-path field range is runtime-enforced.** `deposit` takes a raw `[u8;32]` with
no in-program range check. Source could not answer whether `sol_poseidon` reduces or
rejects, so it was tested against the real syscall under LiteSVM
(`litesvm-tests/tests/field_range.rs`): commitments equal to Fr, to 2²⁵⁶−1 and to `5 + Fr`
are all **rejected**, and a rejected deposit moves neither `next_index` nor vault lamports.
The guarantee is external, which is why it is now pinned by a test.

**D-5 Nullifier atomicity.** Checked empty at `:289`, created at `:360`, data written at
`:426`, lamports move only at `:441-444` — committed to state before any funds leave, so a
duplicate reverts even under partial failure. Only the canonical bump is accepted
(`find_program_address`, `:292`); the caller-supplied bump argument was removed entirely.

**D-6 Zero and empty-tree roots.** All-zero root rejected (`:166`); `EMPTY_TREE_ROOT`
rejected (`:279`) because it is byte-identical across every depth-20 pool. The constant is
pinned to the `ZEROS` table by a unit test so it cannot drift.

**D-7 Type cosplay.** The pool requires owner == program **and** the 8-byte discriminator
(`:212-218`) — ownership alone is insufficient since vaults and nullifier accounts are also
program-owned. Vault and nullifier are address-pinned by PDA re-derivation, strictly
stronger than a discriminator check.

**D-8 CPI targets.** The only CPI target anywhere is the System Program: asserted equal to
`system_program::ID` (`:225`) in `withdraw`, typed `Program<'info, System>` in `deposit`.
No user-supplied program is ever invoked.

**D-9 No account closure path.** Exactly 5 instructions and no `close`, so revival attacks
are structurally impossible. **Retraction:** pass 1 recommended adding `close_nullifier` to
reclaim rent — that was unsafe. The nullifier PDA *is* the double-spend guard and the leaf
stays in the tree permanently, so closing one would re-enable spending a spent note. Also
note `treasury: SystemAccount` means a program-owned multisig vault (e.g. Squads) cannot be
the treasury — verified empirically, it fails with `AccountNotSystemOwned` (3011).

**D-10 Arithmetic.** `overflow-checks = true` in release, so any slip panics rather than
wraps. `compute_fee_split` uses `checked_sub`. Every `as` cast is widening (`u8→u16`),
masked (`(sum & 0xff) as u8`) or bounded (`% 256 as usize`). `leaf_index = next_index - 1`
(`deposit.rs:42`) runs *after* the increment so it cannot underflow.

**D-11 Duplicate mutable accounts.** `withdraw.rs:346-348` rejects vault-as-recipient,
-treasury and -relayer; `:445-460` verifies each balance moved by exactly its share and the
vault was debited exactly one denomination — replacing an earlier check that was a
tautology.

**D-12 zkey ↔ circuit binding.** `snarkjs zkey verify build/withdraw.r1cs
build/pot17_final.ptau build/withdraw_final.zkey` → **`ZKey Ok!`**. The proving key
genuinely corresponds to the compiled circuit and the Hermez ptau. Combined with
`scripts/check_vk_consistency.js` (which regenerates `vk.rs` from `withdraw_vk.json` and
diffs), the chain circuit → r1cs → zkey → vk.json → `vk.rs` → on-chain verifier is now
verified end to end.

---

## Verification status

| Suite | Result |
|---|---|
| Rust unit + property (11 properties) | 34 passing |
| LiteSVM (syscalls, field range, sequence fuzz) | 8 passing |
| Local on-chain (validator) | 33 passing, 2 pending by design |
| SDK | 96 passing |
| Relayer | 40 passing |
| Devnet against deployed program | 38/38 |
| `clippy --all-targets --all-features -D warnings` | 0 errors |
| `cargo audit` | 0 vulnerabilities, 14 documented warnings |
| Sequence fuzzing (LiteSVM) | 24,623 steps, 12 attack moves, no violations |
| `snarkjs zkey verify` | ZKey Ok! |

## Not established locally

- **Circuit soundness beyond static analysis.** `circomspect` reports no under-constrained
  signals in all four circuits and all three public inputs are manually confirmed
  constrained. That is not a proof. Ecne / an R1CS solver was not run (Julia absent) and
  should run alongside the F-1 ceremony redo.
- **Anonymity as a property.** Sets are 0–20 deposits per pool; no measurement is needed to
  conclude that is inadequate. Pool PDAs include the admin key, so sets do not merge across
  deployers.
- **Any mainnet claim.** Everything here was verified locally or on devnet.


---

## Follow-up fixes (after the pass-3 report)

### F-5 — FIXED (`7a3479b`)
`withdraw` now rejects any payout target equal to the nullifier PDA
(`DuplicateAccount`, 6026). The treasury case was the only one a third party could set up:
the PDA is system-owned and empty at pool creation, so the `SystemAccount` constraint
accepts it, and every withdrawal of the chosen note would then burn the protocol fee into an
account no instruction can drain. Recipient and relayer are self-inflicted but cost one
comparison each to exclude.

`Pubkey::is_on_curve()` cannot be used to reject PDAs generically: it is `unimplemented!()`
under `target_os = "solana"` and panics on-chain (solana-program 1.18.26, `pubkey.rs:163`).

Proven in `litesvm-tests/tests/f5_treasury_alias.rs` against the real program binary, and on
devnet (`devnet_verify.js F-5`). The first devnet attempt returned 6007
(`InvalidWithdrawalCommitment`) rather than 6026, because the commitment check precedes the
distinctness check and the fixture committed to a different recipient — the guard was never
reached. Asserting exact error codes is what caught it.

### F-3 — FIXED at the impact level (`d8bcc76`)
The on-chain behaviour is unchanged and still correct: a rotated-out root fails closed and
the note stays unspent. What made the griefing worthwhile was the UI, which required every
affected user to notice an error and click retry. The app now rebuilds the tree and reproves
automatically (2 extra attempts), so one attacker action no longer blocks every in-flight
withdrawal — 256 deposits are needed per attempt rather than per attacker.

Widening `ROOT_HISTORY_SIZE` was rejected: the pool account is 8,976 bytes and 512 roots
would add 8,192, exceeding the 10,240-byte single-instruction creation limit.

### H-5 — scalability half addressed (`496dea7`), indexer still owed
Leaves are cached locally and append-only, so a repeat withdrawal fetches only deposits made
since the last visit. The cache is untrusted: the tree is still verified against the
on-chain root and leaf count, so a stale, gapped or tampered cache costs time, not
correctness. A cold cache still pays O(deposits) — an indexer remains the real fix.

### L-3 — deliberately NOT fixed on-chain
Rejecting duplicate commitments on-chain needs a per-commitment PDA, which would add a
rent-exempt account (~890,880 lamports) and an account slot to every deposit, permanently.
A duplicate is only reachable by reusing your own note or by copying someone else's
commitment, and copying it burns the copier's own SOL while granting nothing: the secret is
still unknown, so only the original owner can withdraw, once. The cost is not proportionate
to the harm; client-side detection stays.
