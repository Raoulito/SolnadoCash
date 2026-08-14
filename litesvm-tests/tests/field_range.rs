//! Field-range enforcement on the DEPOSIT path.
//!
//! `deposit` takes a raw [u8; 32] commitment straight from the caller and feeds it to the
//! Poseidon syscall as a field element. Nothing in the program range-checks it, so the
//! question is whether sol_poseidon itself rejects a value >= Fr or silently reduces it.
//!
//! It matters because if the syscall reduced instead of rejecting, then commitment C and
//! C + Fr would be distinct 32-byte leaves that hash identically — two tree entries with
//! one field identity. That is the same class of bug as C-1 (non-canonical public inputs),
//! just on the deposit side.
//!
//! Verified here rather than assumed, because the answer lives in the validator's syscall
//! implementation, not in this codebase.

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
const DENOMINATION: u64 = 1_000_000_000;
const OFF_NEXT_INDEX: usize = 8 + 80;

/// BN254 scalar field modulus, big-endian.
const FR: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

struct Fx {
    svm: LiteSVM,
    admin: Keypair,
    pool: Pubkey,
    vault: Pubkey,
}

fn setup() -> Fx {
    let mut svm = LiteSVM::new();
    svm.add_program(
        PROGRAM_ID,
        &std::fs::read("../target/deploy/solnadocash.so").expect("run anchor build"),
    );
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000 * 1_000_000_000).unwrap();
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

    let mut data = IX_INITIALIZE_POOL.to_vec();
    data.extend_from_slice(&DENOMINATION.to_le_bytes());
    data.push(0u8);
    let ix = Instruction {
        program_id: PROGRAM_ID,
        data,
        accounts: vec![
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new(pool, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(treasury, false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
    };
    let msg = Message::new(&[ix], Some(&admin.pubkey()));
    svm.send_transaction(Transaction::new(&[&admin], msg, svm.latest_blockhash()))
        .expect("initialize_pool");

    Fx { svm, admin, pool, vault }
}

impl Fx {
    fn deposit(&mut self, commitment: [u8; 32]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let mut data = IX_DEPOSIT.to_vec();
        data.extend_from_slice(&commitment);
        let ix = Instruction {
            program_id: PROGRAM_ID,
            data,
            accounts: vec![
                AccountMeta::new(self.pool, false),
                AccountMeta::new(self.vault, false),
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            ],
        };
        let msg = Message::new(&[ix], Some(&self.admin.pubkey()));
        let tx = Transaction::new(&[&self.admin], msg, self.svm.latest_blockhash());
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}", e.err))
    }

    fn next_index(&self) -> u64 {
        let d = self.svm.get_account(&self.pool).unwrap().data;
        u64::from_le_bytes(d[OFF_NEXT_INDEX..OFF_NEXT_INDEX + 8].try_into().unwrap())
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

#[test]
fn canonical_commitment_is_accepted() {
    let mut fx = setup();
    let mut c = [0u8; 32];
    c[31] = 42; // small, unambiguously < Fr
    fx.deposit(c).expect("a canonical commitment must be accepted");
    assert_eq!(fx.next_index(), 1);
}

#[test]
fn commitment_equal_to_fr_is_rejected_by_the_syscall() {
    let mut fx = setup();
    let before = fx.next_index();
    let r = fx.deposit(FR);
    assert!(
        r.is_err(),
        "a commitment equal to Fr was ACCEPTED — the Poseidon syscall reduces instead of \
         rejecting, so C and C+Fr are distinct leaves with one field identity (the C-1 \
         bug class on the deposit path)"
    );
    assert_eq!(fx.next_index(), before, "a rejected deposit must not move next_index");
}

#[test]
fn commitment_above_fr_is_rejected_by_the_syscall() {
    let mut fx = setup();
    // All-ones = 2^256 - 1, far above Fr.
    let r = fx.deposit([0xffu8; 32]);
    assert!(r.is_err(), "a commitment of 2^256-1 was ACCEPTED as a field element");

    // And a specific alias of a legitimate small leaf.
    let mut small = [0u8; 32];
    small[31] = 5;
    if let Some(alias) = add_fr(&small) {
        let r2 = fx.deposit(alias);
        assert!(
            r2.is_err(),
            "commitment 5 + Fr was ACCEPTED — it would collide with leaf 5 under \
             modular reduction"
        );
    }
}

#[test]
fn rejected_deposit_moves_no_funds() {
    // A rejected deposit must be fully atomic: no leaf, no lamports.
    let mut fx = setup();
    let vault_before = fx.svm.get_balance(&fx.vault).unwrap();
    let idx_before = fx.next_index();
    let _ = fx.deposit([0xffu8; 32]);
    assert_eq!(fx.svm.get_balance(&fx.vault).unwrap(), vault_before, "vault changed");
    assert_eq!(fx.next_index(), idx_before, "next_index changed");
}
