use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::invoke_signed,
    system_instruction,
};
use solana_program::poseidon::{hashv, Endianness, Parameters};
use groth16_solana::groth16::Groth16Verifier;

use crate::state::{NullifierAccount, NULLIFIER_SIZE, ROOT_HISTORY_SIZE};
use crate::error::ErrorCode;
use crate::vk::WITHDRAW_VK;
use crate::events::WithdrawalEvent;

// Account indices (MUST match lib.rs WithdrawShim order)
const IDX_POOL: usize = 0;
const IDX_VAULT: usize = 1;
const IDX_NULLIFIER_PDA: usize = 2;
const IDX_RECIPIENT: usize = 3;
const IDX_TREASURY: usize = 4;
const IDX_RELAYER: usize = 5;
const IDX_SYSTEM_PROGRAM: usize = 6;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct WithdrawArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub nullifier_hash: [u8; 32],
    pub root: [u8; 32],
    pub withdrawal_commitment: [u8; 32],
    pub relayer_fee_max: u64,
    pub relayer_fee_taken: u64,
    pub nullifier_bump: u8,
}

/// Read pool fields directly from account data bytes.
/// Pool layout (after 8-byte discriminator, matching state.rs #[repr(C)]):
///   offset 0:   admin (32 bytes)
///   offset 32:  mint (32 bytes)
///   offset 64:  denomination (8 bytes, u64 LE)
///   offset 72:  mint_decimals (1 byte)
///   offset 73:  _pad0 (7 bytes)
///   offset 80:  next_index (8 bytes)
///   offset 88:  treasury (32 bytes)
///   offset 120: version (1 byte)
///   offset 121: bump (1 byte)
///   offset 122: vault_bump (1 byte)
///   offset 123: is_paused (1 byte)
///   offset 124: _pad1 (4 bytes)
///   offset 128: current_root_index (8 bytes)
///   offset 136: root_history (8192 bytes)
///   offset 8328: filled_subtrees (640 bytes)
fn read_pool_fields(pool_info: &AccountInfo) -> Result<(u8, Pubkey, u64, bool)> {
    let data = pool_info.try_borrow_data()?;
    // Skip 8-byte anchor discriminator
    let d = &data[8..];
    if d.len() < 128 + 8192 {
        return Err(error!(ErrorCode::InvalidPoolPda));
    }

    // vault_bump at offset 122
    let vault_bump = d[122];
    // treasury at offset 88
    let treasury = Pubkey::try_from(&d[88..120]).map_err(|_| error!(ErrorCode::InvalidPoolPda))?;
    // denomination at offset 64
    let denomination = u64::from_le_bytes(d[64..72].try_into().map_err(|_| error!(ErrorCode::InvalidPoolPda))?);
    // current_root_index at offset 128
    let current_root_index = u64::from_le_bytes(d[128..136].try_into().map_err(|_| error!(ErrorCode::InvalidPoolPda))?) as usize;

    // Check root history — root_history starts at offset 136
    // Each entry is 32 bytes; we scan all ROOT_HISTORY_SIZE entries
    Ok((vault_bump, treasury, denomination, current_root_index as u8 > 0)) // placeholder
}

