# SolnadoCash

Privacy protocol for Solana. Deposit SOL into a shared pool, withdraw to any address — no on-chain link between sender and recipient.

Built on Groth16 zero-knowledge proofs (BN254), Poseidon hashing, and stealth addresses. Inspired by Tornado Cash, rebuilt from scratch for Solana's architecture.

> **Rebrand in progress.** The front end now ships as **SornadoCash** (sornado.cash); the on-chain
> program, the Rust crate, the npm packages and this repository are still named SolnadoCash. Renaming
> those touches a deployed program ID and published package names, so it is a deliberate separate
> step. The note format prefix stays `sndo_` under either name, so existing notes remain valid.

---

## How It Works

1. **Deposit** - User picks a denomination (0.1, 1, 10 or 100 SOL) and deposits exactly that amount into the matching pool, receiving a secret note
2. **Wait** — The deposit sits in a pool alongside all other deposits of the same denomination
3. **Withdraw** — User (or a relayer on their behalf) submits a ZK proof that they know a valid note, without revealing *which* deposit it corresponds to
4. **Receive** — Funds arrive at any destination address with zero on-chain link to the original depositor

The ZK proof guarantees: *"I deposited into this pool"* without revealing *"I am deposit #X"*.

```
Deposit:   Alice (public) → Pool ──── on-chain, visible
                                 ↕
                          ZK proof barrier
                                 ↕
Withdraw:  Pool → Bob (public)  ──── on-chain, visible

Link between Alice and Bob: none.
```

## Security Model

### Zero-Knowledge Circuits

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Proof system | Groth16 | Compact proofs (192 bytes), fast on-chain verification via Solana's native BN254 syscall |
| Curve | BN254 | Native Solana support, optimal proof size |
| Hash function | Poseidon | ~100x fewer constraints than SHA-256 inside ZK circuits |
| Merkle tree depth | 20 | Supports up to 1,048,576 deposits per pool |
| Nullifier / secret | 254-bit BN254 field elements | Collision resistance ~2^127, brute-force resistance ~2^254 |

The withdraw circuit enforces exactly **3 public inputs** in fixed order: `[nullifierHash, root, withdrawalCommitment]`. The recipient address is a **private input**, bound inside `withdrawalCommitment = Poseidon(relayer, relayerFeeMax, recipient)`. This means the recipient is never revealed in the proof itself — only the commitment to the recipient is public.

### On-Chain Protections

**Double-spend prevention** — Each withdrawal creates a nullifier PDA on-chain. Seeds include the pool key for cross-pool isolation:
```
seeds = ["nullifier", pool_key, nullifier_hash]
```
A second withdrawal with the same nullifier is rejected at the Solana runtime level (account already exists).

**Root history** — The contract stores the last 256 Merkle roots. Proofs are validated against any recent root, preventing race conditions between concurrent deposits and withdrawals. Stale roots beyond the history window are rejected.

**Fee conservation** — Every withdrawal verifies the ledger after moving lamports: the vault must be debited exactly one denomination, and the treasury, relayer and recipient must each be credited exactly their share. The vault may not also be the recipient, treasury or relayer, since duplicate accounts share a lamport cell and would net funds back into the vault.

**Relayer fee cap** — `relayer_fee_max <= denomination / 50` (2%) is enforced on-chain, and `user_amount > 0` is required. The user always keeps at least 97.8%.

**Canonical public inputs** — All three ZK public inputs must be canonical BN254 field elements (`< Fr`). BN254 scalar multiplication reduces mod the group order and the syscall does not range-check the scalar, so `x` and `x + k*Fr` verify identically; because `nullifier_hash` is also a PDA seed, accepting a non-canonical value would allow the same note to be withdrawn 5-6 times.

**Payout targets cannot alias the nullifier PDA** — no recipient, treasury or relayer may be
the nullifier account the instruction is about to create. Crediting it burns the funds: the
account ends up program-owned and no instruction can move lamports out of it, by design,
because that account *is* the double-spend guard. The case reachable by a third party was a
pool created with `treasury` set to the PDA a chosen nullifier hash will later occupy — it is
system-owned and empty at creation, so the `SystemAccount` constraint accepts it — which would
burn the protocol fee on every withdrawal of that note.

