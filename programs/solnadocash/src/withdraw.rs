use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::invoke_signed,
    system_instruction,
};
use solana_program::poseidon::{hashv, Endianness, Parameters};
use groth16_solana::groth16::Groth16Verifier;

use crate::state::{
    NullifierAccount, DISCRIMINATOR_LEN, EMPTY_TREE_ROOT, NULLIFIER_SIZE, OFF_DENOMINATION,
    OFF_ROOT_HISTORY, OFF_TREASURY, OFF_VAULT_BUMP, POOL_DISCRIMINATOR, ROOT_HISTORY_SIZE,
};
use crate::error::ErrorCode;
use crate::vk::WITHDRAW_VK;
use crate::events::WithdrawalEvent;

/// Relayer fees are capped at denomination / MAX_RELAYER_FEE_DIVISOR (= 2%).
/// A withdrawal costs the relayer ~0.0031 SOL at rest, so on a 1 SOL pool this
/// leaves ~6.5x headroom for congestion while making a confiscatory fee
/// unrepresentable on-chain (H-3).
pub const MAX_RELAYER_FEE_DIVISOR: u64 = 50;

/// Split a denomination into (treasury_fee, relayer_fee, user_amount), enforcing every
/// fee rule. Pure so it can be property-tested directly (see proptests.rs) rather than
/// through a mirrored copy that could silently drift from this logic.
///
/// Returns Err for any input the withdrawal must reject.
pub fn compute_fee_split(
    denomination: u64,
    relayer_fee_taken: u64,
    relayer_fee_max: u64,
) -> Result<(u64, u64, u64)> {
    crate::guard!(relayer_fee_taken <= relayer_fee_max, ErrorCode::RelayerFeeExceedsMax);
    crate::guard!(
        relayer_fee_max <= denomination / MAX_RELAYER_FEE_DIVISOR,
        ErrorCode::RelayerFeeMaxTooHigh
    );

    let treasury_fee = denomination / 500;
    let user_amount = denomination
        .checked_sub(treasury_fee)
        .and_then(|x| x.checked_sub(relayer_fee_taken))
        .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;
    crate::guard!(user_amount > 0, ErrorCode::UserAmountZero);

    Ok((treasury_fee, relayer_fee_taken, user_amount))
}

/// Worst-case amount a recipient receives: both fees at their maximum. Used by
/// initialize_pool to reject denominations whose payout could not clear the runtime's
/// rent floor for a fresh account (N-3).
pub fn worst_case_user_amount(denomination: u64) -> Option<u64> {
    denomination
        .checked_sub(denomination / 500)
        .and_then(|x| x.checked_sub(denomination / MAX_RELAYER_FEE_DIVISOR))
}

