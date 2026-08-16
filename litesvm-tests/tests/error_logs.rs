//! What the on-chain error log actually says, under both build variants.
//!
//! Anchor's `require!` attaches the source filename and line, which Solscan surfaces to anyone
//! simulating a transaction. The `strip-error-origins` feature removes that. This test pins the
//! behaviour of both builds, because the useful direction is easy to break by accident: if
//! `line!()` resolved to the macro's own definition site instead of the call site, the default
//! build would report a single useless line number for every error in the program and nothing
//! would fail.
//!
//! Stripping is ON by default (see Cargo.toml), so the DEFAULT expectation here is a stripped log.
//! That has to match the default build or `cargo test` fails for everyone who did not read this
//! comment, which is how it failed the first time.
//!
//! Run:
//!   anchor build                                  && cargo test --release --test error_logs
//!   cargo build-sbf -- --no-default-features      && EXPECT_ORIGINS=1 cargo test --release --test error_logs

use litesvm::LiteSVM;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};

const PROGRAM_ID: Pubkey = solana_sdk::pubkey!("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");
const IX_INITIALIZE_POOL: [u8; 8] = [95, 180, 10, 172, 84, 174, 232, 40];

/// Triggers DenominationTooLow, which is a `guard!` in initialize_pool, and returns the logs.
fn failing_logs() -> Vec<String> {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        &std::fs::read("../target/deploy/solnadocash.so").expect("run anchor build"),
    );
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 100 * 1_000_000_000).unwrap();

    // Below the rent-derived floor, so initialize_pool rejects it.
    let denom: u64 = 1_000;
    let (pool, _) = Pubkey::find_program_address(
        &[b"pool", admin.pubkey().as_ref(), Pubkey::default().as_ref(),
          &denom.to_le_bytes(), &[0u8]], &PROGRAM_ID);
    let (vault, _) = Pubkey::find_program_address(&[b"vault", pool.as_ref()], &PROGRAM_ID);

    let mut data = IX_INITIALIZE_POOL.to_vec();
    data.extend_from_slice(&denom.to_le_bytes());
    data.push(0u8);
    let ix = Instruction { program_id: PROGRAM_ID, data, accounts: vec![
        AccountMeta::new(admin.pubkey(), true),
        AccountMeta::new(pool, false),
        AccountMeta::new(vault, false),
        AccountMeta::new_readonly(admin.pubkey(), false),
        AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
    ]};
    let msg = Message::new(&[ix], Some(&admin.pubkey()));
    let err = svm
        .send_transaction(Transaction::new(&[&admin], msg, svm.latest_blockhash()))
        .expect_err("a denomination below the floor must be rejected");
    err.meta.logs
}

#[test]
fn error_logs_match_the_build_variant() {
    let logs = failing_logs();
    let joined = logs.join("\n");
    // Default: stripped, matching `default = ["strip-error-origins"]`.
    let stripped = std::env::var("EXPECT_ORIGINS").is_err();

    // The error itself must be reported either way: the code and message are what callers and the
    // relayer's error mapping depend on, and the feature is only about the source location.
    assert!(
        joined.contains("DenominationTooLow"),
        "the error code must always be logged, got:\n{joined}"
    );

    if stripped {
        assert!(
            !joined.contains(".rs:"),
            "strip-error-origins build must not leak a source location, got:\n{joined}"
        );
        assert!(
            !joined.contains("programs/solnadocash"),
            "strip-error-origins build must not leak a path, got:\n{joined}"
        );
    } else {
        assert!(
            joined.contains("programs/solnadocash/src/initialize_pool.rs:"),
            "default build should report the CALL SITE file. If this fails with lib.rs, then \
             line!() is resolving to the guard! definition instead of the invocation, which would \
             make every error report the same useless location. Got:\n{joined}"
        );
    }
}
