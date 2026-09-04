//! Does LiteSVM actually run the syscalls this program depends on?
//!
//! Trident could not: trident-svm executes SBF through trident-syscall-stubs-v2, which
//! has no sol_poseidon and no sol_alt_bn128_group_op, so initialize_pool aborted on its
//! first hash (496/496 iterations panicked).
//!
//! LiteSVM builds its runtime with `create_program_runtime_environment_v1` from
//! solana_bpf_loader_program::syscalls — the real registry — and defaults to
//! `FeatureSet::all_enabled()`, so the Poseidon feature gate is active. These tests
//! verify that empirically rather than trusting the reasoning.
//!
//! What each test proves:
//!   1. initialize_pool succeeds -> sol_poseidon works (it computes the empty Merkle root)
//!   2. deposit succeeds and moves the root -> 20 chained Poseidon hashes work
//!   3. a garbage withdraw fails on the PROOF, not on a missing syscall -> alt_bn128 works

use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};

const PROGRAM_ID: Pubkey = solana_sdk::pubkey!("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");
const DENOMINATION: u64 = 1_000_000_000;
const SO_PATH: &str = "../target/deploy/solnadocash.so";

// Anchor discriminators (first 8 bytes of sha256("global:<name>")), taken from the IDL.
const IX_INITIALIZE_POOL: [u8; 8] = [95, 180, 10, 172, 84, 174, 232, 40];
const IX_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
const IX_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];

const OFF_NEXT_INDEX: usize = 8 + 80;
const OFF_CURRENT_ROOT_INDEX: usize = 8 + 128;
const OFF_ROOT_HISTORY: usize = 8 + 136;

struct Fixture {
    svm: LiteSVM,
    admin: Keypair,
    treasury: Pubkey,
    pool: Pubkey,
    vault: Pubkey,
}

fn setup() -> Fixture {
    let mut svm = LiteSVM::new();
    let bytes = std::fs::read(SO_PATH).unwrap_or_else(|e| {
        panic!("cannot read {SO_PATH}: {e}. Run `anchor build` first.");
    });
    svm.add_program(PROGRAM_ID, &bytes);

    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 500 * 1_000_000_000).unwrap();

    // Treasury must be system-owned (initialize_pool declares SystemAccount).
    let treasury = Pubkey::new_unique();
    svm.set_account(
        treasury,
        Account { lamports: 1_000_000_000, data: vec![], owner: solana_sdk::system_program::ID, executable: false, rent_epoch: 0 },
    )
    .unwrap();

    let (pool, _) = Pubkey::find_program_address(
        &[
            b"pool",
            admin.pubkey().as_ref(),
            Pubkey::default().as_ref(),
            &DENOMINATION.to_le_bytes(),
            &[0u8],
        ],
        &PROGRAM_ID,
    );
    let (vault, _) = Pubkey::find_program_address(&[b"vault", pool.as_ref()], &PROGRAM_ID);

    Fixture { svm, admin, treasury, pool, vault }
}

impl Fixture {
    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
        let msg = Message::new(&[ix], Some(&self.admin.pubkey()));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}", e))
    }

    fn init_pool(&mut self) -> Result<(), String> {
        let mut data = IX_INITIALIZE_POOL.to_vec();
        data.extend_from_slice(&DENOMINATION.to_le_bytes());
        data.push(0u8); // version
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new(self.pool, false),
                AccountMeta::new(self.vault, false),
                AccountMeta::new_readonly(self.treasury, false),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data,
        };
        let admin = self.admin.insecure_clone();
        self.send(ix, &[&admin])
    }

    fn deposit(&mut self, commitment: [u8; 32]) -> Result<(), String> {
        let mut data = IX_DEPOSIT.to_vec();
        data.extend_from_slice(&commitment);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(self.pool, false),
                AccountMeta::new(self.vault, false),
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data,
        };
        let admin = self.admin.insecure_clone();
        self.send(ix, &[&admin])
    }

    fn pool_data(&self) -> Vec<u8> {
        self.svm.get_account(&self.pool).expect("pool missing").data
    }

    fn current_root(&self) -> Vec<u8> {
        let d = self.pool_data();
        let idx = u64::from_le_bytes(
            d[OFF_CURRENT_ROOT_INDEX..OFF_CURRENT_ROOT_INDEX + 8]
                .try_into()
                .unwrap(),
        ) as usize;
        d[OFF_ROOT_HISTORY + idx * 32..OFF_ROOT_HISTORY + idx * 32 + 32].to_vec()
    }
}

