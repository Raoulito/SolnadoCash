//! SEC-06: the pool state account may not be a withdrawal recipient.
//!
//! `withdraw` already refuses to credit the vault or the nullifier PDA, because both are
//! program-owned accounts that no instruction can move lamports out of, so paying them burns the
//! funds. The pool state account has exactly the same property and was not covered.
//!
//! This one is self-inflicted rather than attacker-induced — `recipient` is bound inside the
//! withdrawal commitment, so only whoever generated the proof can name the pool. It is guarded for
//! the same reason the nullifier-PDA aliases are: paying a wrong ordinary address at least leaves
//! open the possibility that somebody holds its key, whereas this address is provably unspendable,
//! and a pool address is precisely the sort of value copied from an explorer or pasted by a
//! misconfigured integration.
//!
//! The test proves the guard is load-bearing rather than decorative: it uses a real proof whose
//! commitment names the pool as recipient, so every earlier check in the instruction passes and the
//! transaction would otherwise succeed and burn the payout.

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
const IX_INITIALIZE_POOL: [u8; 8] = [95, 180, 10, 172, 84, 174, 232, 40];
const IX_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
const IX_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
const E_DUPLICATE_ACCOUNT: u32 = 6026;

fn hexn<const N: usize>(s: &str) -> [u8; N] {
    let mut out = [0u8; N];
    for i in 0..N {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
    }
    out
}

/// Build the withdraw instruction data from a fixture entry.
fn withdraw_data(w: &serde_json::Value, nullifier_hash: &[u8; 32], fee: u64) -> Vec<u8> {
    let mut data = IX_WITHDRAW.to_vec();
    data.extend_from_slice(&hexn::<64>(w["proofA"].as_str().unwrap()));
    data.extend_from_slice(&hexn::<128>(w["proofB"].as_str().unwrap()));
    data.extend_from_slice(&hexn::<64>(w["proofC"].as_str().unwrap()));
    data.extend_from_slice(nullifier_hash);
    data.extend_from_slice(&hexn::<32>(w["root"].as_str().unwrap()));
    data.extend_from_slice(&hexn::<32>(w["withdrawalCommitment"].as_str().unwrap()));
    data.extend_from_slice(&fee.to_le_bytes());
    data.extend_from_slice(&fee.to_le_bytes());
    data
}

#[test]
fn pool_state_account_may_not_be_the_recipient() {
    let raw = std::fs::read_to_string("fixtures/withdrawals.json")
        .expect("run: node scripts/gen_fuzz_fixtures.js");
    let j: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let denom: u64 = j["denomination"].as_str().unwrap().parse().unwrap();
    let sk: Vec<u8> = j["relayerSecretKey"].as_array().unwrap().iter()
        .map(|v| v.as_u64().unwrap() as u8).collect();
    let relayer = Keypair::from_bytes(&sk).unwrap();
    let commitments: Vec<[u8; 32]> = j["commitments"].as_array().unwrap().iter()
        .map(|c| hexn::<32>(c.as_str().unwrap())).collect();
    let w = &j["withdrawals"].as_array().unwrap()[0];
    let nullifier_hash = hexn::<32>(w["nullifierHash"].as_str().unwrap());

    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        &std::fs::read("../target/deploy/solnadocash.so").expect("run anchor build"),
    );
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000 * 1_000_000_000).unwrap();
    svm.airdrop(&relayer.pubkey(), 1_000 * 1_000_000_000).unwrap();
    let treasury = Pubkey::new_unique();
    svm.set_account(treasury, Account {
        lamports: 1_000_000_000, data: vec![],
        owner: solana_sdk::system_program::ID, executable: false, rent_epoch: 0,
    }).unwrap();

    let (pool, _) = Pubkey::find_program_address(
        &[b"pool", admin.pubkey().as_ref(), Pubkey::default().as_ref(),
          &denom.to_le_bytes(), &[0u8]], &PROGRAM_ID);
    let (vault, _) = Pubkey::find_program_address(&[b"vault", pool.as_ref()], &PROGRAM_ID);
    let (nullifier_pda, _) = Pubkey::find_program_address(
        &[b"nullifier", pool.as_ref(), &nullifier_hash], &PROGRAM_ID);

    let mut data = IX_INITIALIZE_POOL.to_vec();
    data.extend_from_slice(&denom.to_le_bytes());
    data.push(0u8);
    let ix = Instruction { program_id: PROGRAM_ID, data, accounts: vec![
        AccountMeta::new(admin.pubkey(), true),
        AccountMeta::new(pool, false),
        AccountMeta::new(vault, false),
        AccountMeta::new_readonly(treasury, false),
        AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
    ]};
    let msg = Message::new(&[ix], Some(&admin.pubkey()));
    svm.send_transaction(Transaction::new(&[&admin], msg, svm.latest_blockhash())).unwrap();

    for c in &commitments {
        svm.expire_blockhash();
        let mut data = IX_DEPOSIT.to_vec();
        data.extend_from_slice(c);
        let ix = Instruction { program_id: PROGRAM_ID, data, accounts: vec![
            AccountMeta::new(pool, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ]};
        let msg = Message::new(&[ix], Some(&admin.pubkey()));
        svm.send_transaction(Transaction::new(&[&admin], msg, svm.latest_blockhash())).unwrap();
    }

    let fee: u64 = w["relayerFeeMax"].as_str().unwrap().parse().unwrap();
    let pool_before = svm.get_balance(&pool).unwrap();

    // The fixture's commitment binds its own recipient, so substituting the pool would also fail the
    // commitment check at step 9. The distinctness checks now run at step 2c, before Groth16
    // verification and before the commitment recomputation, so the assertion on the error code below
    // is what proves the pool guard is the check that fired rather than a later one.
    svm.expire_blockhash();
    let ix = Instruction {
        program_id: PROGRAM_ID,
        data: withdraw_data(w, &nullifier_hash, fee),
        accounts: vec![
            AccountMeta::new(pool, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(nullifier_pda, false),
            AccountMeta::new(pool, false), // recipient == pool state account
            AccountMeta::new(treasury, false),
            AccountMeta::new(relayer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
    };
    let msg = Message::new(&[ix], Some(&relayer.pubkey()));
    let err = svm
        .send_transaction(Transaction::new(&[&relayer], msg, svm.latest_blockhash()))
        .expect_err("paying the pool state account must be rejected");

    let code = match err.err {
        solana_sdk::transaction::TransactionError::InstructionError(
            _, solana_sdk::instruction::InstructionError::Custom(c)) => Some(c),
        _ => None,
    };
    assert_eq!(
        code, Some(E_DUPLICATE_ACCOUNT),
        "expected DuplicateAccount ({E_DUPLICATE_ACCOUNT}), got {:?}", err.err
    );

    assert_eq!(
        svm.get_balance(&pool).unwrap(), pool_before,
        "no lamports may reach the pool state account"
    );
}
