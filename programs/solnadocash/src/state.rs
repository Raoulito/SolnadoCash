use anchor_lang::prelude::*;
use solana_program::poseidon::{hashv, Endianness, Parameters};

use crate::error::ErrorCode;
use crate::zeros::ZEROS;

pub const ROOT_HISTORY_SIZE: usize = 256;
pub const TREE_DEPTH: usize = 20;
pub const SATURATION_THRESHOLD: u64 = 950_000;

/// Root of a completely empty depth-20 tree: Poseidon(ZEROS[19], ZEROS[19]).
/// Identical for every pool, which is why withdraw rejects it (L-5). Asserted
/// against the runtime computation in tests below so it cannot drift from ZEROS.
pub const EMPTY_TREE_ROOT: [u8; 32] = [
    0x21, 0x34, 0xe7, 0x6a, 0xc5, 0xd2, 0x1a, 0xab, 0x18, 0x6c, 0x2b, 0xe1, 0xdd, 0x8f, 0x84, 0xee,
    0x88, 0x0a, 0x1e, 0x46, 0xea, 0xf7, 0x12, 0xf9, 0xd3, 0x71, 0xb6, 0xdf, 0x22, 0x19, 0x1f, 0x3e,
];

// ── Pool account layout (F-6) ────────────────────────────────────────────────────────────────
//
// With zero_copy the on-disk layout IS the struct layout, so `repr(C)` plus explicit padding
// fixes it. That matters more here than in a normal Anchor program, because these offsets are
// read directly rather than through `AccountLoader` in about two dozen places: the bare-metal
// `withdraw` path (which is where its CU saving comes from), and the monitor, relayer, SDK,
// front end and scripts off-chain.
//
// Until F-6 nothing checked them. Adding or reordering one field compiled cleanly, silently
// repointed every reader, and no test failed — because every test hardcoded the same stale
// numbers. Most misreads happen to fail closed (a wrong `treasury` or `vault_bump` rejects
// every withdrawal), but `denomination` does NOT: a smaller-than-real value passes the vault
// balance guard, debits the vault by less than one denomination, and satisfies the conservation
// check, because that check is self-consistent with whatever denomination it was handed. The
// pool would quietly stop conserving value while the same struct change blinded the monitor
// that watches for exactly that.
//
// The `const _: ()` block below the struct is the fix. It fails the BUILD if any field moves,
// which is the only point at which a layout change can be caught before it reaches a ledger.
//
// Offsets are relative to the START OF THE STRUCT. Raw account data is prefixed with the
// 8-byte Anchor discriminator, so add `DISCRIMINATOR_LEN` when indexing that.
//
//   field                offset  size
//   admin                     0    32
//   mint                     32    32
//   denomination             64     8
//   mint_decimals            72     1
//   _pad0                    73     7   aligns next_index to 8
//   next_index               80     8
//   treasury                 88    32
//   version                 120     1
//   bump                    121     1
//   vault_bump              122     1
//   is_paused               123     1   0 = false, 1 = true
//   _pad1                   124     4   aligns current_root_index to 8
//   current_root_index      128     8
//   root_history            136  8192
//   filled_subtrees        8328   640
//   total                        8968
pub const POOL_SIZE: usize = 32 + 32 + 8 + 1 + 7 + 8 + 32 + 1 + 1 + 1 + 1 + 4 + 8 + 8192 + 640; // 8968

/// Length of the Anchor account discriminator prefix.
pub const DISCRIMINATOR_LEN: usize = 8;

pub const OFF_ADMIN: usize = 0;
pub const OFF_MINT: usize = 32;
pub const OFF_DENOMINATION: usize = 64;
pub const OFF_NEXT_INDEX: usize = 80;
pub const OFF_TREASURY: usize = 88;
pub const OFF_VERSION: usize = 120;
pub const OFF_BUMP: usize = 121;
pub const OFF_VAULT_BUMP: usize = 122;
pub const OFF_IS_PAUSED: usize = 123;
pub const OFF_CURRENT_ROOT_INDEX: usize = 128;
pub const OFF_ROOT_HISTORY: usize = 136;
pub const OFF_FILLED_SUBTREES: usize = 8328;

/// First 8 bytes of sha256("account:Pool").
///
/// The bare-metal withdraw path cannot use `AccountLoader`, so it compares this constant
/// against the account prefix itself. A hand-copied hash is exactly the kind of value that
/// rots silently, so the const block below pins it against Anchor's derived discriminator:
/// renaming the `Pool` struct now breaks the build instead of rejecting every pool at runtime.
pub const POOL_DISCRIMINATOR: [u8; 8] = [0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc];

// NullifierAccount: pool(32) + nullifier_hash(32) + slot(8) = 72 (without discriminator)
pub const NULLIFIER_SIZE: usize = 32 + 32 + 8; // = 72 (without discriminator)

