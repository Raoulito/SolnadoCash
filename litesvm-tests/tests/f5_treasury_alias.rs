//! F-5: no payout target may be the nullifier PDA.
//!
//! The reachable case: a pool creator sets `treasury` to the PDA that a chosen nullifier
//! hash will later occupy. It is system-owned and empty at pool creation, so the
//! SystemAccount constraint accepts it. Without a guard, every withdrawal spending that
//! note credits the protocol fee into an account this program creates moments later and
//! which no instruction can ever move lamports out of — the fee is burned.
//!
//! Tested here because it is the one variant a party other than the payee controls. A
//! general "reject all PDAs" check is not available: Pubkey::is_on_curve() is
//! `unimplemented!()` under target_os = "solana" and panics on-chain.

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

#[test]
fn treasury_may_not_be_the_nullifier_pda() {
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

    // The attacker precomputes the pool PDA (all seeds are known before creation), then
    // the nullifier PDA under it for a nullifier hash they expect to see spent.
    let (pool, _) = Pubkey::find_program_address(
        &[b"pool", admin.pubkey().as_ref(), Pubkey::default().as_ref(),
          &denom.to_le_bytes(), &[0u8]], &PROGRAM_ID);
    let (vault, _) = Pubkey::find_program_address(&[b"vault", pool.as_ref()], &PROGRAM_ID);
    let (nullifier_pda, _) = Pubkey::find_program_address(
        &[b"nullifier", pool.as_ref(), &nullifier_hash], &PROGRAM_ID);

    // It is system-owned and empty, so SystemAccount accepts it as the treasury.
    svm.set_account(nullifier_pda, Account {
        lamports: 1_000_000, data: vec![],
        owner: solana_sdk::system_program::ID, executable: false, rent_epoch: 0,
    }).unwrap();

    let mut data = IX_INITIALIZE_POOL.to_vec();
    data.extend_from_slice(&denom.to_le_bytes());
    data.push(0u8);
    let ix = Instruction { program_id: PROGRAM_ID, data, accounts: vec![
        AccountMeta::new(admin.pubkey(), true),
        AccountMeta::new(pool, false),
        AccountMeta::new(vault, false),
        AccountMeta::new_readonly(nullifier_pda, false), // <- treasury aliases the PDA
        AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
    ]};
    let msg = Message::new(&[ix], Some(&admin.pubkey()));
    svm.send_transaction(Transaction::new(&[&admin], msg, svm.latest_blockhash()))
        .expect("pool creation with a PDA treasury is accepted — that is the premise");

    // Deposit every fixture commitment so the proof's root is live.
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

    // The withdrawal that would burn the fee must now be rejected.
    svm.expire_blockhash();
    let recipient: Pubkey = w["recipient"].as_str().unwrap().parse().unwrap();
    let fee: u64 = w["relayerFeeMax"].as_str().unwrap().parse().unwrap();
    let mut data = IX_WITHDRAW.to_vec();
    data.extend_from_slice(&hexn::<64>(w["proofA"].as_str().unwrap()));
    data.extend_from_slice(&hexn::<128>(w["proofB"].as_str().unwrap()));
    data.extend_from_slice(&hexn::<64>(w["proofC"].as_str().unwrap()));
    data.extend_from_slice(&nullifier_hash);
    data.extend_from_slice(&hexn::<32>(w["root"].as_str().unwrap()));
    data.extend_from_slice(&hexn::<32>(w["withdrawalCommitment"].as_str().unwrap()));
    data.extend_from_slice(&fee.to_le_bytes());
    data.extend_from_slice(&fee.to_le_bytes());
    let ix = Instruction { program_id: PROGRAM_ID, data, accounts: vec![
        AccountMeta::new(pool, false),
        AccountMeta::new(vault, false),
        AccountMeta::new(nullifier_pda, false),
        AccountMeta::new(recipient, false),
        AccountMeta::new(nullifier_pda, false), // treasury == nullifier PDA
        AccountMeta::new(relayer.pubkey(), true),
        AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
    ]};
    let msg = Message::new(&[ix], Some(&relayer.pubkey()));
    let err = svm
        .send_transaction(Transaction::new(&[&relayer], msg, svm.latest_blockhash()))
        .expect_err("treasury aliasing the nullifier PDA must be rejected");

    let code = match err.err {
        solana_sdk::transaction::TransactionError::InstructionError(
            _, solana_sdk::instruction::InstructionError::Custom(c)) => Some(c),
        _ => None,
    };
    assert_eq!(
        code, Some(E_DUPLICATE_ACCOUNT),
        "expected DuplicateAccount ({E_DUPLICATE_ACCOUNT}), got {:?}", err.err
    );
}
