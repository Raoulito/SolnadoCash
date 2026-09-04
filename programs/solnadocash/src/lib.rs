use anchor_lang::prelude::*;

declare_id!("DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59");

/// Like Anchor's `require!`, but the error carries no source location when the
/// `strip-error-origins` feature is enabled.
///
/// Anchor's `require!` expands to `error!(..)`, which calls `.with_source(source!())` and so
/// attaches the filename and line to the error. The runtime then logs
/// "AnchorError thrown in programs/solnadocash/src/withdraw.rs:289", which anyone can read from a
/// transaction simulation.
///
/// Whether that matters is a judgement call, and the default here is to KEEP it. The code is
/// public, the IDL is published, the binary is dumpable, and the error number is in the
/// transaction result whether or not the log says anything, so stripping the origin hides nothing
/// an attacker could not derive. Against that, the file and line are genuinely useful: they
/// pinpointed two live bugs in this program during development. Debuggability wins by default.
///
/// The feature exists for a deployment that would rather not publish the mapping anyway, and for
/// the case where the source is not public. Enabling it costs you the ability to locate a failure
/// from a user's transaction, which is precisely when you most want it.
///
///   cargo build-sbf -- --features strip-error-origins
#[cfg(not(feature = "strip-error-origins"))]
#[macro_export]
macro_rules! guard {
    ($cond:expr, $err:expr) => {
        if !($cond) {
            // Built explicitly rather than delegating to `anchor_lang::require!`. Passing an
            // already-captured `expr` fragment into that macro matches its `$error:tt` arm, which
            // expands to `$crate::ErrorCode::$error` and fails to compile. Constructing the error
            // here avoids the re-parse and is equivalent to what `require!` produces.
            return Err(
                anchor_lang::error::Error::from($err).with_source(anchor_lang::source!())
            );
        }
    };
}

/// Origin-stripped variant. `ErrorCode::X.into()` builds the error through the generated
/// `From` impl, which leaves `error_origin` as `None`, so the log names the error code and message
/// but no file or line. The error NUMBER is unchanged either way, so callers and the relayer's
/// error mapping keep working.
#[cfg(feature = "strip-error-origins")]
#[macro_export]
macro_rules! guard {
    ($cond:expr, $err:expr) => {
        if !($cond) {
            return Err($err.into());
        }
    };
}

pub mod error;
pub mod events;
pub mod state;
pub mod zeros;
pub mod vk;
#[cfg(feature = "benchmark")]
pub mod benchmark;
pub mod initialize_pool;
pub mod deposit;
pub mod withdraw;
pub mod admin;

#[cfg(test)]
mod proptests;

#[cfg(test)]
mod merkle_tests;

use crate::state::{Pool, VaultAccount, POOL_SIZE};
use crate::withdraw::WithdrawArgs;
pub use crate::events::*;

/// Accounts for the CU benchmark instructions.
///
/// Carries `system_program` purely so the struct has an `'info` lifetime. Without it
/// the crate fails to compile under `--features benchmark,cpi`: the `cpi` feature makes
/// `#[program]` generate CPI wrappers that reference `Benchmark<'info>`, while an empty
/// accounts struct has no lifetime parameter (found by `cargo clippy --all-features`).
/// Anchor resolves system_program automatically, so callers pass nothing extra.
#[cfg(feature = "benchmark")]
#[derive(Accounts)]
pub struct Benchmark<'info> {
    pub system_program: Program<'info, System>,
}

// Thin accounts shim for bare-metal withdraw — all validation done in withdraw::process_withdraw
#[derive(Accounts)]
pub struct WithdrawShim<'info> {
    /// CHECK: validated in process_withdraw (owner + Pool discriminator).
    /// Deliberately NOT `mut` (F-4): withdraw only reads pool fields and the root
    /// history — the sole mutable data borrow in the instruction is the nullifier
    /// account. Granting a write capability the instruction never uses would let a
    /// later edit mutate pool state without that showing up in the account
    /// declaration. Callers may still pass it writable; nothing breaks.
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
        // Named fields rather than a positional array (F-7): the previous form built a
        // `[AccountInfo; 7]` here whose order had to match a set of index constants in
        // withdraw.rs, enforced only by a comment on both sides.
        withdraw::process_withdraw(
            ctx.program_id,
            withdraw::WithdrawAccounts {
                pool: ctx.accounts.pool.to_account_info(),
                vault: ctx.accounts.vault.to_account_info(),
                nullifier_pda: ctx.accounts.nullifier_pda.to_account_info(),
                recipient: ctx.accounts.recipient.to_account_info(),
                treasury: ctx.accounts.treasury.to_account_info(),
                relayer: ctx.accounts.relayer.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            args,
        )
    }

    pub fn pause_pool(ctx: Context<AdminPool>) -> Result<()> {
        admin::pause_pool_handler(ctx)
    }

    pub fn unpause_pool(ctx: Context<AdminPool>) -> Result<()> {
        admin::unpause_pool_handler(ctx)
    }

    // ── T11/T12: CU benchmarks (L-7) ──────────────────────────────────────────
    // Gated behind the `benchmark` feature. These were reachable in every build,
    // so a production deployment carried two instructions that exist only to
    // measure compute units — dead entrypoints and needless attack surface.
    // Build with: anchor build -- --features benchmark
    #[cfg(feature = "benchmark")]
    pub fn benchmark_groth16(_ctx: Context<Benchmark>) -> Result<()> {
        benchmark::run_groth16_benchmark()
    }

    #[cfg(feature = "benchmark")]
    pub fn benchmark_poseidon(_ctx: Context<Benchmark>) -> Result<()> {
        benchmark::run_poseidon_benchmark()
    }
}
