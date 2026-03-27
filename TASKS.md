# SolnadoCash — Task List

## Phase 1 — ZK Circuits

- [x] T01 — Write deposit.circom (signal interface per PROJET_enhanced.md Section 12.1)
- [x] T02 — Write withdraw.circom (signal interface per PROJET_enhanced.md Section 12.1)
- [x] T03 — Write merkle_proof.circom
- [x] T04 — Write lib/poseidon.circom (wrapper around circomlib)
- [x] T05 — Write circuits/test/circuits.test.js (include Bug fix 20 tampering test)
- [x] T06 — Compile all circuits: circom + snarkjs r1cs info (verify constraint counts)
- [x] T07 — Generate ZEROS array: run scripts/generate_zeros.js, paste into programs/src/zeros.rs
- [x] T08 — Run trusted setup: bash scripts/trusted_setup.sh (tag commit trusted-setup-v1)
- [x] T09 — Export and convert verifying key to Rust (programs/solnadocash/src/vk.rs)
- [x] T10 — Full constraint verification: snarkjs groth16 fullprove with valid + invalid inputs

## Phase 2 — Anchor Program

- [x] T11 — [FIRST] CU benchmark: write benchmark.rs, deploy to devnet, measure groth16_verify CU cost → **88,680 CU** (native BN254 syscall)
- [x] T12 — [FIRST] CU benchmark: measure 20-level Poseidon CU cost on devnet → **18,543 CU** (native sol_poseidon syscall, ~927 CU/hash)
- [x] T13 — [DECISION] Poseidon 18,543 CU << 800k → TREE_DEPTH stays 20. Combined worst-case ≈ 107k CU (well under 1.4M limit). Use native sol_poseidon in production.
- [x] T14 — Write programs/solnadocash/src/lib.rs (Anchor entrypoint, instruction routing)
- [x] T15 — Write initialize_pool instruction (Anchor, standard) — PDA seeds include admin + version (BF-10, BF-16)
- [x] T16 — Write deposit instruction (Anchor) — native sol_poseidon Merkle insert, is_paused check (BF-31), saturation event at 950k (BF-15)
- [x] T17 — Write withdraw.rs (BARE-METAL Rust) — direct lamport mutation, groth16 verify, commitment check, nullifier PDA
- [x] T18 — Write pause_pool / unpause_pool admin instructions
- [x] T19 — Write vault PDA creation in initialize_pool (Audit A)
- [x] T20 — Add Audit F fee invariant check: treasury_fee + relayer_fee + user_amount == denomination
- [x] T21 — Write anchor tests: non-admin init, double-spend, stale root, tree full, fee ceiling, saturation event
- [x] T22 — CU profiling: run anchor test with --profile, record all instruction costs in PROJET_enhanced.md
- [x] T23 — Deploy to devnet, verify with: solana account <pool_pda> (actual: 8,976 bytes = 8,968 struct + 8 discriminator)

## Phase 3 — Node.js Relayer

- [x] T24 — Write relayer/src/fees.js (dynamic fee per Section 12.6)
- [x] T25 — Write relayer/src/api.js (REST endpoints per Section 12.6 contract)
- [x] T26 — Write off-chain proof validation (snarkjs.groth16.verify before any on-chain tx)
- [x] T27 — Implement atomic ATA+withdraw transaction builder (BF-43)
- [x] T28 — Add rate limiting (express-rate-limit or similar)
- [x] T29 — Write relayer health monitoring + balance alert (alert if < 5 SOL)
- [x] T30 — Integration test: submit a real proof to devnet through relayer

## Phase 4 — TypeScript SDK

- [x] T31 — Write sdk/src/note.ts (generateNote, encodeNote, decodeNote per Section 12.5)
- [x] T32 — Write sdk/src/proof.ts (generateWithdrawProof — uses snarkjs + WASM from circuits build)
- [x] T33 — Write sdk/src/stealth.ts (generateStealthAddress)
- [x] T34 — Write sdk/src/fees.ts (getFeeQuote, computeTreasuryFee, computeMinUserReceives)
- [x] T35 — End-to-end SDK test: generateNote → deposit on devnet → generateProof → withdraw via relayer

## Phase 5 — React Frontend

- [x] T36 — Scaffold app/ with Vite + React + Tailwind + @solana/wallet-adapter
- [x] T37 — Write Onboarding.tsx (3 concrete transparency examples, per Section 5)
- [x] T38 — Write Deposit.tsx (3-click flow: connect wallet → choose pool → confirm → show secret note)
- [x] T39 — Write progress indicator component (named steps + countdown timer — Elusiv mistake #5)
- [x] T40 — Write Withdraw.tsx (3-click flow: paste note → enter recipient → confirm)
- [x] T41 — Integrate SDK into frontend — real proof generation with progress callback
- [x] T42 — Pool saturation routing: query next_index before deposit, auto-route to V2 if >= 950k (BF-11)
- [x] T43 — User testing: complete deposit + withdrawal on devnet without reading any documentation

## Phase 6 — Testnet + Launch

- [ ] T44 — Deploy to Solana testnet (pool starts paused)
- [ ] T45 — Open public testnet — share link, collect feedback for 1 month minimum
- [ ] T46 — Set up Immunefi bug bounty ($500–1000 rewards pool)
- [ ] T47 — Set up on-chain monitoring: vault balance, next_index, repeated nullifier attempts
- [ ] T48 — Security review of all checklist items in PROJET_enhanced.md Section 6
- [ ] T49 — Mainnet deployment: pool starts paused, admin unpauses after 24h monitoring
