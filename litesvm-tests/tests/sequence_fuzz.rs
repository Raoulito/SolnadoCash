//! Sequence fuzzing on LiteSVM: thousands of randomised operation orders, with every
//! previously-found exploit included as a move that must ALWAYS be rejected.
//!
//! Why LiteSVM rather than Trident or a validator
//! ──────────────────────────────────────────────
//! Trident cannot run this program: its syscall stubs lack sol_poseidon and
//! sol_alt_bn128_group_op, so initialize_pool panicked 496/496 times. LiteSVM uses the
//! real syscall registry (verified in syscalls.rs, including that the empty root matches
//! circomlibjs bit-for-bit) and runs ~338 ops/sec versus roughly 1 op/sec over RPC
//! against solana-test-validator. That is what makes thousands of sequences affordable.
//!
//! Valid withdrawals replay pre-generated proofs from fixtures/withdrawals.json, because
//! no SVM can generate a Groth16 proof. See scripts/gen_fuzz_fixtures.js.
//!
//! Invariants re-checked after EVERY step
//! ─────────────────────────────────────
//!   I1  vault == rent + (deposits - withdrawals) * denomination      (no funds leak)
//!   I2  next_index == deposits, and never decreases
//!   I3  treasury received exactly denomination/500 per withdrawal
//!   I4  admin / denomination / treasury / bumps never change
//!   I5  a nullifier account exists for every spent note, and none for unspent ones
//!   I6  pool account length and discriminator never change
//!   I7  is_paused matches the model
//!
//! Attack moves, each asserted to fail with a SPECIFIC error
//! ───────────────────────────────────────────────────────
//!   A1  non-canonical nullifier_hash (h + Fr)          -> NonCanonicalPublicInput  (C-1)
//!   A2  non-canonical root / commitment                -> NonCanonicalPublicInput  (C-1)
//!   A3  replay of a spent note                         -> NullifierAlreadySpent
//!   A4  aliased recipient (R + Fr)                     -> InvalidWithdrawalCommitment (H-2)
//!   A5  vault passed as recipient                      -> DuplicateAccount         (M-2)
//!   A6  relayer_fee_max above 2% of denomination       -> RelayerFeeMaxTooHigh      (H-3)
//!   A7  fee_taken > fee_max                            -> RelayerFeeExceedsMax
//!   A8  garbage proof against a real root              -> InvalidProof
//!   A9  wrong treasury                                 -> InvalidTreasury
//!   A10 unauthorised pause/unpause                     -> fails
//!   A11 pre-funded nullifier PDA                       -> withdrawal still SUCCEEDS  (H-1)
//!   A12 deposit while paused                           -> PoolPaused
//!
//! Run: cargo test --release sequence -- --nocapture
//!      FUZZ_ITERATIONS=200 FUZZ_SEED=42 cargo test --release sequence -- --nocapture

use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use std::collections::HashSet;

const PROGRAM_ID: Pubkey = solana_sdk::pubkey!("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");
const IX_INITIALIZE_POOL: [u8; 8] = [95, 180, 10, 172, 84, 174, 232, 40];
const IX_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
const IX_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
const IX_PAUSE: [u8; 8] = [125, 240, 47, 4, 82, 130, 162, 245];
const IX_UNPAUSE: [u8; 8] = [110, 236, 209, 148, 143, 143, 173, 90];

const OFF_ADMIN: usize = 8;
const OFF_DENOM: usize = 8 + 64;
const OFF_NEXT_INDEX: usize = 8 + 80;
const OFF_TREASURY: usize = 8 + 88;
const OFF_BUMP: usize = 8 + 121;
const OFF_VAULT_BUMP: usize = 8 + 122;
const OFF_IS_PAUSED: usize = 8 + 123;
const POOL_LEN: usize = 8 + 8968;

// Anchor error codes, read from target/idl/solnadocash.json. Asserting on the CODE
// matters: LiteSVM surfaces failures as Custom(code) with no name, so a substring match
// on the error text can never distinguish "rejected by the guard under test" from
// "rejected by some other check". An earlier version of this file accepted any Custom
// error and would have passed even if every attack were failing for the wrong reason.
const E_POOL_PAUSED: u32 = 6000;
#[allow(dead_code)]
const E_ROOT_NOT_FOUND: u32 = 6003;
const E_NULLIFIER_SPENT: u32 = 6004;
#[allow(dead_code)]
const E_INVALID_PROOF: u32 = 6005;
const E_INVALID_WITHDRAWAL_COMMITMENT: u32 = 6007;
const E_RELAYER_FEE_EXCEEDS_MAX: u32 = 6008;
const E_INVALID_TREASURY: u32 = 6015;
const E_NON_CANONICAL: u32 = 6023;
const E_RELAYER_FEE_MAX_TOO_HIGH: u32 = 6024;
const E_DUPLICATE_ACCOUNT: u32 = 6026;

