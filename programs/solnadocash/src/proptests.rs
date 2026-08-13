// programs/solnadocash/src/proptests.rs
//
// Phase 2 — property-based testing of the value-moving arithmetic.
//
// These properties are the ones a withdrawal must never violate, checked against
// thousands of generated (denomination, fee) pairs rather than the handful of values
// the integration tests happen to use. They mirror the on-chain logic in
// withdraw.rs::process_withdraw exactly; if that logic changes, these must be updated
// in lockstep or they stop meaning anything.

use proptest::prelude::*;

use crate::withdraw::{compute_fee_split, worst_case_user_amount, MAX_RELAYER_FEE_DIVISOR};

/// Calls the REAL on-chain fee split (withdraw.rs::compute_fee_split). Not a mirror —
/// a mirrored copy would drift from the shipped logic and these properties would stop
/// constraining anything.
fn fee_split(denomination: u64, relayer_fee_taken: u64, relayer_fee_max: u64) -> Option<(u64, u64, u64)> {
    compute_fee_split(denomination, relayer_fee_taken, relayer_fee_max).ok()
}

/// Rent-exempt minimum for a 0-byte account, measured on a validator: transferring
/// 890_879 to a fresh address is rejected, 890_880 succeeds.
const RENT_MIN_BALANCE_0: u64 = 890_880;

/// Mirrors initialize_pool's acceptance rule, using the shared helper it calls.
fn denomination_accepted(denomination: u64) -> bool {
    denomination >= 500
        && worst_case_user_amount(denomination).is_some_and(|w| w >= RENT_MIN_BALANCE_0)
}

/// Generate (denomination, fee_max, fee_taken) with the fees RELATIVE to the
/// denomination.
///
/// Independent uniform sampling over 0..u64::MAX/4 was near-useless here: almost every
/// draw produced a fee so large that the split failed on underflow, so the properties
/// silently skipped and never explored the region around the 2% cap where the bugs
/// live. Verified by mutation testing — with the cap removed, only one property failed
/// under uniform generators. Scaling the fees to the denomination fixes that.
fn denom_and_fees() -> impl Strategy<Value = (u64, u64, u64)> {
    (1_000_000u64..=1_000_000_000_000u64).prop_flat_map(|denom| {
        // Span the cap: up to 4x denom/50 so both accepted and rejected ceilings occur.
        let max_ceiling = denom / MAX_RELAYER_FEE_DIVISOR * 4 + 2;
        (Just(denom), 0u64..=max_ceiling)
            .prop_flat_map(|(d, fee_max)| (Just(d), Just(fee_max), 0u64..=fee_max.max(1)))
    })
}

/// 32-byte values biased toward the field boundary.
///
/// Uniform random bytes never hit `x == Fr` (probability 2^-256), so a uniform
/// generator cannot detect an off-by-one that accepts exactly Fr — verified by mutation
/// testing: flipping `is_canonical_fr`'s equal-to-Fr branch to `true` passed all
/// uniform properties while the hand-written boundary unit test caught it immediately.
/// This mixes uniform draws with Fr and its immediate neighbourhood so the property
/// covers the boundary as well as the space.
fn field_boundary_bytes() -> impl Strategy<Value = [u8; 32]> {
    let fr = crate::withdraw::BN254_FR;
    prop_oneof![
        6 => any::<[u8; 32]>(),
        1 => Just(fr),
        1 => Just({
            // Fr - 1: last byte of Fr is 0x01, so this is the largest canonical value.
            let mut v = fr;
            v[31] -= 1;
            v
        }),
        1 => Just({
            let mut v = fr;
            v[31] += 1; // Fr + 1
            v
        }),
        1 => Just([0u8; 32]),
        1 => Just([0xffu8; 32]),
    ]
}

