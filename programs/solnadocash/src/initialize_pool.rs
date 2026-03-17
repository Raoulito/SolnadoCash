use anchor_lang::prelude::*;
use solana_program::poseidon::{hashv, Endianness, Parameters};

use crate::error::ErrorCode;
use crate::state::{TREE_DEPTH, ROOT_HISTORY_SIZE};
use crate::zeros::ZEROS;
use crate::InitializePool;

pub fn handler(ctx: Context<InitializePool>, denomination: u64, version: u8) -> Result<()> {
    require!(denomination >= 500, ErrorCode::DenominationTooLow);
    require!(version < 255, ErrorCode::VersionTooHigh);

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

    // Initialize filled_subtrees with ZEROS
    for i in 0..TREE_DEPTH {
        pool.filled_subtrees[i] = ZEROS[i];
    }

    // Zero out root_history
    for i in 0..ROOT_HISTORY_SIZE {
        pool.root_history[i] = [0u8; 32];
    }

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