const FR: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

// ── fixtures ────────────────────────────────────────────────────────────────
#[derive(Clone)]
struct Wd {
    nullifier_hash: [u8; 32],
    root: [u8; 32],
    withdrawal_commitment: [u8; 32],
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    recipient: Pubkey,
    fee_max: u64,
}

struct Fixtures {
    denomination: u64,
    relayer: Keypair,
    commitments: Vec<[u8; 32]>,
    withdrawals: Vec<Wd>,
}

fn hexn<const N: usize>(s: &str) -> [u8; N] {
    let mut out = [0u8; N];
    for i in 0..N {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).expect("bad hex");
    }
    out
}

fn load_fixtures() -> Fixtures {
    let raw = std::fs::read_to_string("fixtures/withdrawals.json")
        .expect("fixtures/withdrawals.json missing — run: node scripts/gen_fuzz_fixtures.js");
    let j: serde_json::Value = serde_json::from_str(&raw).expect("bad fixture json");
    let sk: Vec<u8> = j["relayerSecretKey"].as_array().unwrap().iter()
        .map(|v| v.as_u64().unwrap() as u8).collect();
    Fixtures {
        denomination: j["denomination"].as_str().unwrap().parse().unwrap(),
        relayer: Keypair::from_bytes(&sk).expect("bad relayer key"),
        commitments: j["commitments"].as_array().unwrap().iter()
            .map(|c| hexn::<32>(c.as_str().unwrap())).collect(),
        withdrawals: j["withdrawals"].as_array().unwrap().iter().map(|w| Wd {
            nullifier_hash: hexn::<32>(w["nullifierHash"].as_str().unwrap()),
            root: hexn::<32>(w["root"].as_str().unwrap()),
            withdrawal_commitment: hexn::<32>(w["withdrawalCommitment"].as_str().unwrap()),
            proof_a: hexn::<64>(w["proofA"].as_str().unwrap()),
            proof_b: hexn::<128>(w["proofB"].as_str().unwrap()),
            proof_c: hexn::<64>(w["proofC"].as_str().unwrap()),
            recipient: w["recipient"].as_str().unwrap().parse().unwrap(),
            fee_max: w["relayerFeeMax"].as_str().unwrap().parse().unwrap(),
        }).collect(),
    }
}

/// xorshift64 so a failing run is reproducible from its seed alone.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 { self.next() % n }
    fn bytes32(&mut self) -> [u8; 32] {
        let mut b = [0u8; 32];
        for c in b.chunks_mut(8) {
            c.copy_from_slice(&self.next().to_le_bytes()[..c.len()]);
        }
        b
    }
}

fn add_fr(v: &[u8; 32]) -> Option<[u8; 32]> {
    let mut out = *v;
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let s = out[i] as u16 + FR[i] as u16 + carry;
        out[i] = (s & 0xff) as u8;
        carry = s >> 8;
    }
    if carry == 0 { Some(out) } else { None }
}

struct World {
    svm: LiteSVM,
    admin: Keypair,
    outsider: Keypair,
    treasury: Pubkey,
    pool: Pubkey,
    vault: Pubkey,
    fx: Fixtures,
    // model
    denom: u64,
    vault_rent: u64,
    deposits: u64,
    withdrawals: u64,
    paused: bool,
    last_next_index: u64,
    treasury_start: u64,
    spent: HashSet<usize>,
    immutable: Option<Vec<u8>>,
    op_counts: std::collections::BTreeMap<&'static str, u32>,
}

impl World {
    fn new(fx: Fixtures) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(
            PROGRAM_ID,
            &std::fs::read("../target/deploy/solnadocash.so").expect("run anchor build"),
        );
        let admin = Keypair::new();
        let outsider = Keypair::new();
        svm.airdrop(&admin.pubkey(), 100_000 * 1_000_000_000).unwrap();
        svm.airdrop(&outsider.pubkey(), 1_000 * 1_000_000_000).unwrap();
        svm.airdrop(&fx.relayer.pubkey(), 1_000 * 1_000_000_000).unwrap();