**Denomination floor** — `initialize_pool` rejects any denomination whose worst-case payout
(`denomination - denomination/500 - denomination/50`) falls below `Rent::minimum_balance(0)`,
read from the live rent sysvar. Privacy requires withdrawing to a *fresh* address, and the
runtime refuses to leave a new account below rent-exemption, so a pool under roughly 910,900
lamports would accept deposits and then be unable to pay them out. Measured boundary: 890,879
lamports rejected, 890,880 accepted.

**Pool isolation** — Pool PDA seeds include the admin key and a version byte, preventing treasury hijacking and ensuring V1/V2 pools have distinct addresses:
```
seeds = ["pool", admin, mint, denomination, version]
```

**Saturation protection** — Pools hard-reject deposits at 950,000 entries (on-chain, not frontend-only). A `PoolNearSaturation` event fires at 949,000 to trigger V2 pool deployment.

**Admin pause** — The `is_paused` flag blocks new deposits but **never blocks withdrawals**. Users can always recover their funds.

### Bare-Metal Withdraw

The `withdraw` instruction is written in raw Rust — no Anchor macros, no `#[derive(Accounts)]`, no `ctx.accounts`. This saves ~30-50k compute units on the critical path and keeps the full withdrawal (Groth16 verify + Poseidon commitment check + nullifier creation + fee split + lamport transfers) under 100k CU — well within Solana's 1.4M CU limit.

SOL transfers use **direct lamport mutation**, not `system_program::transfer` (which fails for PDA-owned accounts):
```rust
**vault.try_borrow_mut_lamports()? -= denomination;
**recipient.try_borrow_mut_lamports()? += user_amount;
**treasury.try_borrow_mut_lamports()? += treasury_fee;
**relayer.try_borrow_mut_lamports()? += relayer_fee;
```

Reading the pool by byte offset instead of through `AccountLoader` is where most of the saving comes
from, and it moves a guarantee from the compiler to the author. The offsets are used in about two
dozen places — the withdraw path itself, plus the monitor, relayer, SDK, front end, scripts and every
fuzz harness — and for a while nothing checked any of them. Adding one field to `Pool` would have
compiled cleanly, silently repointed every reader, and failed no test, because the tests hardcoded
the same numbers. Most misreads fail closed; `denomination` does not, and a wrong denomination
debits the vault by less than one denomination while satisfying a conservation check that was handed
the same wrong value.

So the offsets now live in one place and are asserted against the real struct at compile time:

```rust
const _: () = {
    assert!(core::mem::size_of::<Pool>() == POOL_SIZE);
    assert!(core::mem::offset_of!(Pool, denomination) == OFF_DENOMINATION);
    // …every field, plus align_of and the hand-copied Anchor discriminator
};
```

Moving a field now fails `anchor build` rather than producing a program that reads the wrong eight
bytes as a denomination. The off-chain decoders are checked against the same source by
`npm run check:layout`, which parses those constants and verifies every named offset in the
JavaScript, TypeScript and test code agrees with them — the monitor reading `deposits` from a stale
offset is the case that matters, since a layout change would otherwise blind the watchdog at exactly
the moment there was something to see.

The accounts are passed to the raw path as a named struct rather than a positional array for the
same reason: the indices used to be aligned with the shim's field order by nothing but a comment on
both sides.

### Error logs

On-chain errors report the code and number but not a source location:

```
Program log: AnchorError occurred. Error Code: NullifierAlreadySpent. Error Number: 6004.
```

Anchor's `require!` normally attaches the filename and line, which anyone can read from a
transaction simulation. A `guard!` macro replaces every `require!` and the `strip-error-origins`
feature, which is **on by default**, removes the origin. It is in `default` rather than opt-in
deliberately: if it were opt-in, one forgotten flag on a future `anchor build && solana program
deploy` would silently put the paths back and nothing would warn you. The stripped binary is also
about 4,700 bytes smaller.

The error *number* is in the transaction result either way, so this hides nothing an attacker could
not derive from public source. To get file and line back while debugging:

```bash
cargo build-sbf -- --no-default-features
```

### Events

`deposit` emits `DepositEvent { leaf, leaf_index, timestamp }`, which the client needs to rebuild
the Merkle tree.

