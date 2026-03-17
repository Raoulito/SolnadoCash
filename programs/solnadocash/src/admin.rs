use anchor_lang::prelude::*;

use crate::error::ErrorCode;
use crate::AdminPool;

pub fn pause_pool_handler(ctx: Context<AdminPool>) -> Result<()> {
    let mut pool = ctx.accounts.pool.load_mut()?;
    // Validate admin
    require!(pool.admin == ctx.accounts.admin.key(), ErrorCode::InvalidPoolPda);
    pool.is_paused = 1;
    Ok(())
}

pub fn unpause_pool_handler(ctx: Context<AdminPool>) -> Result<()> {
    let mut pool = ctx.accounts.pool.load_mut()?;
    // Validate admin
    require!(pool.admin == ctx.accounts.admin.key(), ErrorCode::InvalidPoolPda);
    pool.is_paused = 0;
    Ok(())
}
