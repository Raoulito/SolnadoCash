use anchor_lang::prelude::*;

#[event]
pub struct DepositEvent {
    pub leaf: [u8; 32],
    pub leaf_index: u64,
    pub timestamp: i64,
}

#[event]
pub struct WithdrawalEvent {
    pub nullifier_hash: [u8; 32],
    pub recipient: Pubkey,
    pub relayer: Pubkey,
    pub relayer_fee: u64,
    pub treasury_fee: u64,
}

#[event]
pub struct PoolNearSaturation {
    pub pool: Pubkey,
    pub next_index: u64,
}