`withdraw` emits `WithdrawalEvent { nullifier_hash, relayer, relayer_fee, treasury_fee }`. It
deliberately does **not** include the recipient. That address is already in the transaction's
account list, so omitting it discloses nothing new in a strict sense, but there is a real difference
between "derivable by parsing every transaction" and "handed over pre-parsed in an event stream",
and bulk deposit/withdrawal correlation is exactly what this protocol exists to prevent.

### Measured Performance

| Instruction | Compute Units | Notes |
|-------------|---------------|-------|
| `initialize_pool` | ~17,000 to 20,000 | Pool + vault PDA creation, incl. the rent-derived denomination floor |
| `deposit` | ~26,000 to 32,000 | Canonical-field check + 20-level Poseidon Merkle insert + SOL transfer |
| `withdraw` | ~102,000 to 108,000 | Canonical-input guards + Groth16 verify + commitment check + nullifier PDA + fee split + conservation and distinctness checks |
| `pause_pool` | 1,336 | Stable across every run |
| **Budget** | **150,000** | What to set, against Solana's 1.4M limit |

These are ranges rather than figures, and the reason is worth stating because an earlier version of
this table published single numbers to the lamport. Three consecutive runs of the *identical*
binary, on a fresh local validator each time, gave `withdraw` 101,908 then 104,908 then 107,908,
while `pause_pool` stayed at exactly 1,336 in all three. So the spread is not the code changing.
`tests/withdraw.ts` measures by simulating a transaction that contains a `ComputeBudget`
instruction plus the instruction under test and reading `unitsConsumed` for the whole transaction,
so the number includes per-transaction overhead; whatever varies affects the larger instructions and
leaves the trivial one alone. Until that is isolated, treat these as indicative of headroom and not
as a regression signal: a 2,000 CU change here is noise, and the honest conclusion is that
withdrawal fits comfortably in a single transaction with roughly an order of magnitude to spare.

`withdraw` additionally varies with where the proof's root sits in the 256-entry ring, because the
history scan returns on match. A root near the end of the buffer costs about 2,000 CU more than one
near the start, and the worst case is a full 256-entry scan.

## Decentralization

### Open Relayer Network

Anyone can run a relayer. The relayer's role is to submit the withdrawal transaction on behalf of the user, breaking the gas-payer link. Without a relayer, the user's withdrawal wallet would need SOL for gas — potentially linking it to their identity.

**How relayer fees work:**
- The relayer computes its real cost: `base_fee + priority_fee + nullifier_rent`
- Applies a 50% margin: `relayer_fee_max = cost * 1.5`
- The user locks `relayer_fee_max` into their ZK proof before submission
- On-chain enforcement: `fee_taken <= relayer_fee_max` (the relayer cannot take more than agreed)

**Fee limits as defense:** The protocol cannot verify actual gas costs on-chain (Solana has no gas oracle), so it bounds them instead:

- **On-chain cap** — `relayer_fee_max <= denomination / 50` (2%) is enforced in `withdraw`. A withdrawal costs a relayer ~0.0031 SOL at rest, so this leaves ample room for congestion while making a confiscatory fee unrepresentable. The user always keeps at least 97.8%.
- **Client-side validation** — the SDK's `validateFeeQuote` recomputes every figure locally from the denomination, rejects quotes above the cap before a proof is generated, and rejects a relayer whose advertised "you receive" figure contradicts its own fee ceiling.
- **Explicit consent** — the withdraw UI shows the maximum fee and the guaranteed minimum received *before* the ceiling is bound into the proof.
- **Honest reference relayer** — it charges its measured cost (base fee + priority fee + nullifier rent), not the ceiling, and attaches the priority fee it bills for.
- **Congestion cannot bleed the relayer** — the ceiling is frozen into the proof at quote time, but
  the transaction lands 30 to 90 seconds later, after proof generation. If congestion rises in
  between, the relayer caps the priority fee it attaches at what the ceiling reimburses, so it
  degrades to slower inclusion rather than paying the difference out of pocket. Charging the ceiling
  while attaching the full estimate was an unbounded loss and therefore an economic denial of
  service: an insolvent relayer forces users to self-relay, which destroys their privacy.

