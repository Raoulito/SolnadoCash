use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::invoke_signed,
    system_instruction,
};
use solana_program::poseidon::{hashv, Endianness, Parameters};
use groth16_solana::groth16::Groth16Verifier;

use crate::state::{NullifierAccount, NULLIFIER_SIZE, ROOT_HISTORY_SIZE, EMPTY_TREE_ROOT};
use crate::error::ErrorCode;
use crate::vk::WITHDRAW_VK;
use crate::events::WithdrawalEvent;

/// Relayer fees are capped at denomination / MAX_RELAYER_FEE_DIVISOR (= 2%).
/// A withdrawal costs the relayer ~0.0031 SOL at rest, so on a 1 SOL pool this
/// leaves ~6.5x headroom for congestion while making a confiscatory fee
/// unrepresentable on-chain (H-3).
pub const MAX_RELAYER_FEE_DIVISOR: u64 = 50;

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
    // NOTE: nullifier_bump was removed (L-4). The canonical bump is derived on-chain
    // with find_program_address; accepting a caller-supplied bump was dead weight at
    // best and, before it was ignored, allowed a non-canonical PDA and thus a
    // double-spend. Do not reintroduce it.
}

/// Scan root_history to check if root is known.
/// root_history starts at offset 136 (after discriminator) in the pool account data.
fn is_known_root_in_account(pool_info: &AccountInfo, root: &[u8; 32]) -> Result<bool> {
    // Reject zero root — empty history slots are all zeros
    if root == &[0u8; 32] {
        return Ok(false);
    }
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

/// Map a 32-byte Solana pubkey to a single BN254 field element (H-2).
///
/// The previous encoding was `pubkey mod Fr`. Because pubkeys are 256-bit and Fr is
/// ~254-bit, that map is NOT injective: 81% of addresses have a distinct 32-byte
/// alias (`R + Fr`) reducing to the same element. Since the withdrawal commitment
/// binds only the field element, a malicious relayer could pass the alias in the
/// recipient slot — the commitment check still passed, the nullifier was consumed,
/// the relayer kept its fee, and the user's funds landed at an address for which
/// nobody can produce a signature. An irreversible burn.
///
/// The pubkey is now split into its two 128-bit halves (a bijection, both halves
/// are < 2^128 < Fr) and hashed. Finding two addresses with the same field element
/// therefore requires a Poseidon collision (~2^127) rather than one addition.
///
/// This encoding lives entirely OUTSIDE the circuit — `withdraw.circom` consumes
/// `recipient` and `relayerAddress` as opaque field elements — so changing it needs
/// no circuit change, no new trusted setup, and does not invalidate existing notes.
/// The off-chain prover (sdk/src/proof.ts) must use the identical encoding.
fn pubkey_to_field(key: &Pubkey) -> Result<[u8; 32]> {
    let b = key.as_ref();
    let mut hi = [0u8; 32];
    let mut lo = [0u8; 32];
    hi[16..].copy_from_slice(&b[..16]);
    lo[16..].copy_from_slice(&b[16..]);
    Ok(hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[&hi, &lo],
    )
    .map_err(|_| error!(ErrorCode::PoseidonFailed))?
    .0)
}

/// Reject non-canonical field elements (C-1).
///
/// BN254 scalar multiplication is performed modulo the group order Fr, and neither
/// `groth16-solana` nor the `alt_bn128_multiplication` syscall range-checks the
/// scalar: `solana_program` deserialises it with
/// `BigInteger256::deserialize_uncompressed_unchecked` and calls `mul_bigint`.
/// Consequently `x` and `x + k*Fr` yield IDENTICAL curve points and therefore an
/// identical pairing result — the proof verifies for either value.
///
/// That is fatal for `nullifier_hash`, whose raw bytes are used as a PDA seed: an
/// aliased hash verifies against the same proof but derives a DIFFERENT nullifier
/// PDA, bypassing the double-spend guard. Since 2^256 / Fr = 5.29, every honest
/// nullifier hash has 5-6 aliases, i.e. each note could be withdrawn 5-6 times.
///
/// Every public input is therefore required to be in canonical form (< Fr) before
/// the proof is verified. Honest inputs are Poseidon outputs and always satisfy this.
#[inline(always)]
fn is_canonical_fr(be: &[u8; 32]) -> bool {
    let mut i = 0;
    while i < 32 {
        if be[i] < BN254_FR[i] {
            return true;
        }
        if be[i] > BN254_FR[i] {
            return false;
        }
        i += 1;
    }
    // Exactly equal to Fr — congruent to zero, not canonical.
    false
}

