//! A withdrawal must succeed when the relayer wallet is also the pool treasury.
//!
//! Found in live use, not by any test: the conservation check asserted that the treasury rose by
//! exactly treasury_fee and the relayer by exactly relayer_fee_taken. When both slots are the same
//! account they share one lamport cell, which receives both credits, so the first assertion fails
//! even though the ledger balances to the lamport. Withdrawals were impossible for that
//! configuration and the error was FeeInvariantViolated, which reads as a protocol bug.
//!
//! This is the DEFAULT shape for a solo operator relaying their own withdrawals, which is why it
//! surfaced immediately on a real attempt and never in the suite: every fixture used distinct
//! keys for treasury and relayer.

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
const IX_DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
const IX_WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];

fn hexn<const N: usize>(s: &str) -> [u8; N] {
    let mut out = [0u8; N];
    for i in 0..N {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
    }
    out
}

#[test]
fn withdrawal_succeeds_when_relayer_is_also_the_treasury() {
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

    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        &std::fs::read("../target/deploy/solnadocash.so").expect("run anchor build"),
    );
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000 * 1_000_000_000).unwrap();
    svm.airdrop(&relayer.pubkey(), 1_000 * 1_000_000_000).unwrap();

    // The pool's treasury IS the relayer wallet. This is what a solo operator ends up with.
    let treasury = relayer.pubkey();

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
        AccountMeta::new_readonly(treasury, false),
        AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
    ]};
    let msg = Message::new(&[ix], Some(&admin.pubkey()));
    svm.send_transaction(Transaction::new(&[&admin], msg, svm.latest_blockhash()))
        .expect("pool with treasury == relayer must be creatable");

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

    let recipient: Pubkey = w["recipient"].as_str().unwrap().parse().unwrap();
    let fee: u64 = w["relayerFeeMax"].as_str().unwrap().parse().unwrap();
    let nullifier_hash = hexn::<32>(w["nullifierHash"].as_str().unwrap());
    let (nullifier_pda, _) = Pubkey::find_program_address(
        &[b"nullifier", pool.as_ref(), &nullifier_hash], &PROGRAM_ID);

    let treasury_fee = denom / 500;
    let user_amount = denom - treasury_fee - fee;
    let vault_before_withdraw = svm.get_balance(&vault).unwrap();
    let combined_before = svm.get_balance(&treasury).unwrap();
    let recipient_before = svm.get_balance(&recipient).unwrap_or(0);

    svm.expire_blockhash();
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
        AccountMeta::new(treasury, false),
        AccountMeta::new(relayer.pubkey(), true),
        AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
    ]};
    let msg = Message::new(&[ix], Some(&relayer.pubkey()));
    let result = svm.send_transaction(Transaction::new(&[&relayer], msg, svm.latest_blockhash()));

    match result {
        Ok(_) => {}
        Err(e) => panic!(
            "withdrawal must succeed when treasury == relayer, got {:?}",
            e.err
        ),
    }

    // Conservation across every account the instruction touches. Per-account equality is the
    // wrong assertion here because the relayer, which is this same shared account, additionally
    // funds the nullifier PDA's rent and pays the transaction fee: on the first run this test
    // reported a 640,320 credit against an expected 2,083,000, and the difference was exactly the
    // nullifier rent plus one signature fee. Nothing was wrong with the program; the assertion was
    // naive in the same way the on-chain check had been.
    let vault_after = svm.get_balance(&vault).unwrap();
    let combined_after = svm.get_balance(&treasury).unwrap();
    let recipient_after = svm.get_balance(&recipient).unwrap();
    let nullifier_rent = svm.get_balance(&nullifier_pda).unwrap();
    const SIGNATURE_FEE: u64 = 5_000;

    assert_eq!(
        vault_before_withdraw - vault_after,
        denom,
        "vault must be debited exactly one denomination"
    );
    assert_eq!(
        recipient_after - recipient_before,
        user_amount,
        "recipient must receive exactly its share"
    );
    assert_eq!(
        (vault_before_withdraw + combined_before + recipient_before),
        (vault_after + combined_after + recipient_after + nullifier_rent + SIGNATURE_FEE),
        "lamports must be conserved across vault, shared treasury/relayer, recipient, \
         nullifier rent and the signature fee"
    );

    // And the shared account really did receive both shares, net of what it spent.
    assert_eq!(
        combined_after + nullifier_rent + SIGNATURE_FEE - combined_before,
        treasury_fee + fee,
        "shared treasury/relayer account must receive both shares"
    );
}