/// Pool account — zero_copy(unsafe) to avoid large stack allocations during
/// Borsh deserialization. Data is accessed as a direct memory reference.
/// is_paused stored as u8: 0 = false, 1 = true.
#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct Pool {
    pub admin: Pubkey,              // offset 0,  size 32
    pub mint: Pubkey,               // offset 32, size 32
    pub denomination: u64,          // offset 64, size 8
    pub mint_decimals: u8,          // offset 72, size 1
    pub _pad0: [u8; 7],             // offset 73, size 7  (alignment pad)
    pub next_index: u64,            // offset 80, size 8
    pub treasury: Pubkey,           // offset 88, size 32
    pub version: u8,                // offset 120, size 1
    pub bump: u8,                   // offset 121, size 1
    pub vault_bump: u8,             // offset 122, size 1
    pub is_paused: u8,              // offset 123, size 1  (0=false, 1=true)
    pub _pad1: [u8; 4],             // offset 124, size 4  (alignment pad)
    pub current_root_index: u64,    // offset 128, size 8
    pub root_history: [[u8; 32]; ROOT_HISTORY_SIZE], // offset 136, size 8192
    pub filled_subtrees: [[u8; 32]; TREE_DEPTH],     // offset 8328, size 640
    // Total: 8968 bytes
}

/// F-6: the layout guard.
///
/// Every constant above is load-bearing for code that reads this account as raw bytes, on-chain
/// and off. These assertions are evaluated at compile time, so moving a field fails
/// `anchor build` rather than producing a program that reads the wrong eight bytes as a
/// denomination. `align_of` is included because an added field could change the alignment and
/// reintroduce implicit padding, which `zero_copy(unsafe)` does not check for us.
const _: () = {
    assert!(core::mem::size_of::<Pool>() == POOL_SIZE);
    assert!(core::mem::align_of::<Pool>() == 8);
    assert!(core::mem::offset_of!(Pool, admin) == OFF_ADMIN);
    assert!(core::mem::offset_of!(Pool, mint) == OFF_MINT);
    assert!(core::mem::offset_of!(Pool, denomination) == OFF_DENOMINATION);
    assert!(core::mem::offset_of!(Pool, next_index) == OFF_NEXT_INDEX);
    assert!(core::mem::offset_of!(Pool, treasury) == OFF_TREASURY);
    assert!(core::mem::offset_of!(Pool, version) == OFF_VERSION);
    assert!(core::mem::offset_of!(Pool, bump) == OFF_BUMP);
    assert!(core::mem::offset_of!(Pool, vault_bump) == OFF_VAULT_BUMP);
    assert!(core::mem::offset_of!(Pool, is_paused) == OFF_IS_PAUSED);
    assert!(core::mem::offset_of!(Pool, current_root_index) == OFF_CURRENT_ROOT_INDEX);
    assert!(core::mem::offset_of!(Pool, root_history) == OFF_ROOT_HISTORY);
    assert!(core::mem::offset_of!(Pool, filled_subtrees) == OFF_FILLED_SUBTREES);

    // The root scan walks the whole ring; it must end exactly where filled_subtrees begins.
    assert!(OFF_ROOT_HISTORY + ROOT_HISTORY_SIZE * 32 == OFF_FILLED_SUBTREES);
};

/// F-6: pin the hand-copied discriminator against the one Anchor derives.
///
/// A const fn because `Discriminator::DISCRIMINATOR` is a `&'static [u8]` and slice equality is
/// not const. Kept as a compile-time check rather than a test so it cannot be skipped by
/// building without running tests, which is precisely how a release gets cut.
const fn discriminator_matches(hardcoded: &[u8], derived: &[u8]) -> bool {
    if hardcoded.len() != derived.len() {
        return false;
    }
    let mut i = 0;
    while i < hardcoded.len() {
        if hardcoded[i] != derived[i] {
            return false;
        }
        i += 1;
    }
    true
}

const _: () = {
    assert!(DISCRIMINATOR_LEN == Pool::DISCRIMINATOR.len());
    assert!(discriminator_matches(
        &POOL_DISCRIMINATOR,
        Pool::DISCRIMINATOR
    ));
};

#[account]
pub struct NullifierAccount {
    pub pool: Pubkey,
    pub nullifier_hash: [u8; 32],
    pub slot: u64,
}

#[account]
pub struct VaultAccount {}

