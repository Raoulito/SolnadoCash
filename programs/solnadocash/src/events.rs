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
    // `recipient` was here and is deliberately gone. It put the destination address into the
    // program logs permanently, in the form indexers scrape and resell, which is the cheapest
    // possible input to bulk deposit/withdrawal correlation. It disclosed nothing new in a
    // strict sense, since the recipient is already in the transaction's account list, but there
    // is a real difference between "derivable by parsing every transaction" and "handed over
    // pre-parsed in an event stream". Nothing on-chain needs it, and any off-chain consumer can
    // read it from the accounts.
    pub relayer: Pubkey,
    pub relayer_fee: u64,
    pub treasury_fee: u64,
}

#[event]
pub struct PoolNearSaturation {
    pub pool: Pubkey,
    pub next_index: u64,
}