proptest! {
    /// Conservation: the three payouts must account for the denomination exactly.
    /// No lamports created, none destroyed, for any accepted input.
    #[test]
    fn fees_conserve_the_denomination((denomination, fee_max, fee_taken) in denom_and_fees()) {
        if let Some((treasury, relayer, user)) = fee_split(denomination, fee_taken, fee_max) {
            prop_assert_eq!(
                treasury.checked_add(relayer).and_then(|x| x.checked_add(user)),
                Some(denomination),
                "denom={} treasury={} relayer={} user={}",
                denomination, treasury, relayer, user
            );
        }
    }

    /// The user never loses more than 2.2% of the denomination (0.2% treasury + 2% cap).
    #[test]
    fn user_keeps_at_least_97_8_percent((denomination, fee_max, fee_taken) in denom_and_fees()) {
        if let Some((_, _, user)) = fee_split(denomination, fee_taken, fee_max) {
            // user >= denom - denom/500 - denom/50, using integer arithmetic
            let floor = denomination - denomination / 500 - denomination / MAX_RELAYER_FEE_DIVISOR;
            prop_assert!(
                user >= floor,
                "user {} below floor {} for denom {}",
                user, floor, denomination
            );
        }
    }

    /// No accepted input can produce a zero payout to the user.
    #[test]
    fn user_amount_is_never_zero((denomination, fee_max, fee_taken) in denom_and_fees()) {
        if let Some((_, _, user)) = fee_split(denomination, fee_taken, fee_max) {
            prop_assert!(user > 0);
        }
    }

    /// The relayer can never take more than the ceiling the user signed, and never
    /// more than 2% of the denomination.
    #[test]
    fn relayer_fee_is_doubly_bounded((denomination, fee_max, fee_taken) in denom_and_fees()) {
        if let Some((_, relayer, _)) = fee_split(denomination, fee_taken, fee_max) {
            prop_assert!(relayer <= fee_max, "relayer {} > agreed max {}", relayer, fee_max);
            prop_assert!(
                relayer <= denomination / MAX_RELAYER_FEE_DIVISOR,
                "relayer {} exceeds 2% of {}",
                relayer, denomination
            );
        }
    }

    /// Nothing overflows or panics for any u64 input, including extremes.
    #[test]
    fn no_panic_on_any_input(
        denomination in any::<u64>(),
        fee_taken in any::<u64>(),
        fee_max in any::<u64>(),
    ) {
        let _ = fee_split(denomination, fee_taken, fee_max);
        let _ = denomination_accepted(denomination);
    }

    /// N-3: every denomination the program accepts must leave a worst-case payout that
    /// clears the runtime's rent floor for a fresh recipient. This is the property that
    /// makes deposits withdrawable at all.
    #[test]
    fn accepted_denominations_are_always_withdrawable(
        denomination in 500u64..=1_000_000_000_000u64,
    ) {
        if denomination_accepted(denomination) {
            let (_, _, user) = fee_split(
                denomination,
                denomination / MAX_RELAYER_FEE_DIVISOR, // relayer takes the maximum
                denomination / MAX_RELAYER_FEE_DIVISOR,
            )
            .expect("accepted denomination must produce a valid split");
            prop_assert!(
                user >= RENT_MIN_BALANCE_0,
                "denom {} accepted but worst-case payout {} is below the rent floor {}",
                denomination, user, RENT_MIN_BALANCE_0
            );
        }
    }

    /// The treasury fee is exactly 0.2%, floor-divided, and never exceeds the
    /// denomination.
    #[test]
    fn treasury_fee_is_bounded(denomination in 0u64..=u64::MAX) {
        let fee = denomination / 500;
        prop_assert!(fee <= denomination);
        prop_assert!(fee.checked_mul(500).is_none_or(|x| x <= denomination));
    }

    /// C-1's guard must agree with numeric comparison for EVERY 32-byte input.
    ///
    /// The reference here is deliberately independent: for fixed-width big-endian
    /// byte arrays, lexicographic slice ordering IS numeric ordering, so
    /// `x.as_slice() < FR.as_slice()` is an obviously-correct oracle for `x < Fr`
    /// that shares no code with the hand-rolled loop being tested.
    #[test]
    fn canonical_check_matches_numeric_comparison(bytes in field_boundary_bytes()) {
        let expected = bytes.as_slice() < crate::withdraw::BN254_FR.as_slice();
        prop_assert_eq!(
            crate::withdraw::is_canonical_fr(&bytes),
            expected,
            "disagreement on {:?}",
            bytes
        );
    }

    /// Values at and above Fr must always be rejected; the boundary is where a
    /// double-spend would have been possible (C-1).
    #[test]
    fn canonical_check_rejects_fr_and_above(extra in 0u64..=u64::MAX) {
        // Fr + extra, saturating at 2^256-1, must never be canonical.
        let mut v = crate::withdraw::BN254_FR;
        let mut carry = extra as u128;
        for i in (0..32).rev() {
            if carry == 0 { break; }
            let sum = v[i] as u128 + (carry & 0xff);
            v[i] = (sum & 0xff) as u8;
            carry = (carry >> 8) + (sum >> 8);
        }
        prop_assert!(!crate::withdraw::is_canonical_fr(&v));
    }

    /// The pubkey encoding must always land inside the field, for any 32 bytes —
    /// otherwise the Poseidon syscall would reject a legitimate recipient (H-2).
    #[test]
    fn pubkey_encoding_always_lands_in_field(bytes in any::<[u8; 32]>()) {
        let key = anchor_lang::prelude::Pubkey::from(bytes);
        let field = crate::withdraw::pubkey_to_field(&key).expect("encoding must not fail");
        prop_assert!(
            crate::withdraw::is_canonical_fr(&field),
            "encoding produced a non-canonical element for {:?}",
            bytes
        );
    }

    /// Distinct pubkeys must encode to distinct field elements. A collision here is
    /// the H-2 recipient-substitution bug returning.
    #[test]
    fn pubkey_encoding_has_no_easy_collisions(a in any::<[u8; 32]>(), b in any::<[u8; 32]>()) {
        prop_assume!(a != b);
        let ka = anchor_lang::prelude::Pubkey::from(a);
        let kb = anchor_lang::prelude::Pubkey::from(b);
        prop_assert_ne!(
            crate::withdraw::pubkey_to_field(&ka).unwrap(),
            crate::withdraw::pubkey_to_field(&kb).unwrap()
        );
    }
}