pub fn process_withdraw(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: WithdrawArgs,
) -> Result<()> {
    // 0. Verify sufficient accounts passed
    require!(accounts.len() >= 7, ErrorCode::InvalidPoolPda);

    // 0b. C-1: reject non-canonical public inputs BEFORE any other work.
    //     Must precede the root scan, the double-spend check and proof verification,
    //     so an aliased value can never reach a code path that consumes its bytes.
    require!(
        is_canonical_fr(&args.nullifier_hash),
        ErrorCode::NonCanonicalPublicInput
    );
    require!(is_canonical_fr(&args.root), ErrorCode::NonCanonicalPublicInput);
    require!(
        is_canonical_fr(&args.withdrawal_commitment),
        ErrorCode::NonCanonicalPublicInput
    );

    let pool_info      = &accounts[IDX_POOL];
    let vault_info     = &accounts[IDX_VAULT];
    let nullifier_info = &accounts[IDX_NULLIFIER_PDA];
    let recipient_info = &accounts[IDX_RECIPIENT];
    let treasury_info  = &accounts[IDX_TREASURY];
    let relayer_info   = &accounts[IDX_RELAYER];
    let system_program = &accounts[IDX_SYSTEM_PROGRAM];

    // 1a. Verify pool is owned by this program
    require!(*pool_info.owner == *program_id, ErrorCode::InvalidPoolPda);

    // 1b. Verify pool discriminator matches Pool struct
    const POOL_DISCRIMINATOR: [u8; 8] = [0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc];
    {
        let data = pool_info.try_borrow_data()?;
        require!(data.len() >= 8 && data[..8] == POOL_DISCRIMINATOR, ErrorCode::InvalidPoolPda);
    }

    // 1c. Verify system program
    require!(
        *system_program.key == anchor_lang::solana_program::system_program::ID,
        ErrorCode::InvalidSystemProgram
    );

    // 2. Read pool fields directly from account data (no stack allocation)
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

    // 2b. Fee sanity checks (H-3). Cheap arithmetic, so run them before the root
    // scan and Groth16 verification: an invalid fee request is rejected for a few
    // hundred CU instead of ~100k.
    require!(args.relayer_fee_taken <= args.relayer_fee_max, ErrorCode::RelayerFeeExceedsMax);

    // Nothing previously bounded relayer_fee_max: a relayer could quote a ceiling
    // approaching the whole denomination and claim it, and a unit bug in the
    // reference relayer did exactly that. The protocol cannot read a gas oracle,
    // but it can refuse fees that are absurd relative to the denomination. 2% is
    // ~6.5x the real cost of a withdrawal on a 1 SOL pool at rest.
    require!(
        args.relayer_fee_max <= pool_denomination / MAX_RELAYER_FEE_DIVISOR,
        ErrorCode::RelayerFeeMaxTooHigh
    );

    // 3. Verify vault PDA
    let expected_vault = Pubkey::create_program_address(
        &[b"vault", pool_info.key.as_ref(), &[vault_bump]],
        program_id,
    ).map_err(|_| error!(ErrorCode::InvalidVaultPda))?;
    require!(*vault_info.key == expected_vault, ErrorCode::InvalidVaultPda);
    require!(*vault_info.owner == *program_id, ErrorCode::InvalidVaultPda);

    // 4. Verify treasury matches pool
    require!(*treasury_info.key == pool_treasury, ErrorCode::InvalidTreasury);

    // 5. Verify root is recent (scan root_history in-place, no stack allocation).
    //
    // The empty-tree root is rejected outright (L-5). It is seeded into slot 0 of
    // every pool at creation and is byte-identical across every pool of depth 20, so
    // it is the one root that carries no pool-specific meaning. No legitimate
    // withdrawal can use it: a valid leaf in an empty tree would require a Poseidon
    // preimage of zero. Cheap defence against ever making that assumption load-bearing.
    require!(args.root != EMPTY_TREE_ROOT, ErrorCode::RootNotFound);
    let root_found = is_known_root_in_account(pool_info, &args.root)?;
    require!(root_found, ErrorCode::RootNotFound);

    // 6. Verify nullifier PDA does NOT exist (double-spend check)
    require!(nullifier_info.data_is_empty(), ErrorCode::NullifierAlreadySpent);

    // 7. Verify nullifier PDA address is correct (canonical bump only — prevents double-spend)
    let (expected_nullifier, canonical_bump) = Pubkey::find_program_address(
        &[b"nullifier", pool_info.key.as_ref(), &args.nullifier_hash],
        program_id,
    );
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
    //    Pubkeys are mapped to field elements with a collision-resistant encoding
    //    (see pubkey_to_field) so the recipient cannot be swapped for an alias.
    let relayer_field = pubkey_to_field(relayer_info.key)?;
    let recipient_field = pubkey_to_field(recipient_info.key)?;
    let mut fee_max_bytes = [0u8; 32];
    fee_max_bytes[24..].copy_from_slice(&args.relayer_fee_max.to_be_bytes());
    let computed_commitment = hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[&relayer_field, &fee_max_bytes, &recipient_field],
    ).map_err(|_| error!(ErrorCode::PoseidonFailed))?.0;
    require!(computed_commitment == args.withdrawal_commitment, ErrorCode::InvalidWithdrawalCommitment);

    // 11. Compute fees (treasury_fee = denomination / 500)
    let treasury_fee = pool_denomination / 500;
    let user_amount = pool_denomination
        .checked_sub(treasury_fee)
        .and_then(|x| x.checked_sub(args.relayer_fee_taken))
        .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;

    // 11b. The user must actually receive something (H-3).
    require!(user_amount > 0, ErrorCode::UserAmountZero);

    // 12. Account distinctness (M-2).
    //
    // The vault must not also be the recipient, treasury or relayer: those cases
    // would net lamports back into the vault and make the conservation check below
    // meaningless. Duplicate AccountInfos share a lamport cell, so this cannot be
    // caught after the fact by arithmetic alone.
    require!(*recipient_info.key != *vault_info.key, ErrorCode::DuplicateAccount);
    require!(*treasury_info.key != *vault_info.key, ErrorCode::DuplicateAccount);
    require!(*relayer_info.key != *vault_info.key, ErrorCode::DuplicateAccount);

    // 13. Create nullifier PDA via System Program CPI (H-1)
    //
    // `create_account` fails with SystemError::AccountAlreadyInUse when the target
    // already holds lamports. The nullifier PDA address is fully determined by the
    // note, so anyone who learns nullifier_hash before the withdrawal is finalised
    // — the relayer, or a front-runner watching the transaction — could send it
    // 1 lamport and freeze the note PERMANENTLY: no code path could allocate that
    // address afterwards, and nobody holds a key for a PDA.
    //
    // So: fast path when the account is untouched, otherwise top up to the rent
    // minimum and allocate + assign explicitly (the same pattern the SPL
    // Associated Token Account program uses). Both paths end with an account of
    // `nullifier_space` zeroed bytes owned by this program.
    let rent = Rent::get()?;
    let nullifier_space = 8 + NULLIFIER_SIZE;
    let nullifier_lamports = rent.minimum_balance(nullifier_space);
    let nullifier_seeds: &[&[u8]] = &[
        b"nullifier",
        pool_info.key.as_ref(),
        &args.nullifier_hash,
        &[canonical_bump],
    ];
    let existing_lamports = nullifier_info.lamports();

    if existing_lamports == 0 {
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
            &[nullifier_seeds],
        )?;
    } else {
        // Step 6 already proved the account has no data. An account with data but
        // a foreign owner is unreachable here (only this program can sign for the
        // PDA), but assert it rather than rely on that reasoning.
        require!(
            *nullifier_info.owner == anchor_lang::solana_program::system_program::ID,
            ErrorCode::NullifierAlreadySpent
        );

        if existing_lamports < nullifier_lamports {
            // Relayer covers the shortfall; it is already a signer.
            anchor_lang::solana_program::program::invoke(
                &system_instruction::transfer(
                    relayer_info.key,
                    nullifier_info.key,
                    nullifier_lamports - existing_lamports,
                ),
                &[
                    relayer_info.to_account_info(),
                    nullifier_info.to_account_info(),
                    system_program.to_account_info(),
                ],
            )?;
        }

        invoke_signed(
            &system_instruction::allocate(nullifier_info.key, nullifier_space as u64),
            &[
                nullifier_info.to_account_info(),
                system_program.to_account_info(),
            ],
            &[nullifier_seeds],
        )?;

        invoke_signed(
            &system_instruction::assign(nullifier_info.key, program_id),
            &[
                nullifier_info.to_account_info(),
                system_program.to_account_info(),
            ],
            &[nullifier_seeds],
        )?;
    }

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
    require!(vault_info.lamports() >= pool_denomination, ErrorCode::InsufficientVaultBalance);

    // Snapshot for the conservation check below (M-2). The previous "fee invariant"
    // asserted treasury_fee + relayer_fee_taken + user_amount == denomination
    // immediately after computing user_amount as that same difference — trivially
    // true and therefore no protection at all. This instead checks the ledger.
    let vault_before = vault_info.lamports();
    let treasury_before = treasury_info.lamports();
    let relayer_before = relayer_info.lamports();
    let recipient_before = recipient_info.lamports();

    **vault_info.try_borrow_mut_lamports()? -= pool_denomination;
    **treasury_info.try_borrow_mut_lamports()? += treasury_fee;
    **relayer_info.try_borrow_mut_lamports()? += args.relayer_fee_taken;
    **recipient_info.try_borrow_mut_lamports()? += user_amount;

    // Real invariant: the vault paid out exactly one denomination, and every
    // credited account received exactly its share. Catches any future aliasing or
    // arithmetic slip that the tautology could not.
    require!(
        vault_info.lamports() == vault_before - pool_denomination,
        ErrorCode::FeeInvariantViolated
    );
    require!(
        treasury_info.lamports() == treasury_before + treasury_fee,
        ErrorCode::FeeInvariantViolated
    );
    require!(
        relayer_info.lamports() == relayer_before + args.relayer_fee_taken,
        ErrorCode::FeeInvariantViolated
    );
    require!(
        recipient_info.lamports() == recipient_before + user_amount,
        ErrorCode::FeeInvariantViolated
    );

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

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse a 64-char hex string into a 32-byte big-endian array.
    fn be(hex: &str) -> [u8; 32] {
        assert_eq!(hex.len(), 64);
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    const FR_HEX: &str = "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";

    #[test]
    fn fr_constant_matches_known_prime() {
        // Fr = 21888242871839275222246405745257275088548364400416034343698204186575808495617
        assert_eq!(BN254_FR, be(FR_HEX));
    }

    #[test]
    fn zero_is_canonical() {
        assert!(is_canonical_fr(&[0u8; 32]));
    }

    #[test]
    fn fr_minus_one_is_canonical() {
        // …f0000001 - 1 = …f0000000
        let v = be("30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000");
        assert!(is_canonical_fr(&v));
    }

    #[test]
    fn fr_itself_is_not_canonical() {
        // Congruent to zero mod Fr — must be rejected.
        assert!(!is_canonical_fr(&BN254_FR));
    }

    #[test]
    fn fr_plus_one_is_not_canonical() {
        let v = be("30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000002");
        assert!(!is_canonical_fr(&v));
    }

    #[test]
    fn max_u256_is_not_canonical() {
        assert!(!is_canonical_fr(&[0xffu8; 32]));
    }

    #[test]
    fn typical_poseidon_output_is_canonical() {
        // ZEROS[19] — a real Poseidon BN254 digest.
        let v = be("1830ee67b5fb554ad5f63d4388800e1cfe78e310697d46e43c9ce36134f72cca");
        assert!(is_canonical_fr(&v));
    }

    /// The attack this guard exists to stop: h and h + k*Fr are distinct byte
    /// strings (distinct PDA seeds) that Groth16 cannot distinguish. Only the
    /// canonical representative may be accepted.
    ///
    /// The number of in-range aliases depends on h (2^256 / Fr = 5.29), so an
    /// honest hash has 4 or 5 aliases — i.e. 5 or 6 total spends per note without
    /// this check.
    #[test]
    fn aliases_of_a_canonical_hash_are_all_rejected() {
        let h = be("1830ee67b5fb554ad5f63d4388800e1cfe78e310697d46e43c9ce36134f72cca");
        assert!(is_canonical_fr(&h), "base value must be canonical");

        let mut alias = h;
        let mut rejected = 0u32;
        for _ in 1..=5u32 {
            // alias += Fr (big-endian add with carry)
            let mut carry = 0u16;
            for i in (0..32).rev() {
                let sum = alias[i] as u16 + BN254_FR[i] as u16 + carry;
                alias[i] = (sum & 0xff) as u8;
                carry = sum >> 8;
            }
            if carry != 0 {
                break; // alias exceeded 2^256 — no longer expressible in 32 bytes
            }
            assert!(!is_canonical_fr(&alias), "alias h + k*Fr must be rejected");
            assert_ne!(alias, h, "alias must differ from h (different PDA seed)");
            rejected += 1;
        }
        assert!(
            rejected >= 4,
            "expected at least 4 in-range aliases, found {}",
            rejected
        );
    }

    /// The H-2 attack precondition: under the old `pubkey mod Fr` encoding, R and
    /// R + Fr collided. The split-and-hash encoding maps them to different field
    /// elements, so the recipient can no longer be swapped for an alias.
    ///
    /// Runs off-chain only: `hashv` is available in the host build.
    #[test]
    fn pubkey_encoding_separates_fr_aliases() {
        // R and R + Fr — distinct 32-byte addresses, identical under mod-Fr.
        let r = be("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
        let mut alias = r;
        let mut carry = 0u16;
        for i in (0..32).rev() {
            let sum = alias[i] as u16 + BN254_FR[i] as u16 + carry;
            alias[i] = (sum & 0xff) as u8;
            carry = sum >> 8;
        }
        assert_eq!(carry, 0, "alias must fit in 32 bytes");
        assert_ne!(r, alias, "alias must be a different address");

        let fa = pubkey_to_field(&Pubkey::from(r)).unwrap();
        let fb = pubkey_to_field(&Pubkey::from(alias)).unwrap();
        assert_ne!(
            fa, fb,
            "R and R + Fr must map to different field elements"
        );

        // And the encoding output must itself be a canonical field element.
        assert!(is_canonical_fr(&fa));
        assert!(is_canonical_fr(&fb));
    }

    #[test]
    fn pubkey_encoding_is_deterministic() {
        let k = Pubkey::from(be(
            "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
        ));
        assert_eq!(
            pubkey_to_field(&k).unwrap(),
            pubkey_to_field(&k).unwrap(),
            "encoding must be deterministic"
        );
    }

    #[test]
    fn pubkey_encoding_is_sensitive_to_every_byte() {
        // A one-bit change anywhere — including in the high half, which mod-Fr
        // reduction could mask — must change the field element.
        let base = [0u8; 32];
        let f0 = pubkey_to_field(&Pubkey::from(base)).unwrap();
        for i in [0usize, 15, 16, 31] {
            let mut v = base;
            v[i] = 1;
            assert_ne!(
                pubkey_to_field(&Pubkey::from(v)).unwrap(),
                f0,
                "byte {} must affect the encoding",
                i
            );
        }
    }
}