> **Not implemented:** there is no relayer reputation or ranking system. An earlier version of this document claimed the SDK published each relayer's historical `fee_taken / fee_max` ratio and ranked relayers accordingly — no such code exists. Relayer choice is currently manual, and a relayer may claim up to the 2% cap. Treat relayer selection as trusted-but-bounded.

### Admin Powers — current state

What the pool admin **cannot** do, enforced by the program:

- Block withdrawals. `is_paused` gates deposits only; a withdrawal succeeds while paused (asserted by test, on a local validator and on devnet)
- Modify pool parameters after initialization
- Change the treasury address, which is fixed at pool creation
- Move vault funds through any instruction — only a valid ZK proof authorizes a transfer

> **The program is currently upgradeable, and that overrides everything above.** The
> BPF upgrade authority is live and is the same key as the pool admin and the treasury.
> Whoever holds it can deploy new code that drains every vault, because the vaults are
> program-owned PDAs. Verify for yourself:
> `solana program show DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59 --url devnet`
>
> This is deliberate while the protocol is pre-launch and under active repair. It must
> be resolved before mainnet by setting the authority to `--final` or transferring it to
> a timelocked multisig, and by splitting the admin, treasury and upgrade roles onto
> distinct keys. Until then, this protocol is custodial in practice. Treat any claim of
> trustlessness as false while that key exists.

### Censorship Resistance

The protocol is designed so that no single party can prevent a valid withdrawal:
- **Validators** see the proof and public signals, but cannot determine which deposit is being withdrawn
- **Relayers** are interchangeable — if one refuses, any other can submit the same proof
- **The admin** cannot block withdrawals even with the pause flag
- **The contract** is *not* yet immutable — the upgrade authority is still live (see Admin Powers above). Immutability is a launch requirement, not a current property.

## Protocol Fee

A fixed 0.2% treasury fee on every withdrawal:
```
treasury_fee = denomination / 500
```
Integer division only. Applied to the raw denomination, never to `denomination - relayer_fee`. No overflow possible for any valid u64.

For a 1 SOL pool:
| Recipient | Amount |
|-----------|--------|
| Treasury | 0.002 SOL |
| Relayer | ~0.003 SOL (dynamic) |
| User receives | ~0.995 SOL |

## Denominations

Four fixed rungs: **0.1, 1, 10 and 100 SOL** — powers of ten, which is the ladder Tornado Cash
shipped for ETH and the only one with real usage data behind it. Deposits must equal a rung exactly — arbitrary amounts
are what make a mixer trivially de-anonymisable, since an unusual amount identifies itself on the
way out.

The ladder is deliberately narrow, and that is the opposite of a feature gap.

**Every rung is a separate anonymity set, and sets never merge.** Each rung added divides the
same liquidity further. A rung only begins to hide anyone once it holds roughly 50 deposits, so
the number of useful rungs is bounded by volume, at about `total deposits / 50`. Thirteen rungs,
which was briefly deployed and withdrawn, would mean thirteen sets of nearly nothing.

**A wide ladder also makes users more identifiable, not less.** Moving 437 SOL across rungs of
250+100+50+20+10+5+2 produces a distinctive multiset of denominations, and that combination is
itself a fingerprint linking the deposits to the withdrawals. On a coarse ladder the same amount
is 43x10 + 7x1, and repeats of a common rung look like what everyone else is doing. Fine
granularity converts an amount into a signature. Tornado Cash shipped four ETH rungs and never
added intermediate ones.

**Never advertise a rung that cannot be filled.** An empty pool is worse than a missing one,
because someone will use it and believe they are private.

Splitting is cheap, so a coarse ladder costs little: the 0.2% protocol fee is proportional and
therefore unaffected by splitting, and the relayer's flat cost of roughly 0.003 SOL per
withdrawal comes to about 0.3% when moving 7 SOL as seven 1 SOL withdrawals. The real cost of
coarseness is operational — many sequential withdrawals take time and create timing correlation
— which is the actual argument for adding a larger rung once volume exists.

Planned growth, in order, each gated on the neighbouring rungs being deep:

| Next | Trigger |
|------|---------|
| 0.3 / 3 / 30 SOL | each neighbour passes ~100 deposits (3 is the geometric mid-decade, so it halves worst-case splitting for the fewest new sets) |
| 1000 SOL | only with sustained demand at 100 SOL. At roughly $76k a deposit, that rung will not fill, and an advertised rung that cannot fill is worse than an absent one |