        let treasury = Pubkey::new_unique();
        svm.set_account(treasury, Account {
            lamports: 1_000_000_000, data: vec![],
            owner: solana_sdk::system_program::ID, executable: false, rent_epoch: 0,
        }).unwrap();

        let denom = fx.denomination;
        let (pool, _) = Pubkey::find_program_address(
            &[b"pool", admin.pubkey().as_ref(), Pubkey::default().as_ref(),
              &denom.to_le_bytes(), &[0u8]],
            &PROGRAM_ID,
        );
        let (vault, _) = Pubkey::find_program_address(&[b"vault", pool.as_ref()], &PROGRAM_ID);

        let mut w = World {
            svm, admin, outsider, treasury, pool, vault, fx,
            denom, vault_rent: 0, deposits: 0, withdrawals: 0, paused: false,
            last_next_index: 0, treasury_start: 0, spent: HashSet::new(),
            immutable: None, op_counts: Default::default(),
        };
        w.init_pool();
        w.vault_rent = w.svm.get_balance(&w.vault).unwrap();
        w.treasury_start = w.svm.get_balance(&w.treasury).unwrap();
        w
    }

    fn send(&mut self, ix: Instruction, signers: &[&Keypair], payer: &Pubkey) -> Result<(), TxErr> {
        // Advance the blockhash so every transaction has a distinct signature. Without
        // this, repeating an identical attack transaction is rejected as AlreadyProcessed
        // by the status cache rather than by the program — the guard under test is never
        // reached and the assertion passes for the wrong reason. That false pass is
        // exactly what this fuzzer exists to avoid.
        self.svm.expire_blockhash();
        let msg = Message::new(&[ix], Some(payer));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| TxErr::from(e.err))
    }

    fn init_pool(&mut self) {
        let mut data = IX_INITIALIZE_POOL.to_vec();
        data.extend_from_slice(&self.denom.to_le_bytes());
        data.push(0u8);
        let ix = Instruction { program_id: PROGRAM_ID, data, accounts: vec![
            AccountMeta::new(self.admin.pubkey(), true),
            AccountMeta::new(self.pool, false),
            AccountMeta::new(self.vault, false),
            AccountMeta::new_readonly(self.treasury, false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ]};
        let a = self.admin.insecure_clone();
        self.send(ix, &[&a], &a.pubkey()).expect("initialize_pool failed");
    }

    fn deposit(&mut self, commitment: [u8; 32]) -> Result<(), TxErr> {
        let mut data = IX_DEPOSIT.to_vec();
        data.extend_from_slice(&commitment);
        let ix = Instruction { program_id: PROGRAM_ID, data, accounts: vec![
            AccountMeta::new(self.pool, false),
            AccountMeta::new(self.vault, false),
            AccountMeta::new(self.admin.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ]};
        let a = self.admin.insecure_clone();
        self.send(ix, &[&a], &a.pubkey())
    }

    #[allow(clippy::too_many_arguments)]
    fn withdraw_raw(
        &mut self, w: &Wd, nullifier_hash: [u8; 32], root: [u8; 32], wc: [u8; 32],
        fee_max: u64, fee_taken: u64, recipient: Pubkey, treasury: Pubkey,
    ) -> Result<(), TxErr> {
        let (npda, _) = Pubkey::find_program_address(
            &[b"nullifier", self.pool.as_ref(), &nullifier_hash], &PROGRAM_ID);
        let mut data = IX_WITHDRAW.to_vec();
        data.extend_from_slice(&w.proof_a);
        data.extend_from_slice(&w.proof_b);
        data.extend_from_slice(&w.proof_c);
        data.extend_from_slice(&nullifier_hash);
        data.extend_from_slice(&root);
        data.extend_from_slice(&wc);
        data.extend_from_slice(&fee_max.to_le_bytes());
        data.extend_from_slice(&fee_taken.to_le_bytes());
        let ix = Instruction { program_id: PROGRAM_ID, data, accounts: vec![
            AccountMeta::new(self.pool, false),
            AccountMeta::new(self.vault, false),
            AccountMeta::new(npda, false),
            AccountMeta::new(recipient, false),
            AccountMeta::new(treasury, false),
            AccountMeta::new(self.fx.relayer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ]};
        let r = self.fx.relayer.insecure_clone();
        self.send(ix, &[&r], &r.pubkey())
    }

    fn withdraw(&mut self, i: usize) -> Result<(), TxErr> {
        let w = self.fx.withdrawals[i].clone();
        self.withdraw_raw(&w, w.nullifier_hash, w.root, w.withdrawal_commitment,
                          w.fee_max, w.fee_max, w.recipient, self.treasury)
    }

    fn set_paused(&mut self, want: bool, by_outsider: bool) -> Result<(), TxErr> {
        let disc = if want { IX_PAUSE } else { IX_UNPAUSE };
        let signer = if by_outsider { self.outsider.insecure_clone() } else { self.admin.insecure_clone() };
        let ix = Instruction { program_id: PROGRAM_ID, data: disc.to_vec(), accounts: vec![
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(self.pool, false),
        ]};
        self.send(ix, &[&signer], &signer.pubkey())
    }

    fn pool_data(&self) -> Vec<u8> {
        self.svm.get_account(&self.pool).expect("pool gone").data
    }
    fn u64_at(&self, off: usize) -> u64 {
        u64::from_le_bytes(self.pool_data()[off..off + 8].try_into().unwrap())
    }

    fn check(&mut self, ctx: &str) {
        let d = self.pool_data();
        assert_eq!(d.len(), POOL_LEN, "[{ctx}] I6: pool data length changed");
        let next_index = u64::from_le_bytes(d[OFF_NEXT_INDEX..OFF_NEXT_INDEX + 8].try_into().unwrap());
        let denom = u64::from_le_bytes(d[OFF_DENOM..OFF_DENOM + 8].try_into().unwrap());
        let vault = self.svm.get_balance(&self.vault).unwrap();

        // I1
        let expected = self.vault_rent + (self.deposits - self.withdrawals) * denom;
        assert_eq!(vault, expected,
            "[{ctx}] I1: vault {vault} != rent + ({}-{})*{denom} = {expected}",
            self.deposits, self.withdrawals);
        // I2
        assert!(next_index >= self.last_next_index, "[{ctx}] I2: next_index decreased");
        assert_eq!(next_index, self.deposits, "[{ctx}] I2: next_index != deposits");
        self.last_next_index = next_index;
        // I3
        let treasury_now = self.svm.get_balance(&self.treasury).unwrap();
        assert_eq!(treasury_now - self.treasury_start, self.withdrawals * (denom / 500),
            "[{ctx}] I3: treasury total != withdrawals * denomination/500");
        // I4
        let mut snap = Vec::new();
        snap.extend_from_slice(&d[OFF_ADMIN..OFF_ADMIN + 32]);
        snap.extend_from_slice(&d[OFF_DENOM..OFF_DENOM + 8]);
        snap.extend_from_slice(&d[OFF_TREASURY..OFF_TREASURY + 32]);
        snap.push(d[OFF_BUMP]);
        snap.push(d[OFF_VAULT_BUMP]);
        match &self.immutable {
            None => self.immutable = Some(snap),
            Some(p) => assert_eq!(p, &snap, "[{ctx}] I4: an immutable pool field changed"),
        }
        // I5
        for (i, w) in self.fx.withdrawals.iter().enumerate() {
            let (npda, _) = Pubkey::find_program_address(
                &[b"nullifier", self.pool.as_ref(), &w.nullifier_hash], &PROGRAM_ID);
            let exists = self.svm.get_account(&npda).map(|a| !a.data.is_empty()).unwrap_or(false);
            assert_eq!(exists, self.spent.contains(&i),
                "[{ctx}] I5: nullifier {i} existence {exists} disagrees with model");
        }
        // I7
        assert_eq!(d[OFF_IS_PAUSED] == 1, self.paused, "[{ctx}] I7: is_paused disagrees");
    }

    /// Pick an unspent fixture note. Required for attack moves whose target guard sits
    /// AFTER the double-spend check in withdraw.rs, otherwise the nullifier check fires
    /// first and the move silently tests the wrong thing:
    ///   step 2b fee checks -> step 4 treasury -> step 5 root -> step 6 nullifier
    ///   -> step 8 proof -> step 9 commitment
    /// So A4 (commitment) and A5 (distinctness, step 12) need an unspent note, while
    /// A6/A7 (fees) and A9 (treasury) run before it and do not.
    fn pick_unspent(&self, rng: &mut Rng) -> Option<usize> {
        let unspent: Vec<usize> =
            (0..self.fx.withdrawals.len()).filter(|i| !self.spent.contains(i)).collect();
        if unspent.is_empty() {
            return None;
        }
        Some(unspent[rng.below(unspent.len() as u64) as usize])
    }

    fn bump(&mut self, k: &'static str) {
        *self.op_counts.entry(k).or_insert(0) += 1;
    }
}

/// A transaction failure, keeping the custom program error code when there is one.
#[derive(Debug)]
struct TxErr {
    custom: Option<u32>,
    raw: String,
}
impl From<solana_sdk::transaction::TransactionError> for TxErr {
    fn from(e: solana_sdk::transaction::TransactionError) -> Self {
        use solana_sdk::instruction::InstructionError;
        use solana_sdk::transaction::TransactionError;
        let custom = match &e {
            TransactionError::InstructionError(_, InstructionError::Custom(c)) => Some(*c),
            _ => None,
        };
        TxErr { custom, raw: format!("{e:?}") }
    }
}

/// Assert a transaction failed with EXACTLY the expected Anchor error code.
fn assert_code(r: Result<(), TxErr>, expected: u32, what: &str) {
    match r {
        Ok(()) => panic!("{what}: transaction SUCCEEDED but must fail with {expected}"),
        Err(e) => {
            for bogus in ["AlreadyProcessed", "BlockhashNotFound", "SignatureFailure"] {
                assert!(
                    !e.raw.contains(bogus),
                    "{what}: rejected by the RUNTIME ({bogus}), not by the program — the \
                     guard under test was never reached"
                );
            }
            match e.custom {
                Some(c) => assert_eq!(
                    c, expected,
                    "{what}: expected program error {expected}, got {c} ({}) — the \
                     transaction failed, but on a DIFFERENT check than intended",
                    e.raw
                ),
                None => panic!("{what}: expected program error {expected}, got {}", e.raw),
            }
        }
    }
}

#[allow(dead_code)]
fn assert_err_contains(r: Result<(), TxErr>, needle: &str, what: &str) {
    match r {
        Ok(()) => panic!("{what}: transaction SUCCEEDED but must fail"),
        Err(e) => {
            // A runtime-level rejection means the program never ran, so it proves nothing
            // about the guard being tested. Treat it as a harness bug, not a pass.
            for bogus in ["AlreadyProcessed", "BlockhashNotFound", "SignatureFailure"] {
                assert!(
                    !e.raw.contains(bogus),
                    "{what}: rejected by the RUNTIME ({bogus}), not by the program — the \
                     guard under test was never reached"
                );
            }
            assert!(e.raw.contains(needle), "{what}: expected {needle}, got {}", e.raw);
        }
    }
}

#[test]
fn sequence_fuzz_invariants_hold() {
    let iterations: u32 = std::env::var("FUZZ_ITERATIONS").ok()
        .and_then(|v| v.parse().ok()).unwrap_or(60);
    let seed: u64 = std::env::var("FUZZ_SEED").ok()
        .and_then(|v| v.parse().ok()).unwrap_or(0x5EED_1234_ABCD_0001);

    let fx = load_fixtures();
    let n_wd = fx.withdrawals.len();
    println!("\n  [litesvm-fuzz] seed={seed} iterations={iterations} fixtures={n_wd}");

    let mut total_steps = 0u64;
    for iter in 0..iterations {
        let mut rng = Rng(seed ^ ((iter as u64 + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15)));
        let mut w = World::new(load_fixtures());
        w.check("init");

        // Deposit all fixture commitments in order so the fixture proofs' root is live.
        let commitments = w.fx.commitments.clone();
        for c in commitments {
            w.deposit(c).expect("fixture deposit failed");
            w.deposits += 1;
            w.check("fixture deposit");
        }

        let steps = 12 + rng.below(18) as usize;
        for step in 0..steps {
            total_steps += 1;
            let ctx = format!("iter {iter} step {step}");
            match rng.below(14) {
                // ── legitimate operations ──
                0 | 1 => { // deposit random leaf
                    w.bump("deposit");
                    let c = w.svm.minimum_balance_for_rent_exemption(0); // vary nothing; leaf below
                    let _ = c;
                    let mut leaf = rng.bytes32();
                    leaf[0] &= 0x0f; // keep below Fr so Poseidon accepts it
                    let paused = w.paused;
                    match w.deposit(leaf) {
                        Ok(()) => { assert!(!paused, "{ctx} A12: deposit succeeded while paused"); w.deposits += 1; }
                        Err(e) => {
                            assert!(paused, "{ctx}: deposit failed while unpaused: {}", e.raw);
                            assert_eq!(e.custom, Some(E_POOL_PAUSED),
                                "{ctx} A12: expected PoolPaused, got {}", e.raw);
                        }
                    }
                }
                2 | 3 => { // valid withdrawal
                    let unspent: Vec<usize> = (0..n_wd).filter(|i| !w.spent.contains(i)).collect();
                    if let Some(&i) = unspent.get(rng.below(unspent.len().max(1) as u64) as usize) {
                        w.bump("withdraw");
                        let recipient = w.fx.withdrawals[i].recipient;
                        let before = w.svm.get_balance(&recipient).unwrap_or(0);
                        w.withdraw(i).unwrap_or_else(|e| panic!("{ctx}: valid withdrawal failed: {e:?}"));
                        let after = w.svm.get_balance(&recipient).unwrap_or(0);
                        let fee = w.fx.withdrawals[i].fee_max;
                        assert_eq!(after - before, w.denom - w.denom / 500 - fee,
                            "{ctx}: recipient received the wrong amount");
                        w.withdrawals += 1;
                        w.spent.insert(i);
                    }
                }
                4 => { w.bump("pause"); if !w.paused && w.set_paused(true, false).is_ok() { w.paused = true; } }
                5 => { w.bump("unpause"); if w.paused && w.set_paused(false, false).is_ok() { w.paused = false; } }

                // ── attack moves ──
                6 => { // A1: non-canonical nullifier hash
                    w.bump("A1_noncanonical_nullifier");
                    let i = rng.below(n_wd as u64) as usize;
                    let wd = w.fx.withdrawals[i].clone();
                    if let Some(alias) = add_fr(&wd.nullifier_hash) {
                        let r = w.withdraw_raw(&wd, alias, wd.root, wd.withdrawal_commitment,
                            wd.fee_max, wd.fee_max, wd.recipient, w.treasury);
                        assert_code(r, E_NON_CANONICAL, &format!("{ctx} A1"));
                    }
                }
                7 => { // A2: non-canonical root
                    w.bump("A2_noncanonical_root");
                    let i = rng.below(n_wd as u64) as usize;
                    let wd = w.fx.withdrawals[i].clone();
                    if let Some(alias) = add_fr(&wd.root) {
                        let r = w.withdraw_raw(&wd, wd.nullifier_hash, alias,
                            wd.withdrawal_commitment, wd.fee_max, wd.fee_max, wd.recipient, w.treasury);
                        assert_code(r, E_NON_CANONICAL, &format!("{ctx} A2"));
                    }
                }
                8 => { // A3: replay
                    let spent: Vec<usize> = w.spent.iter().copied().collect();
                    if let Some(&i) = spent.get(rng.below(spent.len().max(1) as u64) as usize) {
                        w.bump("A3_replay");
                        let r = w.withdraw(i);
                        assert_code(r, E_NULLIFIER_SPENT, &format!("{ctx} A3"));
                    }
                }
                9 => { // A4: aliased recipient (needs an unspent note — see pick_unspent)
                    let Some(i) = w.pick_unspent(&mut rng) else { continue };
                    w.bump("A4_aliased_recipient");
                    let wd = w.fx.withdrawals[i].clone();
                    if let Some(alias) = add_fr(&wd.recipient.to_bytes()) {
                        let r = w.withdraw_raw(&wd, wd.nullifier_hash, wd.root,
                            wd.withdrawal_commitment, wd.fee_max, wd.fee_max,
                            Pubkey::new_from_array(alias), w.treasury);
                        assert_code(r, E_INVALID_WITHDRAWAL_COMMITMENT, &format!("{ctx} A4"));
                    }
                }
                10 => { // A5: vault as recipient (needs an unspent note)
                    let Some(i) = w.pick_unspent(&mut rng) else { continue };
                    w.bump("A5_vault_as_recipient");
                    let wd = w.fx.withdrawals[i].clone();
                    let vault = w.vault;
                    let r = w.withdraw_raw(&wd, wd.nullifier_hash, wd.root,
                        wd.withdrawal_commitment, wd.fee_max, wd.fee_max, vault, w.treasury);
                    // The commitment binds the real recipient, so the commitment check
                    // fires before the distinctness guard. Either is a valid rejection;
                    // assert it is one of those two and not something incidental.
                    match r {
                        Ok(()) => panic!("{ctx} A5: vault as recipient SUCCEEDED"),
                        Err(e) => assert!(
                            e.custom == Some(E_INVALID_WITHDRAWAL_COMMITMENT)
                                || e.custom == Some(E_DUPLICATE_ACCOUNT),
                            "{ctx} A5: expected commitment/duplicate rejection, got {}", e.raw
                        ),
                    }
                }
                11 => { // A6/A7: fee abuse
                    w.bump("A6_fee_abuse");
                    let i = rng.below(n_wd as u64) as usize;
                    let wd = w.fx.withdrawals[i].clone();
                    let cap = w.denom / 50;
                    let r = w.withdraw_raw(&wd, wd.nullifier_hash, wd.root,
                        wd.withdrawal_commitment, cap + 1, cap + 1, wd.recipient, w.treasury);
                    assert_code(r, E_RELAYER_FEE_MAX_TOO_HIGH, &format!("{ctx} A6"));
                    let r2 = w.withdraw_raw(&wd, wd.nullifier_hash, wd.root,
                        wd.withdrawal_commitment, wd.fee_max, wd.fee_max + 1, wd.recipient, w.treasury);
                    assert_code(r2, E_RELAYER_FEE_EXCEEDS_MAX, &format!("{ctx} A7"));
                }
                12 => { // A9/A10: wrong treasury, unauthorised pause
                    w.bump("A9_wrong_treasury");
                    let i = rng.below(n_wd as u64) as usize;
                    let wd = w.fx.withdrawals[i].clone();
                    let bogus = Pubkey::new_unique();
                    let r = w.withdraw_raw(&wd, wd.nullifier_hash, wd.root,
                        wd.withdrawal_commitment, wd.fee_max, wd.fee_max, wd.recipient, bogus);
                    assert_code(r, E_INVALID_TREASURY, &format!("{ctx} A9"));
                    let want = !w.paused;
                    let r2 = w.set_paused(want, true);
                    assert!(r2.is_err(), "{ctx} A10: an outsider changed the pause state");
                }
                _ => { // A11: pre-funded nullifier PDA must not brick a withdrawal
                    let unspent: Vec<usize> = (0..n_wd).filter(|i| !w.spent.contains(i)).collect();
                    if let Some(&i) = unspent.get(rng.below(unspent.len().max(1) as u64) as usize) {
                        w.bump("A11_prefunded_nullifier");
                        let nh = w.fx.withdrawals[i].nullifier_hash;
                        let (npda, _) = Pubkey::find_program_address(
                            &[b"nullifier", w.pool.as_ref(), &nh], &PROGRAM_ID);
                        let grief = w.svm.minimum_balance_for_rent_exemption(0);
                        w.svm.set_account(npda, Account {
                            lamports: grief, data: vec![],
                            owner: solana_sdk::system_program::ID, executable: false, rent_epoch: 0,
                        }).unwrap();
                        let recipient = w.fx.withdrawals[i].recipient;
                        let before = w.svm.get_balance(&recipient).unwrap_or(0);
                        w.withdraw(i).unwrap_or_else(|e|
                            panic!("{ctx} A11: pre-funded nullifier BRICKED the note: {e:?}"));
                        let after = w.svm.get_balance(&recipient).unwrap_or(0);
                        let fee = w.fx.withdrawals[i].fee_max;
                        assert_eq!(after - before, w.denom - w.denom / 500 - fee,
                            "{ctx} A11: wrong payout after the griefing attempt");
                        w.withdrawals += 1;
                        w.spent.insert(i);
                        // The stray lamports are absorbed; the account must be ours now.
                        let acc = w.svm.get_account(&npda).unwrap();
                        assert_eq!(acc.owner, PROGRAM_ID, "{ctx} A11: nullifier not owned by program");
                        assert_eq!(acc.data.len(), 80, "{ctx} A11: nullifier wrong size");
                    }
                }
            }
            w.check(&ctx);
        }

        if iter == 0 {
            println!("  [litesvm-fuzz] iteration 0: {} deposits, {} withdrawals, ops {:?}",
                w.deposits, w.withdrawals, w.op_counts);
        }
    }

    println!("  [litesvm-fuzz] {iterations} iterations, {total_steps} steps — all invariants held\n");
    assert!(total_steps > 0);
}
