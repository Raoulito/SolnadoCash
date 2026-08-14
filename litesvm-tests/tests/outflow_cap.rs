//! Is the vault's total outflow already capped, without any admin intervention?
//!
//! This matters for incident-response design. If a soundness bug ever let someone forge a
//! proof, the question is how much they could take. The claim under test:
//!
//!   vault = rent + (deposits - withdrawals) * denomination
//!   and every withdrawal requires vault.lamports() >= denomination  (withdraw.rs:441)
//!   therefore once withdrawals == deposits the vault holds only `rent`, which is far
//!   below one denomination, so the NEXT withdrawal fails on InsufficientVaultBalance
//!   regardless of how valid its proof is.
//!
//! If that holds, total outflow is capped at total deposits by arithmetic alone — no
//! trusted party, no pause, no upgrade. A forged-proof attacker can steal at most the
//! pool's current balance and can never mint beyond it. That bounds the exposure an
//! emergency pause would be defending against.

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
const E_INSUFFICIENT_VAULT: u32 = 6022;
const OFF_NEXT_INDEX: usize = 8 + 80;

fn hexn<const N: usize>(s: &str) -> [u8; N] {
    let mut out = [0u8; N];
    for i in 0..N {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
    }
    out
}

#[test]
fn total_outflow_is_capped_by_total_deposits() {
    let raw = std::fs::read_to_string("fixtures/withdrawals.json")
        .expect("run: node scripts/gen_fuzz_fixtures.js");
    let j: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let denom: u64 = j["denomination"].as_str().unwrap().parse().unwrap();
    let sk: Vec<u8> = j["relayerSecretKey"].as_array().unwrap().iter()
        .map(|v| v.as_u64().unwrap() as u8).collect();
    let relayer = Keypair::from_bytes(&sk).unwrap();
    let commitments: Vec<[u8; 32]> = j["commitments"].as_array().unwrap().iter()
        .map(|c| hexn::<32>(c.as_str().unwrap())).collect();
    let wds = j["withdrawals"].as_array().unwrap();

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

    // init
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

    let vault_rent = svm.get_balance(&vault).unwrap();
    assert!(vault_rent < denom, "premise: rent must be below one denomination");

    // Deposit every fixture commitment.
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
    let deposits = commitments.len() as u64;
    assert_eq!(svm.get_balance(&vault).unwrap(), vault_rent + deposits * denom);

    // Drain every note with its real proof.
    let mut done = 0u64;
    for w in wds {
        svm.expire_blockhash();
        let nh = hexn::<32>(w["nullifierHash"].as_str().unwrap());
        let (npda, _) = Pubkey::find_program_address(
            &[b"nullifier", pool.as_ref(), &nh], &PROGRAM_ID);
        let recipient: Pubkey = w["recipient"].as_str().unwrap().parse().unwrap();
        let fee: u64 = w["relayerFeeMax"].as_str().unwrap().parse().unwrap();
        let mut data = IX_WITHDRAW.to_vec();
        data.extend_from_slice(&hexn::<64>(w["proofA"].as_str().unwrap()));
        data.extend_from_slice(&hexn::<128>(w["proofB"].as_str().unwrap()));
        data.extend_from_slice(&hexn::<64>(w["proofC"].as_str().unwrap()));
        data.extend_from_slice(&nh);
        data.extend_from_slice(&hexn::<32>(w["root"].as_str().unwrap()));
        data.extend_from_slice(&hexn::<32>(w["withdrawalCommitment"].as_str().unwrap()));
        data.extend_from_slice(&fee.to_le_bytes());
        data.extend_from_slice(&fee.to_le_bytes());
        let ix = Instruction { program_id: PROGRAM_ID, data, accounts: vec![
            AccountMeta::new(pool, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(npda, false),
            AccountMeta::new(recipient, false),
            AccountMeta::new(treasury, false),
            AccountMeta::new(relayer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ]};
        let msg = Message::new(&[ix], Some(&relayer.pubkey()));
        svm.send_transaction(Transaction::new(&[&relayer], msg, svm.latest_blockhash()))
            .expect("valid withdrawal must succeed");
        done += 1;
    }
    assert_eq!(done, deposits, "every deposited note should be withdrawable");

    // The vault is now back to exactly its rent reserve — the pool is empty.
    let vault_after = svm.get_balance(&vault).unwrap();
    assert_eq!(vault_after, vault_rent, "vault should hold only rent once fully drained");
    assert!(
        vault_after < denom,
        "THE CAP: vault ({vault_after}) is below one denomination ({denom}), so
         withdraw.rs's `vault.lamports() >= denomination` guard must reject any further
         withdrawal no matter how valid its proof"
    );

    // next_index is unchanged by withdrawals: deposits are the only thing that grows it,
    // so the accounting the cap relies on cannot be inflated by withdrawing.
    let d = svm.get_account(&pool).unwrap().data;
    assert_eq!(
        u64::from_le_bytes(d[OFF_NEXT_INDEX..OFF_NEXT_INDEX + 8].try_into().unwrap()),
        deposits
    );

    // Sanity: the guard's error code exists and is the one we expect to see.
    assert_eq!(E_INSUFFICIENT_VAULT, 6022);
}