Devnet also carries 0.5, 2, 3, 5, 20, 50, 250, 500 and 1000 SOL pools from an earlier
wide-ladder deployment. They are intentionally unadvertised. There is no close instruction, by
design, so an unwanted pool can only be abandoned, never removed — which is why the ladder width
must be settled before mainnet.

### A note on the relayer fee cap

The on-chain cap is proportional (`denomination / 50`) while a relayer's real cost is roughly
0.003 SOL at any size, so the cap does not fit a wide range of denominations:

| Rung | 2% cap | Real cost | Cap ÷ cost |
|------|--------|-----------|------------|
| 0.1 SOL | 0.002 | 0.0014527 | 1.38x |
| 1 SOL | 0.02 | 0.0014527 | 13.8x |
| 10 SOL | 0.2 | 0.0014527 | 137x |
| 100 SOL | 2 | 0.0014527 | 1,376x |

Real cost is `signature fee + nullifier rent` = 5,000 + 1,447,680 = 1,452,680 lamports, plus any
priority fee. It is dominated by rent, which is flat, so it does not scale with the denomination.
Confirmed against a live devnet withdrawal: the relayer took exactly 1,452,680 lamports and its net
balance change was 0.

Every rung currently clears cost, including 0.1 SOL. An earlier version of this table claimed the
0.1 SOL cap sat *below* cost, which was true against the pre-M-6 rent figure of 2,039,280 lamports
(the rent for a 165-byte SPL token account, not the 80-byte account this program creates). Fixing
the rent made that rung profitable and the claim was not updated. A relayer breaks even while
`denomination / 50 >= 5,000 + rent`, so the minimum viable denomination today is 0.0727 SOL, and
0.1 SOL tolerates about a 38% rent increase before it would need subsidising. On the 100 SOL rung
the cap permits a 2 SOL fee for work costing 0.0015, so it bounds almost nothing. The withdraw screen therefore warns on the
**absolute** fee rather than the percentage, because "2.00%" looks identical and harmless at every
denomination. A cap of the shape `max(floor, min(denomination/50, ceiling))` is still owed, since
relayer cost is denomination-independent and the cap mostly should not scale.

Run `node scripts/simulate_economics.js` to reproduce these figures. It drives the shipped fee code
across four denominations and six congestion regimes, and reports protocol solvency, operator P&L,
worst-case user payout, break-even volume and sensitivity to the rent parameter.

## Architecture

```
circuits/       Circom ZK circuits (Groth16, Poseidon, Merkle tree)
programs/       Anchor smart contract (Rust) — withdraw.rs is bare-metal
relayer/        Node.js relayer service (fee quoting, tx submission)
sdk/            TypeScript SDK (note generation, proof, stealth addresses, fees)
app/            React + Tailwind frontend
monitor/        On-chain watcher (integrity invariant, authority drift, alerting)
litesvm-tests/  Fast in-process on-chain tests (sequence fuzzer, invariants)
scripts/        Trusted setup, CU benchmarks, devnet verification, pool deployment
```

### Circuits (Circom)
- `withdraw.circom` — Proves knowledge of a valid deposit without revealing which one. 12,065 constraints.
- `deposit.circom` — Verifies commitment structure. 605 constraints. **Not used on-chain:**
  `deposit` verifies no proof and accepts any 32-byte commitment, exactly as Tornado Cash does,
  so this circuit is only an off-chain aid for checking that a commitment was formed correctly.
  It costs nothing, because spending a note still requires a Merkle proof for a leaf in *this*
  pool's tree, and inserting that leaf cost exactly one denomination.
- `merkle_proof.circom` — 20-level Poseidon Merkle inclusion proof.

### Smart Contract (Anchor + bare-metal Rust)
- `initialize_pool` — Creates a pool with fixed denomination, admin, treasury, version
- `deposit` — Inserts a Poseidon commitment into the on-chain Merkle tree
- `withdraw` — Bare-metal: verifies Groth16 proof, checks commitment, creates nullifier, splits fees, transfers SOL
- `pause_pool` / `unpause_pool` — Admin controls for deposits only

