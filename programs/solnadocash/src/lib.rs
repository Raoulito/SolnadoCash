use anchor_lang::prelude::*;

declare_id!("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");

pub mod error;
pub mod events;
pub mod state;
pub mod zeros;
pub mod vk;
pub mod benchmark;
pub mod initialize_pool;
pub mod deposit;
pub mod withdraw;
pub mod admin;

use crate::state::{Pool, VaultAccount, POOL_SIZE};
use crate::withdraw::WithdrawArgs;
pub use crate::events::*;

#[derive(Accounts)]
pub struct Benchmark {}

// Thin accounts shim for bare-metal withdraw — all validation done in withdraw::process_withdraw
#[derive(Accounts)]
pub struct WithdrawShim<'info> {
    /// CHECK: validated in process_withdraw
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: validated in process_withdraw
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: validated in process_withdraw (nullifier PDA, created atomically)
    #[account(mut)]
    pub nullifier_pda: UncheckedAccount<'info>,
    /// CHECK: validated in process_withdraw
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: validated in process_withdraw (pool.treasury)
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    /// Relayer must be signer and pays nullifier rent
    #[account(mut)]
    pub relayer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(denomination: u64, version: u8)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + POOL_SIZE,
        seeds = [
            b"pool",
            admin.key().as_ref(),
            Pubkey::default().as_ref(),
            &denomination.to_le_bytes(),
            &[version],
        ],
        bump,
    )]
    pub pool: AccountLoader<'info, Pool>,

    #[account(
        init,
        payer = admin,
        space = 8,
        seeds = [b"vault", pool.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    pub treasury: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

// For Deposit, we need to validate the pool PDA seeds using the pool's own fields.
// With AccountLoader we cannot reference pool fields in seeds directly,
// so we use UncheckedAccount and validate in the handler.
#[derive(Accounts)]
pub struct Deposit<'info> {
    /// CHECK: PDA seeds validated in handler using pool.load() fields
    #[account(mut)]
    pub pool: AccountLoader<'info, Pool>,

    #[account(
        mut,
        seeds = [b"vault", pool.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// For AdminPool, the admin constraint is validated in handler
#[derive(Accounts)]
pub struct AdminPool<'info> {
    pub admin: Signer<'info>,

    /// CHECK: admin constraint validated in handler
    #[account(mut)]
    pub pool: AccountLoader<'info, Pool>,
}

#[program]
pub mod solnadocash {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, denomination: u64, version: u8) -> Result<()> {
        initialize_pool::handler(ctx, denomination, version)
    }

    pub fn deposit(ctx: Context<Deposit>, commitment: [u8; 32]) -> Result<()> {
        deposit::handler(ctx, commitment)
    }

    pub fn withdraw(ctx: Context<WithdrawShim>, args: WithdrawArgs) -> Result<()> {
        let accs = [
            ctx.accounts.pool.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.nullifier_pda.to_account_info(),
            ctx.accounts.recipient.to_account_info(),
            ctx.accounts.treasury.to_account_info(),
            ctx.accounts.relayer.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ];
        withdraw::process_withdraw(ctx.program_id, &accs, args)
    }

    pub fn pause_pool(ctx: Context<AdminPool>) -> Result<()> {
        admin::pause_pool_handler(ctx)
    }

    pub fn unpause_pool(ctx: Context<AdminPool>) -> Result<()> {
        admin::unpause_pool_handler(ctx)
    }

    // ── T11: groth16_verify CU benchmark ──────────────────────────────────────
    pub fn benchmark_groth16(_ctx: Context<Benchmark>) -> Result<()> {
        benchmark::run_groth16_benchmark()
    }

    // ── T12: 20-level Poseidon CU benchmark ───────────────────────────────────
    pub fn benchmark_poseidon(_ctx: Context<Benchmark>) -> Result<()> {
        benchmark::run_poseidon_benchmark()
    }
}
