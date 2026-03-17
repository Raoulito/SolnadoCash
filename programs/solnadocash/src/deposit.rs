use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::events::{DepositEvent, PoolNearSaturation};
use crate::error::ErrorCode;
use crate::state::SATURATION_THRESHOLD;
use crate::Deposit;

pub fn handler(ctx: Context<Deposit>, commitment: [u8; 32]) -> Result<()> {
    // Load pool via AccountLoader (zero_copy — no stack allocation)
    let denomination;
    let leaf_index;
    let pool_key = ctx.accounts.pool.key();
    let near_saturation;
    let next_index_after;

    {
        let mut pool = ctx.accounts.pool.load_mut()?;

        // Validate pool PDA seeds using the stored fields + bump
        let expected_pool = Pubkey::create_program_address(
            &[
                b"pool",
                pool.admin.as_ref(),
                pool.mint.as_ref(),
                &pool.denomination.to_le_bytes(),
                &[pool.version],
                &[pool.bump],
            ],
            ctx.program_id,
        ).map_err(|_| error!(ErrorCode::InvalidPoolPda))?;
        require!(
            pool_key == expected_pool,
            ErrorCode::InvalidPoolPda
        );

        denomination = pool.denomination;

        // Insert leaf into Merkle tree (handles is_paused + saturation checks)
        pool.insert(commitment)?;

        leaf_index = pool.next_index - 1;
        next_index_after = pool.next_index;
        near_saturation = next_index_after >= SATURATION_THRESHOLD - 1000;
    } // pool borrow released here

    // Transfer denomination lamports from depositor to vault via CPI
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        denomination,
    )?;

    let timestamp = Clock::get()?.unix_timestamp;

    emit!(DepositEvent {
        leaf: commitment,
        leaf_index,
        timestamp,
    });

    if near_saturation {
        emit!(PoolNearSaturation {
            pool: pool_key,
            next_index: next_index_after,
        });
    }

    Ok(())
}