### Relayer (Node.js)
- `GET /fee_quote?pool=<address>` — Dynamic fee based on current network conditions
- `POST /submit_proof` — Validates proof off-chain, then submits atomic on-chain transaction
- `GET /health` — Balance monitoring, alerts below 5 SOL

### Monitoring (Node.js)

A standalone watcher, because detection is worth more here than privilege. Total outflow is
already capped at total deposits by the vault-balance guard, so loss is bounded whether or not
anyone is watching; the value of monitoring is learning about a problem *before* it is
exploited, so deposits can be paused and users told to exit.

The core check needs two account reads per pool. Since
`vault == rent + (deposits - withdrawals) * denomination`, the quantity
`rent + deposits*denom - vault` must be exactly divisible by the denomination, and the implied
withdrawal count must lie in `[0, deposits]`. Withdrawals never increment `next_index`, so
proofs accepted without matching deposits break one or both conditions. A vault below its rent
reserve means more has left than the deposits funded — the forged-proof signature.

Anyone can send lamports to a vault with a plain transfer, so a positive remainder is reported
as "investigate", not as a confirmed breach. A monitor that cries wolf gets muted.

Also watched: upgrade-authority drift (set `EXPECTED_UPGRADE_AUTHORITY` or a key takeover is
invisible), drift in immutable pool fields against a baseline recorded on first run, outflow
rate, saturation, relayer solvency, and pause transitions. Telegram alerting is optional;
`--once` exits non-zero on a CRITICAL for cron use, and a hardened systemd unit is included.

```bash
cd monitor && npm install --omit=dev
cp .env.example .env    # set POOLS and EXPECTED_UPGRADE_AUTHORITY
npm run once            # single pass; or `npm start` to poll
```

### SDK (TypeScript)
```typescript
import { generateNote, decodeNote } from "@solnadocash/sdk/note";
import { generateWithdrawProof, MerkleTree } from "@solnadocash/sdk/proof";
import { getFeeQuote, computeTreasuryFee } from "@solnadocash/sdk/fees";
import { generateStealthAddress } from "@solnadocash/sdk/stealth";

// 1. Generate a secret note
const note = generateNote(1_000_000_000n, poolAddress);
console.log(note.encoded); // "sndo_<pool>_<denom>_<nullifier><secret>"

// 2. Get fee quote from relayer
const quote = await getFeeQuote("https://your-relayer-url.com", poolAddress);

// 3. Generate ZK proof (off-chain, ~2s)
const { proof, publicSignals } = await generateWithdrawProof(
  note, quote, recipientAddress, merkleTree, circuitPaths
);

// 4. Submit to relayer
const res = await fetch(relayerUrl + "/submit_proof", {
  method: "POST",
  body: JSON.stringify({ proof, publicSignals, poolAddress, recipient })
});
```

## Stealth Addresses (experimental — not wired in)

The SDK ships an ECDH-on-Ed25519 stealth address implementation:

1. Sender generates an ephemeral keypair and computes a shared secret with the recipient's scan key
2. A stealth address is derived from `SHA-256(shared_secret || spend_pubkey)`
3. The recipient recovers the stealth keypair using their scan private key + the ephemeral public key

> **Not usable end to end yet.** There is no announcement channel for the ephemeral public key: it is not written on-chain, not carried in the note format, and `sdk/src/stealth.ts` is not imported anywhere in the app. A recipient therefore cannot discover the ephemeral key, so a stealth address generated today is unspendable unless the sender hands that key over out of band. Making it usable requires an `announce` instruction (emitting the ephemeral pubkey plus a view tag for cheap scanning) or embedding the key in the note.
>
> Note also that the module documents a deliberate limitation: there is no true scan/spend separation, because Ed25519's seed-based signing does not allow deriving a spendable Solana `Keypair` by scalar addition. The scan key alone can derive the stealth private key, so users are expected to set `scanKey = spendKey`. The unlinkability comes from the ephemeral key, not from key separation.
>
> Withdrawals do not need this: you can already withdraw to any fresh address you control.

## Development

### Prerequisites
- Solana CLI + Anchor framework
- Circom 2 + snarkjs
- Node.js 18+
- Rust 1.75+

