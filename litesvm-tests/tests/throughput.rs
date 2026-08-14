//! Throughput comparison: how many operations per second can LiteSVM drive?
//!
//! This decides whether porting the sequence fuzzer off solana-test-validator is worth
//! it. The validator harness needs ~20s of startup plus ~1s per operation, which caps a
//! run at a few dozen steps. If LiteSVM is orders of magnitude faster, the same fuzzer
//! can explore thousands of sequences.
//!
//! Run with: cargo test --release throughput -- --nocapture --ignored

use litesvm::LiteSVM;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use std::time::Instant;

const PROGRAM_ID: Pubkey = solana_sdk::pubkey!("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");
const DENOMINATION: u64 = 1_000_000_000;
const IX_INITIALIZE_POOL: [u8; 8] = [95, 180, 10, 172, 84, 174, 232, 40];
const IX_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];

#[test]
#[ignore = "benchmark; run explicitly with --ignored"]
fn throughput_deposits_per_second() {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        &std::fs::read("../target/deploy/solnadocash.so").expect("run anchor build first"),
    );

    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 100_000 * 1_000_000_000).unwrap();
    let treasury = Pubkey::new_unique();
    svm.set_account(
        treasury,
        Account {
            lamports: 1_000_000_000,
            data: vec![],
            owner: solana_sdk::system_program::ID,
            executable: false,
            rent_epoch: 0,
        },
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

    // init
    let mut data = IX_INITIALIZE_POOL.to_vec();
    data.extend_from_slice(&DENOMINATION.to_le_bytes());
    data.push(0u8);
    let ix = Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new(pool, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(treasury, false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
        data,
    };
    let msg = Message::new(&[ix], Some(&admin.pubkey()));
    svm.send_transaction(Transaction::new(&[&admin], msg, svm.latest_blockhash()))
        .expect("init");

    const N: u32 = 500;
    let start = Instant::now();
    for i in 0..N {
        let mut commitment = [0u8; 32];
        commitment[28..].copy_from_slice(&i.to_be_bytes());
        commitment[0] = 1; // keep it a plausible field element
        let mut data = IX_DEPOSIT.to_vec();
        data.extend_from_slice(&commitment);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(pool, false),
                AccountMeta::new(vault, false),
                AccountMeta::new(admin.pubkey(), true),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
            data,
        };
        let msg = Message::new(&[ix], Some(&admin.pubkey()));
        svm.send_transaction(Transaction::new(&[&admin], msg, svm.latest_blockhash()))
            .expect("deposit");
    }
    let elapsed = start.elapsed();
    let per_op = elapsed.as_secs_f64() / N as f64;

    println!("\n  LiteSVM: {N} deposits in {:.2?} => {:.3} ms/op, {:.0} ops/sec",
        elapsed, per_op * 1000.0, 1.0 / per_op);
    println!("  Each deposit performs 20 chained Poseidon syscalls.");
    println!("  For comparison, the solana-test-validator harness needs ~20s of startup");
    println!("  plus roughly 1s per operation over RPC.\n");

    let next_index = u64::from_le_bytes(
        svm.get_account(&pool).unwrap().data[8 + 80..8 + 88].try_into().unwrap(),
    );
    assert_eq!(next_index as u32, N, "all deposits should have landed");
}
