# SolnadoCash

Privacy protocol for Solana. Deposit SOL into a shared pool, withdraw to any address — no on-chain link between sender and recipient.

Built on Groth16 zero-knowledge proofs (BN254), Poseidon hashing, and stealth addresses. Inspired by Tornado Cash, rebuilt from scratch for Solana's architecture.

---

## How It Works

1. **Deposit** — User sends a fixed amount (1 SOL) into a shared pool and receives a secret note
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

**Fee invariant** — Every withdrawal enforces on-chain:
```
treasury_fee + relayer_fee_taken + user_amount == denomination
```
No lamports can be created or destroyed during withdrawal.

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

### Measured Performance

| Instruction | Compute Units | Notes |
|-------------|---------------|-------|
| `initialize_pool` | 16,289 | Pool + vault PDA creation |
| `deposit` | 25,955 | 20-level Poseidon Merkle insert + SOL transfer |
| `withdraw` | 99,713 | Groth16 verify + commitment check + nullifier PDA + fee split |
| **Safety margin** | **93% headroom** | Single-transaction withdrawal, no splitting needed |

## Decentralization

### Open Relayer Network

Anyone can run a relayer. The relayer's role is to submit the withdrawal transaction on behalf of the user, breaking the gas-payer link. Without a relayer, the user's withdrawal wallet would need SOL for gas — potentially linking it to their identity.

**How relayer fees work:**
- The relayer computes its real cost: `base_fee + priority_fee + nullifier_rent`
- Applies a 50% margin: `relayer_fee_max = cost * 1.5`
- The user locks `relayer_fee_max` into their ZK proof before submission
- On-chain enforcement: `fee_taken <= relayer_fee_max` (the relayer cannot take more than agreed)

**Fee transparency as defense:** The protocol cannot verify actual gas costs on-chain (Solana has no gas oracle). Instead, the SDK publishes each relayer's historical `fee_taken / fee_max` ratio from on-chain events. Relayers that always claim the maximum are ranked lower. Users can choose any relayer. Market competition keeps fees honest — the same model that worked for Tornado Cash's relayer network.

### No Admin Backdoors

- The admin can **pause deposits** but can **never block withdrawals**
- The admin cannot modify pool parameters after initialization
- The admin cannot access the vault — only ZK proofs can authorize withdrawals
- The treasury address is set at pool creation and cannot be changed
- All protocol logic is on-chain and verifiable

### Censorship Resistance

The protocol is designed so that no single party can prevent a valid withdrawal:
- **Validators** see the proof and public signals, but cannot determine which deposit is being withdrawn
- **Relayers** are interchangeable — if one refuses, any other can submit the same proof
- **The admin** cannot block withdrawals even with the pause flag
- **The contract** is immutable once deployed (standard Solana BPF program)

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

## Architecture

```
circuits/       Circom ZK circuits (Groth16, Poseidon, Merkle tree)
programs/       Anchor smart contract (Rust) — withdraw.rs is bare-metal
relayer/        Node.js relayer service (fee quoting, tx submission)
sdk/            TypeScript SDK (note generation, proof, stealth addresses, fees)
app/            React + Tailwind frontend (Phase 5)
scripts/        Trusted setup, CU benchmarks, devnet verification
```

### Circuits (Circom)
- `withdraw.circom` — Proves knowledge of a valid deposit without revealing which one. 12,065 constraints.
- `deposit.circom` — Verifies commitment structure. 605 constraints.
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

## Stealth Addresses

For unlinkable withdrawals, SolnadoCash uses ECDH on Ed25519:

1. Sender generates an ephemeral keypair and computes a shared secret with the recipient's scan key
2. A stealth address is derived from `SHA-256(shared_secret || spend_pubkey)`
3. The recipient recovers the stealth keypair using their scan private key + the published ephemeral public key

This means each withdrawal can go to a fresh, never-before-seen address that only the intended recipient can control.

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
| 5. React Frontend | Next | Deposit/withdraw UI with wallet adapter |
| 6. Testnet + Launch | Planned | Public testnet, bug bounty, mainnet |

## Audit Status

This protocol has **not been audited by an external firm**. The ZK circuits, smart contract, and SDK have been developed with systematic security review at every step, but no formal audit report exists. Use at your own risk on mainnet.

If you are a security researcher, issues and responsible disclosures are welcome.

## Legal

SolnadoCash is autonomous, open-source protocol code. The lifting of OFAC sanctions against Tornado Cash (March 2025) established precedent that sanctioning open-source, autonomous smart contract code is not legally defensible. This protocol is designed for legitimate financial privacy — the same right that exists in traditional finance through banking secrecy laws.
