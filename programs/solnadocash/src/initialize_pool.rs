use anchor_lang::prelude::*;
use solana_program::poseidon::{hashv, Endianness, Parameters};

use crate::error::ErrorCode;
use crate::state::{TREE_DEPTH, ROOT_HISTORY_SIZE};
use crate::zeros::ZEROS;
use crate::withdraw::MAX_RELAYER_FEE_DIVISOR;
use crate::InitializePool;

pub fn handler(ctx: Context<InitializePool>, denomination: u64, version: u8) -> Result<()> {
    require!(denomination >= 500, ErrorCode::DenominationTooLow);
    require!(version < 255, ErrorCode::VersionTooHigh);

    // N-3: a pool must not accept deposits that cannot be withdrawn privately.
    //
    // Solana's runtime rejects any transaction that leaves an account below its
    // rent-exempt minimum. A withdrawal pays `user_amount` to the recipient, and
    // privacy requires that recipient to be a FRESH address — i.e. a 0-byte account
    // being created by the payout itself. So the worst-case user amount (both fees at
    // maximum) must clear rent.minimum_balance(0), measured at 890_880 lamports.
    //
    // Below that floor the withdrawal is rejected by the runtime before this program
    // runs, so nothing surfaces the real cause, and the deposit is strandable: the
    // only escape is paying out to an already-funded address, which reveals the link
    // the protocol exists to break.
    //
    // BF-14's 500-lamport minimum is ~1822x too low. Derived from the live rent
    // sysvar rather than a constant so it tracks cluster parameters.
    let rent = Rent::get()?;
    let min_recipient_balance = rent.minimum_balance(0);
    let worst_case_user_amount = denomination
        .checked_sub(denomination / 500) // treasury fee
        .and_then(|x| x.checked_sub(denomination / MAX_RELAYER_FEE_DIVISOR)) // max relayer fee
        .ok_or_else(|| error!(ErrorCode::DenominationTooLow))?;
    require!(
        worst_case_user_amount >= min_recipient_balance,
        ErrorCode::DenominationTooLow
    );

    let mut pool = ctx.accounts.pool.load_init()?;

    pool.admin = ctx.accounts.admin.key();
    pool.mint = Pubkey::default();
    pool.denomination = denomination;
    pool.mint_decimals = 9;
    pool.next_index = 0;
    pool.treasury = ctx.accounts.treasury.key();
    pool.version = version;
    pool.bump = ctx.bumps.pool;
    pool.vault_bump = ctx.bumps.vault;
    pool.is_paused = 0; // false
    pool.current_root_index = 0;
    pool._pad0 = [0u8; 7];
    pool._pad1 = [0u8; 4];

    // Initialize filled_subtrees with ZEROS. Same type ([[u8; 32]; TREE_DEPTH]), so a
    // whole-array assignment — clearer and cheaper than an indexed loop.
    pool.filled_subtrees = ZEROS;

    // Zero out root_history
    pool.root_history = [[0u8; 32]; ROOT_HISTORY_SIZE];

    // Compute initial root = hashv(ZEROS[TREE_DEPTH-1], ZEROS[TREE_DEPTH-1])
    let initial_root = hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[&ZEROS[TREE_DEPTH - 1], &ZEROS[TREE_DEPTH - 1]],
    )
    .map_err(|_| error!(ErrorCode::PoseidonFailed))?
    .0;

    pool.root_history[0] = initial_root;

    Ok(())
}