### Build & Test
```bash
# Circuits
cd circuits && npm test

# Smart contract
anchor build
anchor test

# Relayer
cd relayer && npm test

# SDK
cd sdk && npm test

# Frontend (vitest + eslint)
cd app && npm test && npm run lint

# Monitor
cd monitor && npm test

# Pool layout: verify every off-chain byte offset against the on-chain struct
npm run check:layout

# Front-end attack suite (needs the hostile relayer running)
node app/security/hostile_relayer.mjs 3999 &
cd app && npm run test:security

# Economic simulation: protocol solvency, operator P&L, user payout, rent sensitivity
node scripts/simulate_economics.js

# Fast in-process on-chain tests, including the sequence fuzzer
cd litesvm-tests && cargo test --release

# Live devnet test (deposit + withdraw with real SOL)
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
node scripts/devnet_e2e.js
```

### Devnet

Program deployed at: [`DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59`](https://solscan.io/account/DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59?cluster=devnet)

## Status

| Phase | Status | Description |
|-------|--------|-------------|
| 1. ZK Circuits | Done | Circom circuits, trusted setup, constraint verification |
| 2. Anchor Program | Done | On-chain logic, CU benchmarks, devnet deployment |
| 3. Relayer | Done | Fee quoting, proof validation, atomic tx submission |
| 4. TypeScript SDK | Done | Note generation, proof, stealth addresses, fees, e2e tests |
| 5. React Frontend | Done | Deposit/withdraw UI, wallet adapter, durable note storage |
| 6. Monitoring | Done | Integrity invariant, authority drift, Telegram alerting |
| 7. Testnet + Launch | Planned | Public testnet, bug bounty, external audit, mainnet |

## Known Limitations

Read this before deciding to trust anything here with money.

**The trusted setup is single-party.** The Groth16 proving key came from a ceremony with one
human contribution and a beacon generated from local randomness — verifiable from the artifact
itself with `snarkjs zkey verify`, which lists `contribution #1` and an unattributable beacon.
Whoever held that toxic waste can forge withdrawal proofs and drain every pool. Nothing else in
this document matters more than this sentence. A multi-party ceremony is a prerequisite for
mainnet.

**The program is upgradeable and the keys are not separated.** See *Admin Powers* above: the
upgrade authority, the pool admin and the treasury are the same key today, and that key can
deploy code that moves every vault. Treat the protocol as custodial until it is `--final` or
behind a timelocked multisig.

**Loss is bounded, at least.** `withdraw` requires `vault.lamports() >= denomination`, so total
outflow can never exceed total deposits even if proof verification were broken outright — a
soundness failure drains a pool, not the chain. Proven in
`litesvm-tests/tests/outflow_cap.rs`, which also shows a fully drained vault retains only its
rent reserve.

**Merkle reconstruction does not scale.** Withdrawing rebuilds the tree from deposit logs, one
`getTransaction` per deposit, with no indexer. Known leaves are cached locally so a returning
user pays only for new deposits, and the rebuilt tree is verified against the on-chain root
before proving, so it fails loudly rather than producing an unprovable note — but a first-time
user with a cold cache still pays O(deposits), and public RPC endpoints rate-limit and prune
history. An indexer is required before a pool holds many thousands of deposits.

**Anonymity sets are small and split per denomination.** Sets never merge across rungs, so the
four-rung ladder is a deliberate attempt to concentrate what liquidity exists rather than a
missing feature. Even so, on a young deployment a rung may hold a handful of deposits, and a
withdrawal from a pool with one deposit is fully linkable regardless of the ZK proof. The
protocol cannot fix this, only depositors can. The UI does not display the per-pool deposit
count: at deposit time that number is close to meaningless, since what matters is how many
deposits exist when you eventually withdraw, and a prominent "0 deposits" discourages the first
depositors a pool needs before it can protect anyone. The tradeoff is that a user can no longer
see from the UI whether they are withdrawing into a set of three or three hundred; that figure is
on-chain and `scripts/check_pools.js` prints it. Instead the UI gives the advice that holds
regardless of the count and that a single user can act on: wait longer between depositing and
withdrawing. See *Denominations* above.

**Duplicate commitments are accepted on-chain.** Detection is client-side only. Preventing it
would need a per-commitment PDA, adding a rent-exempt account to every deposit forever, and
copying someone else's commitment only burns the copier's own SOL — they still lack the secret,
so only the original owner can withdraw, once. The cost is not proportionate to the harm.

**Root-ring griefing is possible.** 256 deposits rotate every earlier root out of the ring, so
a proof generated but not yet submitted fails closed. The note stays unspent and the app
rebuilds and reproves automatically, so this is a nuisance rather than a denial of service, but
it is not eliminated. Widening the ring would push the pool account past the 10,240-byte limit
for single-instruction creation.

**Stealth addresses are not usable end to end.** See the section above — there is no
announcement channel for the ephemeral key.

## Audit Status

**Not audited by an external firm.** No formal audit report exists. What exists instead is
several rounds of adversarial self-review, and their results are the reason to stay skeptical
rather than reassured:

| Round | Outcome |
|-------|---------|
| Manual review | 3 Critical, 6 High, 20 Medium/Low — all fixed except the two Criticals above |
| Adversarial second pass | 3 High, **two of them regressions introduced by the first round's own fixes** |
| Third pass | 1 real fix, plus accepted/informational findings |
| Front-end pass | 10 findings, including one that could permanently lose a deposit |
| Re-review | 2 findings, **both in code written hours earlier** |
| Focused circuit/Merkle review | No code bugs; one test-coverage hole that hid silent breakage |
| Live front-end pentest | 3 real findings: no CSP anywhere, third-party font requests leaking user IPs to Google, and 133 prod-dependency advisories from a wallet meta-package |
| **Live devnet use** | **3 real bugs after all of the above reported clean**, two of which made a core path completely unusable: a snake_case event field read as camelCase silently emptied the Merkle tree, withdrawals were impossible whenever the relayer was also the treasury, and congestion could drain the relayer without bound. Each was invisible to the suite because the harness diverged from production, not because the code was unreviewed. See SECURITY-REVIEW-PASS3.md. |

Every round found something new, including rounds that examined freshly written code, and
several fixes introduced fresh defects. The find rate has never reached zero, which is the best
available evidence that more bugs remain. Treat "no known bugs" as the claim being made here —
not "no bugs".

What the tests do and do not establish. Verified: 42 Rust unit and property tests (including a
differential test of the incremental Merkle insert against an independent recomputation, and a
cross-language root vector pinned against the SDK), 12 in-process on-chain tests including a
sequence fuzzer that has run 24,000+ steps against 7 invariants and 12 attack moves, 39/39
live devnet checks, 96 SDK, 52 relayer, 88 front-end and 25 monitor tests. `circomspect` reports no issues
above INFO on any circuit, and `snarkjs r1cs info` confirms the withdraw circuit's interface
exactly: 3 public inputs, 0 outputs, 46 private inputs.

Not established by any of that: the soundness of `groth16-solana`, Solana's Poseidon and BN254
syscalls, `snarkjs`, or `circomlib`. This code is verified to be *consistent with* those
dependencies, not to be safe if one of them is flawed — and a flaw there would leave every test
here green.

The front-end attack harnesses are committed and re-runnable: `app/security/hostile_relayer.mjs`
is a malicious relayer with 16 modes (fee escalation between quote and execution, fees above the
on-chain cap, lying about what the user receives, identity swaps, prototype pollution, non-JSON
bodies, success without a signature, XSS through the transaction signature, and hanging), and
`app/security/browser_attack.mjs` runs 12 attacks in headless Chromium including note
exfiltration by fetch and by image beacon, poisoned localStorage, and CSP integrity.

```bash
node app/security/hostile_relayer.mjs 3999          # hostile relayer
cd app && npx vitest run src/security               # drive real app code against it
VITE_RELAYER_URL=http://localhost:3999 npm run build && npx vite preview --port 4173
node security/browser_attack.mjs http://127.0.0.1:4173
```

If you are a security researcher, issues and responsible disclosures are welcome.


## Legal

SolnadoCash is autonomous, open-source protocol code. The lifting of OFAC sanctions against Tornado Cash (March 2025) established precedent that sanctioning open-source, autonomous smart contract code is not legally defensible. This protocol is designed for legitimate financial privacy — the same right that exists in traditional finance through banking secrecy laws.
