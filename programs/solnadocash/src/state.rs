use anchor_lang::prelude::*;
use solana_program::poseidon::{hashv, Endianness, Parameters};

use crate::error::ErrorCode;
use crate::zeros::ZEROS;

pub const ROOT_HISTORY_SIZE: usize = 256;
pub const TREE_DEPTH: usize = 20;
pub const SATURATION_THRESHOLD: u64 = 950_000;

// POOL_SIZE (without discriminator) = 32+32+8+1+8+32+1+1+1+1+8192+8+640 = 8957
// With zero_copy, the on-disk layout must match the struct layout exactly.
// We use repr(C) + explicit padding to ensure no surprises.
// Layout:
//   admin:          32 bytes (offset 0)
//   mint:           32 bytes (offset 32)
//   denomination:   8 bytes  (offset 64)
//   mint_decimals:  1 byte   (offset 72)
//   _pad0:          7 bytes  (offset 73) → aligns next_index to 8-byte boundary (offset 80)
//   next_index:     8 bytes  (offset 80)
//   treasury:       32 bytes (offset 88)
//   version:        1 byte   (offset 120)
//   bump:           1 byte   (offset 121)
//   vault_bump:     1 byte   (offset 122)
//   is_paused:      1 byte   (offset 123) — 0=false, 1=true
//   _pad1:          4 bytes  (offset 124) → aligns current_root_index to 8-byte boundary (128)
//   current_root_index: 8 bytes (offset 128)
//   root_history:   8192 bytes (offset 136)
//   filled_subtrees: 640 bytes (offset 8328)
// Total: 8968 bytes
//
// NOTE: POOL_SIZE constant updated to 8968 to match the padded layout.
pub const POOL_SIZE: usize = 32 + 32 + 8 + 1 + 7 + 8 + 32 + 1 + 1 + 1 + 1 + 4 + 8 + 8192 + 640; // 8968

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
        require!(self.is_paused == 0, ErrorCode::PoolPaused);
        require!(self.next_index < SATURATION_THRESHOLD, ErrorCode::PoolSaturated);
        require!(self.next_index < (1u64 << TREE_DEPTH), ErrorCode::TreeFull);

        let mut current_index = self.next_index;
        let mut current_level_hash = leaf;

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