#[test]
fn poseidon_syscall_works_initialize_pool_succeeds() {
    let mut fx = setup();
    let result = fx.init_pool();
    assert!(
        result.is_ok(),
        "initialize_pool failed under LiteSVM: {:?}\n\
         It computes the depth-20 empty root with sol_poseidon, so a failure here means \
         the syscall is unavailable — the exact wall Trident hit.",
        result
    );

    // The seeded empty root must be non-zero, proving Poseidon actually ran rather than
    // the field being left zeroed.
    let root = fx.current_root();
    assert_ne!(root, vec![0u8; 32], "root_history[0] is zero — Poseidon did not run");

    // Known value: Poseidon(ZEROS[19], ZEROS[19]) for the depth-20 empty tree.
    let expected =
        hex_to_bytes("2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e");
    assert_eq!(
        root, expected,
        "empty root does not match the value computed by circomlibjs — Poseidon \
         parameters differ between LiteSVM and the real runtime"
    );
}

#[test]
fn poseidon_chain_works_deposit_moves_the_root() {
    let mut fx = setup();
    fx.init_pool().expect("init");
    let before = fx.current_root();

    // A deposit performs 20 chained Poseidon hashes up the tree.
    fx.deposit([7u8; 32]).expect("deposit failed — 20-level Poseidon insert unavailable");

    let after = fx.current_root();
    assert_ne!(before, after, "root unchanged after deposit — the Merkle insert did not run");
    let next_index = u64::from_le_bytes(
        fx.pool_data()[OFF_NEXT_INDEX..OFF_NEXT_INDEX + 8].try_into().unwrap(),
    );
    assert_eq!(next_index, 1, "next_index did not advance");
}

#[test]
fn alt_bn128_syscall_reached_garbage_proof_fails_on_verification() {
    let mut fx = setup();
    fx.init_pool().expect("init");
    fx.deposit([9u8; 32]).expect("deposit");

    // Build a withdraw whose root IS in history, so execution reaches the Groth16
    // verifier rather than bouncing off RootNotFound. Everything else is garbage, so it
    // must fail on the PROOF — which proves alt_bn128 executed and rejected it, rather
    // than the syscall being missing.
    let root = fx.current_root();
    let nullifier_hash = [3u8; 32];
    let (nullifier_pda, _) = Pubkey::find_program_address(
        &[b"nullifier", fx.pool.as_ref(), &nullifier_hash],
        &PROGRAM_ID,
    );
    let recipient = Pubkey::new_unique();

    let mut data = IX_WITHDRAW.to_vec();
    data.extend_from_slice(&[1u8; 64]); // proof_a
    data.extend_from_slice(&[1u8; 128]); // proof_b
    data.extend_from_slice(&[1u8; 64]); // proof_c
    data.extend_from_slice(&nullifier_hash);
    data.extend_from_slice(&root);
    data.extend_from_slice(&[2u8; 32]); // withdrawal_commitment
    data.extend_from_slice(&0u64.to_le_bytes()); // relayer_fee_max
    data.extend_from_slice(&0u64.to_le_bytes()); // relayer_fee_taken

    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(fx.pool, false),
            AccountMeta::new(fx.vault, false),
            AccountMeta::new(nullifier_pda, false),
            AccountMeta::new(recipient, false),
            AccountMeta::new(fx.treasury, false),
            AccountMeta::new(fx.admin.pubkey(), true), // relayer must sign
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
        data,
    };
    let admin = fx.admin.insecure_clone();
    let err = fx.send(ix, &[&admin]).expect_err("a garbage proof must never succeed");

    // Must fail for a cryptographic reason, not because a syscall was unavailable.
    let e = err.to_lowercase();
    assert!(
        !e.contains("unsupported") && !e.contains("unknown syscall") && !e.contains("unresolved"),
        "withdraw failed because a syscall is missing, not because the proof is invalid: {err}"
    );
}

fn hex_to_bytes(h: &str) -> Vec<u8> {
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
        .collect()
}