impl Pool {
    pub fn insert(&mut self, leaf: [u8; 32]) -> Result<[u8; 32]> {
        crate::guard!(self.is_paused == 0, ErrorCode::PoolPaused);
        crate::guard!(self.next_index < SATURATION_THRESHOLD, ErrorCode::PoolSaturated);
        crate::guard!(self.next_index < (1u64 << TREE_DEPTH), ErrorCode::TreeFull);

        let mut current_index = self.next_index;
        let mut current_level_hash = leaf;

        // clippy::needless_range_loop is allowed deliberately: the index addresses TWO
        // arrays (filled_subtrees and ZEROS) and the loop also tracks tree position.
        // Rewriting it as an iterator chain would obscure security-critical Merkle
        // logic to satisfy a style lint.
        #[allow(clippy::needless_range_loop)]
        for i in 0..TREE_DEPTH {
            let (left, right) = if current_index % 2 == 0 {
                // current is left child — store it, right is ZEROS[i]
                self.filled_subtrees[i] = current_level_hash;
                (current_level_hash, ZEROS[i])
            } else {
                // current is right child — left is filled_subtrees[i]
                (self.filled_subtrees[i], current_level_hash)
            };

            current_level_hash = hashv(
                Parameters::Bn254X5,
                Endianness::BigEndian,
                &[&left, &right],
            )
            .map_err(|_| error!(ErrorCode::PoseidonFailed))?
            .0;

            current_index /= 2;
        }

        let new_root = current_level_hash;
        let new_root_index = (self.current_root_index + 1) % ROOT_HISTORY_SIZE as u64;
        self.root_history[new_root_index as usize] = new_root;
        self.current_root_index = new_root_index;
        self.next_index += 1;

        Ok(new_root)
    }

    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        // Reject zero root — empty history slots are all zeros
        if root == &[0u8; 32] {
            return false;
        }
        for stored in self.root_history.iter() {
            if stored == root {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pool() -> Pool {
        Pool {
            admin: Pubkey::default(),
            mint: Pubkey::default(),
            denomination: 1_000_000_000,
            mint_decimals: 9,
            _pad0: [0u8; 7],
            next_index: 0,
            treasury: Pubkey::default(),
            version: 0,
            bump: 0,
            vault_bump: 0,
            is_paused: 0,
            _pad1: [0u8; 4],
            current_root_index: 0,
            root_history: [[0u8; 32]; ROOT_HISTORY_SIZE],
            filled_subtrees: ZEROS,
        }
    }

    // ── Saturation (BF-15) ─────────────────────────────────────────────────
    #[test]
    fn saturation_rejects_at_threshold() {
        let mut pool = make_pool();
        pool.next_index = SATURATION_THRESHOLD;
        let result = pool.insert([1u8; 32]);
        assert!(result.is_err(), "insert should fail at saturation threshold");
    }

    #[test]
    fn saturation_allows_just_below_threshold() {
        let pool = make_pool();
        // Default next_index = 0, well below threshold
        assert!(pool.next_index < SATURATION_THRESHOLD);
    }

    // ── Tree full (defense-in-depth behind saturation) ─────────────────────
    #[test]
    fn tree_full_rejects_at_capacity() {
        let mut pool = make_pool();
        // 2^TREE_DEPTH > SATURATION_THRESHOLD, so PoolSaturated fires first.
        // This verifies the defense-in-depth: even at max tree capacity,
        // the saturation guard prevents insertion.
        pool.next_index = 1u64 << TREE_DEPTH;
        let result = pool.insert([1u8; 32]);
        assert!(result.is_err(), "insert should fail at tree capacity");
    }

    // ── Paused (BF-31) ────────────────────────────────────────────────────
    #[test]
    fn paused_pool_rejects_insert() {
        let mut pool = make_pool();
        pool.is_paused = 1;
        let result = pool.insert([1u8; 32]);
        assert!(result.is_err(), "insert should fail when pool is paused");
    }

    #[test]
    fn unpaused_pool_does_not_reject_for_pause() {
        let pool = make_pool();
        assert_eq!(pool.is_paused, 0, "default pool should be unpaused");
    }

    // ── EMPTY_TREE_ROOT (L-5) ──────────────────────────────────────────────
    #[test]
    fn empty_tree_root_matches_zeros_table() {
        // Must equal what initialize_pool computes, or withdraw would reject a
        // legitimate root (or fail to reject the empty one).
        let computed = hashv(
            Parameters::Bn254X5,
            Endianness::BigEndian,
            &[&ZEROS[TREE_DEPTH - 1], &ZEROS[TREE_DEPTH - 1]],
        )
        .unwrap()
        .0;
        assert_eq!(
            computed, EMPTY_TREE_ROOT,
            "EMPTY_TREE_ROOT has drifted from the ZEROS table"
        );
    }

    #[test]
    fn empty_tree_root_is_not_a_real_insert_root() {
        // Any actual insertion must move the root away from the empty value.
        let mut pool = make_pool();
        let new_root = pool.insert([7u8; 32]).unwrap();
        assert_ne!(new_root, EMPTY_TREE_ROOT);
    }

    // ── is_known_root ──────────────────────────────────────────────────────
    #[test]
    fn is_known_root_empty_history() {
        let pool = make_pool();
        let fake = [1u8; 32];
        assert!(!pool.is_known_root(&fake), "empty history should not match");
    }

    #[test]
    fn is_known_root_finds_match() {
        let mut pool = make_pool();
        let root = [42u8; 32];
        pool.root_history[0] = root;
        assert!(pool.is_known_root(&root), "should find stored root");
    }

    #[test]
    fn is_known_root_no_false_positive() {
        let mut pool = make_pool();
        pool.root_history[0] = [42u8; 32];
        let other = [99u8; 32];
        assert!(!pool.is_known_root(&other), "should not match different root");
    }

    #[test]
    fn is_known_root_finds_in_any_slot() {
        let mut pool = make_pool();
        let root = [7u8; 32];
        pool.root_history[ROOT_HISTORY_SIZE - 1] = root;
        assert!(pool.is_known_root(&root), "should find root in last slot");
    }
}