/// Scan root_history to check if root is known.
/// root_history starts at offset 136 (after discriminator) in the pool account data.
fn is_known_root_in_account(pool_info: &AccountInfo, root: &[u8; 32]) -> Result<bool> {
    let data = pool_info.try_borrow_data()?;
    let d = &data[8..]; // skip discriminator
    // root_history at offset 136, ROOT_HISTORY_SIZE entries of 32 bytes each
    const ROOT_HISTORY_OFFSET: usize = 136;
    if d.len() < ROOT_HISTORY_OFFSET + ROOT_HISTORY_SIZE * 32 {
        return Err(error!(ErrorCode::InvalidPoolPda));
    }
    for i in 0..ROOT_HISTORY_SIZE {
        let entry_start = ROOT_HISTORY_OFFSET + i * 32;
        let entry = &d[entry_start..entry_start + 32];
        if entry == root.as_slice() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// BN254 scalar field prime (Fr).
/// Solana pubkeys are 32 bytes (256 bits) and can exceed this ~254-bit prime.
/// sol_poseidon BN254X5 operates over Fr and rejects inputs >= Fr.
/// Both the circom circuit and sol_poseidon must use the same field.
const BN254_FR: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
    0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// Reduce a 32-byte big-endian value mod BN254_Fr.
/// Solana pubkey bytes interpreted as big-endian can be up to 2^256-1.
/// Since 2^256 / Fr ≈ 5.29, we need at most 5 subtractions.
fn reduce_mod_fr(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes);
    for _ in 0..5 {
        let mut ge = true;
        for i in 0..32 {
            if out[i] < BN254_FR[i] {
                ge = false;
                break;
            } else if out[i] > BN254_FR[i] {
                break;
            }
        }
        if !ge {
            return out;
        }
        // Subtract Fr (big-endian)
        let mut borrow: u16 = 0;
        let prev = out;
        for i in (0..32).rev() {
            let a = prev[i] as u16;
            let b = BN254_FR[i] as u16 + borrow;
            if a >= b {
                out[i] = (a - b) as u8;
                borrow = 0;
            } else {
                out[i] = (256 + a - b) as u8;
                borrow = 1;
            }
        }
    }
    out
}

pub fn process_withdraw(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: WithdrawArgs,
) -> Result<()> {
    let pool_info      = &accounts[IDX_POOL];
    let vault_info     = &accounts[IDX_VAULT];
    let nullifier_info = &accounts[IDX_NULLIFIER_PDA];
    let recipient_info = &accounts[IDX_RECIPIENT];
    let treasury_info  = &accounts[IDX_TREASURY];
    let relayer_info   = &accounts[IDX_RELAYER];
    let system_program = &accounts[IDX_SYSTEM_PROGRAM];

    // 1. Read pool fields directly from account data (no stack allocation)
    let vault_bump: u8;
    let pool_treasury: Pubkey;
    let pool_denomination: u64;

    {
        let data = pool_info.try_borrow_data()?;
        let d = &data[8..]; // skip 8-byte discriminator
        if d.len() < 136 {
            return Err(error!(ErrorCode::InvalidPoolPda));
        }
        // vault_bump at d[122]
        vault_bump = d[122];
        // treasury at d[88..120]
        let mut treas_bytes = [0u8; 32];
        treas_bytes.copy_from_slice(&d[88..120]);
        pool_treasury = Pubkey::from(treas_bytes);
        // denomination at d[64..72]
        let mut denom_bytes = [0u8; 8];
        denom_bytes.copy_from_slice(&d[64..72]);
        pool_denomination = u64::from_le_bytes(denom_bytes);
    }

    // 2. Verify relayer is signer
    require!(relayer_info.is_signer, ErrorCode::RelayerNotSigner);

    // 3. Verify vault PDA
    let expected_vault = Pubkey::create_program_address(
        &[b"vault", pool_info.key.as_ref(), &[vault_bump]],
        program_id,
    ).map_err(|_| error!(ErrorCode::InvalidVaultPda))?;
    require!(*vault_info.key == expected_vault, ErrorCode::InvalidVaultPda);

    // 4. Verify treasury matches pool
    require!(*treasury_info.key == pool_treasury, ErrorCode::InvalidTreasury);

    // 5. Verify root is recent (scan root_history in-place, no stack allocation)
    let root_found = is_known_root_in_account(pool_info, &args.root)?;
    require!(root_found, ErrorCode::RootNotFound);

    // 6. Verify nullifier PDA does NOT exist (double-spend check)
    require!(nullifier_info.data_is_empty(), ErrorCode::NullifierAlreadySpent);

    // 7. Verify nullifier PDA address is correct
    let expected_nullifier = Pubkey::create_program_address(
        &[b"nullifier", pool_info.key.as_ref(), &args.nullifier_hash, &[args.nullifier_bump]],
        program_id,
    ).map_err(|_| error!(ErrorCode::InvalidPoolPda))?;
    require!(*nullifier_info.key == expected_nullifier, ErrorCode::InvalidPoolPda);

    // 8. Groth16 proof verification
    let public_inputs = [args.nullifier_hash, args.root, args.withdrawal_commitment];
    let mut verifier = Groth16Verifier::new(
        &args.proof_a,
        &args.proof_b,
        &args.proof_c,
        &public_inputs,
        &WITHDRAW_VK,
    ).map_err(|_| error!(ErrorCode::ProofDeserializationFailed))?;

    verifier.verify().map_err(|_| error!(ErrorCode::InvalidProof))?;

    // 9. Verify withdrawal_commitment = Poseidon(relayer, relayer_fee_max, recipient)
    //    Pubkey bytes (32 bytes big-endian) may exceed BN254_Fq, so we reduce mod Fq
    //    before passing to sol_poseidon. Both on-chain and off-chain must agree.
    let relayer_field = reduce_mod_fr(relayer_info.key.as_ref());
    let recipient_field = reduce_mod_fr(recipient_info.key.as_ref());
    let mut fee_max_bytes = [0u8; 32];
    fee_max_bytes[24..].copy_from_slice(&args.relayer_fee_max.to_be_bytes());
    let computed_commitment = hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[&relayer_field, &fee_max_bytes, &recipient_field],
    ).map_err(|_| error!(ErrorCode::PoseidonFailed))?.0;
    require!(computed_commitment == args.withdrawal_commitment, ErrorCode::InvalidWithdrawalCommitment);

    // 10. Verify relayer_fee_taken <= relayer_fee_max
    require!(args.relayer_fee_taken <= args.relayer_fee_max, ErrorCode::RelayerFeeExceedsMax);

    // 11. Compute fees (treasury_fee = denomination / 500)
    let treasury_fee = pool_denomination / 500;
    let user_amount = pool_denomination
        .checked_sub(treasury_fee)
        .and_then(|x| x.checked_sub(args.relayer_fee_taken))
        .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;

    // 12. Fee invariant check
    require!(
        treasury_fee + args.relayer_fee_taken + user_amount == pool_denomination,
        ErrorCode::FeeInvariantViolated
    );

    // 13. Create nullifier PDA via System Program CPI
    let rent = Rent::get()?;
    let nullifier_space = 8 + NULLIFIER_SIZE;
    let nullifier_lamports = rent.minimum_balance(nullifier_space);

    invoke_signed(
        &system_instruction::create_account(
            relayer_info.key,
            nullifier_info.key,
            nullifier_lamports,
            nullifier_space as u64,
            program_id,
        ),
        &[
            relayer_info.to_account_info(),
            nullifier_info.to_account_info(),
            system_program.to_account_info(),
        ],
        &[&[b"nullifier", pool_info.key.as_ref(), &args.nullifier_hash, &[args.nullifier_bump]]],
    )?;

    // 14. Write nullifier account data
    let nullifier_account = NullifierAccount {
        pool: *pool_info.key,
        nullifier_hash: args.nullifier_hash,
        slot: Clock::get()?.slot,
    };
    use anchor_lang::AccountSerialize;
    let mut nullifier_data = nullifier_info.try_borrow_mut_data()?;
    nullifier_account.try_serialize(&mut &mut nullifier_data[..])?;
    drop(nullifier_data);

    // 15. Direct lamport mutation for SOL transfers (vault is program-owned PDA)
    **vault_info.try_borrow_mut_lamports()? -= pool_denomination;
    **treasury_info.try_borrow_mut_lamports()? += treasury_fee;
    **relayer_info.try_borrow_mut_lamports()? += args.relayer_fee_taken;
    **recipient_info.try_borrow_mut_lamports()? += user_amount;

    // 16. Emit withdrawal event
    emit!(WithdrawalEvent {
        nullifier_hash: args.nullifier_hash,
        recipient: *recipient_info.key,
        relayer: *relayer_info.key,
        relayer_fee: args.relayer_fee_taken,
        treasury_fee,
    });

    Ok(())
}