/// Named account bindings for `process_withdraw` (F-7).
///
/// These arrived as a `&[AccountInfo]` indexed by `IDX_POOL`, `IDX_VAULT` and so on, and the only
/// thing keeping those indices aligned with `WithdrawShim`'s field order was a comment saying they
/// must be. Reordering either list compiled cleanly and silently reassigned every account role.
///
/// Most such swaps do fail closed — the pool owner and discriminator checks, the vault PDA
/// derivation, the `pool.treasury` equality check and the withdrawal-commitment recomputation each
/// reject an account in the wrong slot — so this was a denial-of-service risk on the critical
/// instruction rather than a theft risk. Naming the fields removes the class instead of relying on
/// those checks to catch it, and costs nothing: `AccountInfo` is a handful of references, the
/// caller was already cloning them into an array, and the compiler now rejects a mismatch.
pub struct WithdrawAccounts<'info> {
    pub pool: AccountInfo<'info>,
    pub vault: AccountInfo<'info>,
    pub nullifier_pda: AccountInfo<'info>,
    pub recipient: AccountInfo<'info>,
    pub treasury: AccountInfo<'info>,
    pub relayer: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
}

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
///
/// Reads the ring straight out of the account bytes rather than through `AccountLoader`, using
/// the offsets pinned in `state.rs` (F-6). `Pool` is 8,968 bytes; deserialising it to check one
/// root would cost the stack and the CU that the bare-metal path exists to avoid.
fn is_known_root_in_account(pool_info: &AccountInfo, root: &[u8; 32]) -> Result<bool> {
    // Reject zero root — empty history slots are all zeros
    if root == &[0u8; 32] {
        return Ok(false);
    }
    let data = pool_info.try_borrow_data()?;
    let d = &data[DISCRIMINATOR_LEN..]; // skip discriminator
    if d.len() < OFF_ROOT_HISTORY + ROOT_HISTORY_SIZE * 32 {
        return Err(error!(ErrorCode::InvalidPoolPda));
    }
    for i in 0..ROOT_HISTORY_SIZE {
        let entry_start = OFF_ROOT_HISTORY + i * 32;
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
pub(crate) const BN254_FR: [u8; 32] = [
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
pub(crate) fn pubkey_to_field(key: &Pubkey) -> Result<[u8; 32]> {
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
pub(crate) fn is_canonical_fr(be: &[u8; 32]) -> bool {
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
    accounts: WithdrawAccounts,
    args: WithdrawArgs,
) -> Result<()> {
    // 0. C-1: reject non-canonical public inputs BEFORE any other work.
    //    Must precede the root scan, the double-spend check and proof verification,
    //    so an aliased value can never reach a code path that consumes its bytes.
    //
    //    The arity check that used to stand here is gone with the index constants (F-7):
    //    `WithdrawAccounts` cannot be constructed with a missing account.
    crate::guard!(
        is_canonical_fr(&args.nullifier_hash),
        ErrorCode::NonCanonicalPublicInput
    );
    crate::guard!(is_canonical_fr(&args.root), ErrorCode::NonCanonicalPublicInput);
    crate::guard!(
        is_canonical_fr(&args.withdrawal_commitment),
        ErrorCode::NonCanonicalPublicInput
    );

    let pool_info      = &accounts.pool;
    let vault_info     = &accounts.vault;
    let nullifier_info = &accounts.nullifier_pda;
    let recipient_info = &accounts.recipient;
    let treasury_info  = &accounts.treasury;
    let relayer_info   = &accounts.relayer;
    let system_program = &accounts.system_program;

    // 1a. Verify pool is owned by this program
    crate::guard!(*pool_info.owner == *program_id, ErrorCode::InvalidPoolPda);

    // 1b. Verify pool discriminator matches Pool struct. The constant is pinned against
    //     Anchor's derived value at compile time in state.rs (F-6).
    {
        let data = pool_info.try_borrow_data()?;
        crate::guard!(
            data.len() >= DISCRIMINATOR_LEN && data[..DISCRIMINATOR_LEN] == POOL_DISCRIMINATOR,
            ErrorCode::InvalidPoolPda
        );
    }

    // 1c. Verify system program
    crate::guard!(
        *system_program.key == anchor_lang::solana_program::system_program::ID,
        ErrorCode::InvalidSystemProgram
    );

    // 2. Read pool fields directly from account data (no stack allocation).
    //    Offsets come from state.rs and are asserted against the struct at compile time (F-6),
    //    so a field moving breaks the build rather than silently repointing these reads.
    let vault_bump: u8;
    let pool_treasury: Pubkey;
    let pool_denomination: u64;

    {
        let data = pool_info.try_borrow_data()?;
        let d = &data[DISCRIMINATOR_LEN..]; // skip 8-byte discriminator
        if d.len() < OFF_ROOT_HISTORY {
            return Err(error!(ErrorCode::InvalidPoolPda));
        }
        vault_bump = d[OFF_VAULT_BUMP];
        let mut treas_bytes = [0u8; 32];
        treas_bytes.copy_from_slice(&d[OFF_TREASURY..OFF_TREASURY + 32]);
        pool_treasury = Pubkey::from(treas_bytes);
        let mut denom_bytes = [0u8; 8];
        denom_bytes.copy_from_slice(&d[OFF_DENOMINATION..OFF_DENOMINATION + 8]);
        pool_denomination = u64::from_le_bytes(denom_bytes);
    }

    // 2. Verify relayer is signer
    crate::guard!(relayer_info.is_signer, ErrorCode::RelayerNotSigner);

    // 2b. Fee sanity checks (H-3). Cheap arithmetic, so run them before the root
    // scan and Groth16 verification: an invalid fee request is rejected for a few
    // hundred CU instead of ~100k.
    // Nothing previously bounded relayer_fee_max: a relayer could quote a ceiling
    // approaching the whole denomination and claim it, and a unit bug in the
    // reference relayer did exactly that. The protocol cannot read a gas oracle,
    // but it can refuse fees that are absurd relative to the denomination. 2% is
    // ~6.5x the real cost of a withdrawal on a 1 SOL pool at rest.
    //
    // compute_fee_split enforces fee_taken <= fee_max, the 2% cap, and user_amount > 0.
    // Called here (before the root scan and Groth16 verify) so a bad fee costs a few
    // hundred CU instead of ~100k.
    let (treasury_fee, _, user_amount) =
        compute_fee_split(pool_denomination, args.relayer_fee_taken, args.relayer_fee_max)?;

    // 2c. Account distinctness (M-2, F-5, SEC-06).
    //
    // Seven public-key comparisons, and they used to sit after Groth16 verification. That is the
    // wrong way round by the same argument the fee checks above are made early: these are the
    // cheapest checks in the instruction and they were gated behind its most expensive operation, so
    // a request with an unusable account set paid ~100k CU to be told so. They depend only on the
    // keys that were passed, all of which are available here.
    //
    // Comparing against the vault key before step 3 has validated it is sound: if a forged vault is
    // passed, step 3 rejects it regardless, and if the real vault is passed these comparisons see
    // the real vault.
    //
    // The vault must not also be the recipient, treasury or relayer: those cases
    // would net lamports back into the vault and make the conservation check below
    // meaningless. Duplicate AccountInfos share a lamport cell, so this cannot be
    // caught after the fact by arithmetic alone.
    crate::guard!(*recipient_info.key != *vault_info.key, ErrorCode::DuplicateAccount);
    crate::guard!(*treasury_info.key != *vault_info.key, ErrorCode::DuplicateAccount);
    crate::guard!(*relayer_info.key != *vault_info.key, ErrorCode::DuplicateAccount);

    // No payout target may be the nullifier PDA either (F-5). This program creates that
    // account moments later, so crediting it locks the funds permanently: the account ends
    // up program-owned with no instruction that can move lamports out of it.
    //
    // The treasury case is the one reachable by someone other than the payee. A pool
    // creator can set `treasury` to the PDA that a chosen nullifier hash will later occupy
    // — it is system-owned and empty at creation, so the SystemAccount constraint accepts
    // it — and every withdrawal spending that note would burn the protocol fee. The
    // recipient and relayer cases are self-inflicted, but the check costs one comparison
    // each and removes the whole class.
    //
    // Note `is_on_curve()` cannot be used to reject PDAs generally: it is
    // `unimplemented!()` under target_os = "solana" and panics on-chain.
    crate::guard!(*treasury_info.key != *nullifier_info.key, ErrorCode::DuplicateAccount);
    crate::guard!(*recipient_info.key != *nullifier_info.key, ErrorCode::DuplicateAccount);
    crate::guard!(*relayer_info.key != *nullifier_info.key, ErrorCode::DuplicateAccount);

    // Nor may the recipient be the pool state account (SEC-06). The pool is program-owned and no
    // instruction moves lamports out of it, so crediting it is the same irreversible burn as
    // crediting the nullifier PDA above — the funds are simply gone.
    //
    // Unlike the aliases above this one is self-inflicted: `recipient` is bound inside the
    // withdrawal commitment, so only the person who generated the proof can put the pool address
    // there. It is guarded anyway for the same reason the F-5 checks are. Paying a fresh address
    // that turns out to be wrong at least leaves open the possibility that someone holds its key;
    // paying this address is provably unrecoverable, and the pool address is exactly the kind of
    // value a user copies from an explorer or a misconfigured integration pastes by mistake. One
    // comparison removes the whole class.
    //
    // The treasury and relayer variants are NOT guarded because neither is reachable:
    //
    //   - treasury: validated as a `SystemAccount` in `initialize_pool`, and by the time that
    //     constraint runs the pool has already been created by `init` and is program-owned, so a
    //     pool address is rejected there and can never be stored as a pool's treasury.
    //   - relayer: must be a transaction signer, and the pool is a PDA with no private key.
    //
    // Adding guards for those would assert conditions the type system and runtime already
    // guarantee, which reads as though a real path had been closed.
    crate::guard!(*recipient_info.key != *pool_info.key, ErrorCode::DuplicateAccount);

    // 3. Verify vault PDA
    let expected_vault = Pubkey::create_program_address(
        &[b"vault", pool_info.key.as_ref(), &[vault_bump]],
        program_id,
    ).map_err(|_| error!(ErrorCode::InvalidVaultPda))?;
    crate::guard!(*vault_info.key == expected_vault, ErrorCode::InvalidVaultPda);
    crate::guard!(*vault_info.owner == *program_id, ErrorCode::InvalidVaultPda);

    // 4. Verify treasury matches pool
    crate::guard!(*treasury_info.key == pool_treasury, ErrorCode::InvalidTreasury);

    // 5. Verify root is recent (scan root_history in-place, no stack allocation).
    //
    // The empty-tree root is rejected outright (L-5). It is seeded into slot 0 of
    // every pool at creation and is byte-identical across every pool of depth 20, so
    // it is the one root that carries no pool-specific meaning. No legitimate
    // withdrawal can use it: a valid leaf in an empty tree would require a Poseidon
    // preimage of zero. Cheap defence against ever making that assumption load-bearing.
    crate::guard!(args.root != EMPTY_TREE_ROOT, ErrorCode::RootNotFound);
    let root_found = is_known_root_in_account(pool_info, &args.root)?;
    crate::guard!(root_found, ErrorCode::RootNotFound);

    // 6. Verify nullifier PDA does NOT exist (double-spend check)
    crate::guard!(nullifier_info.data_is_empty(), ErrorCode::NullifierAlreadySpent);

    // 7. Verify nullifier PDA address is correct (canonical bump only — prevents double-spend)
    let (expected_nullifier, canonical_bump) = Pubkey::find_program_address(
        &[b"nullifier", pool_info.key.as_ref(), &args.nullifier_hash],
        program_id,
    );
    crate::guard!(*nullifier_info.key == expected_nullifier, ErrorCode::InvalidPoolPda);

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
    crate::guard!(computed_commitment == args.withdrawal_commitment, ErrorCode::InvalidWithdrawalCommitment);

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
        crate::guard!(
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
    //
    // The guard is `denomination + vault rent`, not just `denomination` (F-8). The vault only ever
    // holds `rent + (deposits - withdrawals) * denomination`, so with at least one live deposit the
    // stronger form is already satisfied and this rejects nothing that used to pass — I could not
    // construct a state where the two differ. It is asserted rather than inferred because the
    // invariant that makes them equivalent lives in `deposit`, not here: debiting a program-owned
    // account below its rent floor would be caught by the runtime as a whole-transaction failure
    // with no indication of the cause, and this file already re-checks things it could infer
    // (the relayer signature, the nullifier account's owner) for the same reason.
    let vault_rent_floor = rent.minimum_balance(vault_info.data_len());
    let vault_required = pool_denomination
        .checked_add(vault_rent_floor)
        .ok_or_else(|| error!(ErrorCode::ArithmeticOverflow))?;
    crate::guard!(
        vault_info.lamports() >= vault_required,
        ErrorCode::InsufficientVaultBalance
    );

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

    // Real invariant: the vault paid out exactly one denomination, and every credited account
    // received exactly the total owed to ITS KEY.
    //
    // The per-key total matters because two payee slots may legitimately be the same account.
    // The common case is a solo operator whose relayer wallet is also the pool treasury: both
    // credits land in one lamport cell, so asserting that the treasury rose by exactly
    // treasury_fee fails even though the ledger balances perfectly. That made withdrawals
    // impossible for that configuration, reported as "fee invariant violated", which reads as a
    // protocol bug rather than a naive check. Recipient == relayer and recipient == treasury are
    // equally harmless and were equally broken.
    //
    // This does not weaken the guard. Aliasing that would actually move value incorrectly is
    // rejected earlier and unconditionally: no payee may be the vault, since crediting the debit
    // source nets funds back into it, and none may be the nullifier PDA, since that account is
    // program-owned with no way to move lamports out (step 12). What remains here is arithmetic:
    // the sum credited to each distinct account must equal the sum of the shares assigned to it.
    let credit_owed_to = |key: &Pubkey| -> u64 {
        let mut owed = 0u64;
        if treasury_info.key == key {
            owed += treasury_fee;
        }
        if relayer_info.key == key {
            owed += args.relayer_fee_taken;
        }
        if recipient_info.key == key {
            owed += user_amount;
        }
        owed
    };

    crate::guard!(
        vault_info.lamports() == vault_before - pool_denomination,
        ErrorCode::FeeInvariantViolated
    );
    crate::guard!(
        treasury_info.lamports() == treasury_before + credit_owed_to(treasury_info.key),
        ErrorCode::FeeInvariantViolated
    );
    crate::guard!(
        relayer_info.lamports() == relayer_before + credit_owed_to(relayer_info.key),
        ErrorCode::FeeInvariantViolated
    );
    crate::guard!(
        recipient_info.lamports() == recipient_before + credit_owed_to(recipient_info.key),
        ErrorCode::FeeInvariantViolated
    );

    // 16. Emit withdrawal event
    emit!(WithdrawalEvent {
        nullifier_hash: args.nullifier_hash,
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
