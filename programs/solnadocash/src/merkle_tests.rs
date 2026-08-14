//! Direct tests for the Merkle machinery: the ZEROS table, the incremental insert, and the
//! index-bit → left/right convention the circuit depends on.
//!
//! Why this file exists. Three audit passes plus a fuzzer never tested the insert algorithm
//! against an independent implementation; correctness rested on devnet withdrawals succeeding.
//! That is real evidence but it is indirect, and it only covers the index patterns those
//! deposits happened to hit. The existing `empty_tree_root_matches_zeros_table` is weaker than
//! it looks: it checks only the LAST link of the ZEROS chain, so a wrong entry at, say, level 5
//! would still pass while silently breaking every path that touches an empty subtree at that
//! level — withdrawals would fail for some leaf indices and not others.

#![cfg(test)]

use crate::state::{Pool, ROOT_HISTORY_SIZE, TREE_DEPTH};
use crate::zeros::ZEROS;
use anchor_lang::prelude::Pubkey;
use solana_program::poseidon::{hashv, Endianness, Parameters};

fn h(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[a, b])
        .expect("poseidon")
        .0
}

fn fresh_pool() -> Pool {
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

/// Deterministic pseudo-random leaves. Values stay well below the BN254 field order because
/// the top byte is never set, so every leaf is a legal field element.
fn leaf(i: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut x = i.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(0x1234_5678);
    for slot in out.iter_mut().skip(8) {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *slot = (x & 0xff) as u8;
    }
    out
}

/// Independent root computation: build each level from the full list of leaves, padding with
/// the empty-subtree hash for that level. Deliberately unlike `Pool::insert`, which walks one
/// leaf at a time using `filled_subtrees` — so agreement between them is meaningful.
fn root_from_leaves(leaves: &[[u8; 32]]) -> [u8; 32] {
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    for depth in 0..TREE_DEPTH {
        if level.is_empty() {
            // Nothing filled at this level: the rest of the tree is entirely empty.
            return (depth..TREE_DEPTH).fold(ZEROS[depth], |acc, d| {
                let _ = d;
                h(&acc, &acc)
            });
        }
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut i = 0;
        while i < level.len() {
            let left = level[i];
            // A missing right sibling is an empty subtree of this level's height.
            let right = if i + 1 < level.len() { level[i + 1] } else { ZEROS[depth] };
            next.push(h(&left, &right));
            i += 2;
        }
        level = next;
    }
    level[0]
}

// ── The ZEROS table ─────────────────────────────────────────────────────────────

#[test]
fn zeros_chain_is_self_consistent_at_every_level() {
    // The whole chain, not just the last link.
    assert_eq!(ZEROS[0], [0u8; 32], "ZEROS[0] must be the zero field element");
    for i in 1..TREE_DEPTH {
        let expected = h(&ZEROS[i - 1], &ZEROS[i - 1]);
        assert_eq!(
            ZEROS[i], expected,
            "ZEROS[{i}] is not Poseidon(ZEROS[{}], ZEROS[{}]) — the generated table is \
             corrupt, and every Merkle path touching an empty subtree at level {i} will \
             produce a root the circuit cannot reproduce",
            i - 1,
            i - 1
        );
    }
}

// ── Incremental insert vs independent recomputation ─────────────────────────────

#[test]
fn incremental_insert_matches_full_recomputation() {
    // Counts chosen to straddle every structural boundary: first leaf, first right child,
    // odd/even transitions, and powers of two where a whole subtree closes.
    for n in [1usize, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65] {
        let leaves: Vec<[u8; 32]> = (0..n as u64).map(leaf).collect();

        let mut pool = fresh_pool();
        let mut last_root = [0u8; 32];
        for l in &leaves {
            last_root = pool.insert(*l).expect("insert");
        }

        assert_eq!(
            last_root,
            root_from_leaves(&leaves),
            "incremental root disagrees with full recomputation at n={n}"
        );
        assert_eq!(pool.next_index, n as u64, "next_index wrong at n={n}");
    }
}

#[test]
fn every_intermediate_root_matches_recomputation() {
    // Not just the final root: each insert must publish a root consistent with the leaves so
    // far, because a withdrawal may prove against any of the last 256 roots.
    let mut pool = fresh_pool();
    let mut leaves: Vec<[u8; 32]> = Vec::new();
    for i in 0..40u64 {
        let l = leaf(i);
        leaves.push(l);
        let got = pool.insert(l).expect("insert");
        assert_eq!(
            got,
            root_from_leaves(&leaves),
            "root after inserting leaf {i} disagrees with recomputation"
        );
    }
}

#[test]
fn distinct_leaf_sequences_give_distinct_roots() {
    // Order must matter: if it did not, a leaf could be proven at a position it never occupied.
    let a: Vec<[u8; 32]> = (0..8u64).map(leaf).collect();
    let mut b = a.clone();
    b.swap(2, 5);

    let root_a = { let mut p = fresh_pool(); a.iter().map(|l| p.insert(*l).unwrap()).last().unwrap() };
    let root_b = { let mut p = fresh_pool(); b.iter().map(|l| p.insert(*l).unwrap()).last().unwrap() };
    assert_ne!(root_a, root_b, "reordering leaves must change the root");
}

// ── The path convention the circuit relies on ───────────────────────────────────

/// Extract the sibling path for `index`, mirroring what the SDK gives the prover.
fn path_for(leaves: &[[u8; 32]], index: usize) -> Vec<[u8; 32]> {
    let mut siblings = Vec::with_capacity(TREE_DEPTH);
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    let mut idx = index;

    for depth in 0..TREE_DEPTH {
        let sibling = if idx % 2 == 0 {
            level.get(idx + 1).copied().unwrap_or(ZEROS[depth])
        } else {
            level[idx - 1]
        };
        siblings.push(sibling);

        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut i = 0;
        while i < level.len() {
            let left = level[i];
            let right = if i + 1 < level.len() { level[i + 1] } else { ZEROS[depth] };
            next.push(h(&left, &right));
            i += 2;
        }
        level = next;
        idx /= 2;
    }
    siblings
}

/// Recompute a root from a leaf and its path exactly as merkle_proof.circom does:
/// pathIndices bit 0 means the current node is the LEFT child.
fn verify_path(leaf_value: [u8; 32], index: usize, siblings: &[[u8; 32]]) -> [u8; 32] {
    let mut cur = leaf_value;
    let mut idx = index;
    for sibling in siblings.iter().take(TREE_DEPTH) {
        let (left, right) = if idx % 2 == 0 {
            (cur, *sibling) // bit 0 → current is left
        } else {
            (*sibling, cur) // bit 1 → current is right
        };
        cur = h(&left, &right);
        idx /= 2;
    }
    cur
}

#[test]
fn generated_paths_verify_under_the_circuit_convention() {
    // This is the property that makes a proof land on-chain: the root the program stores must
    // be reproducible from a leaf plus its siblings using bit-0-means-left. If the program and
    // the circuit disagreed on that convention, roots would diverge for any index with a set
    // bit — i.e. everything except leaf 0.
    for n in [1usize, 2, 3, 5, 8, 13, 21, 34] {
        let leaves: Vec<[u8; 32]> = (0..n as u64).map(leaf).collect();
        let mut pool = fresh_pool();
        let mut root = [0u8; 32];
        for l in &leaves {
            root = pool.insert(*l).expect("insert");
        }

        for (i, l) in leaves.iter().enumerate() {
            let siblings = path_for(&leaves, i);
            assert_eq!(
                verify_path(*l, i, &siblings),
                root,
                "path for leaf {i} of {n} does not reproduce the on-chain root"
            );
        }
    }
}

#[test]
fn a_wrong_sibling_or_index_fails_verification() {
    // Guards against the tests above passing for a degenerate reason.
    let leaves: Vec<[u8; 32]> = (0..8u64).map(leaf).collect();
    let mut pool = fresh_pool();
    let mut root = [0u8; 32];
    for l in &leaves {
        root = pool.insert(*l).expect("insert");
    }

    let mut siblings = path_for(&leaves, 3);
    assert_eq!(verify_path(leaves[3], 3, &siblings), root);

    // Claiming a different position must not verify.
    assert_ne!(verify_path(leaves[3], 2, &siblings), root, "wrong index verified");

    // Corrupting one sibling must not verify.
    siblings[0][31] ^= 1;
    assert_ne!(verify_path(leaves[3], 3, &siblings), root, "corrupt sibling verified");
}

// ── Root ring buffer ────────────────────────────────────────────────────────────

#[test]
fn root_ring_wraps_and_keeps_the_newest_root_findable() {
    let mut pool = fresh_pool();
    let mut roots = Vec::new();
    // One full lap plus a few, so slot reuse is exercised.
    for i in 0..(ROOT_HISTORY_SIZE as u64 + 5) {
        roots.push(pool.insert(leaf(i)).expect("insert"));
    }

    let newest = *roots.last().unwrap();
    assert!(pool.is_known_root(&newest), "newest root must be findable");
    assert_eq!(
        pool.current_root_index,
        (ROOT_HISTORY_SIZE as u64 + 5) % ROOT_HISTORY_SIZE as u64,
        "current_root_index did not wrap as expected"
    );

    // The oldest roots have been overwritten; the most recent 250 must all still be present.
    for r in roots.iter().rev().take(250) {
        assert!(pool.is_known_root(r), "a recent root was evicted too early");
    }
}

// ── Cross-language agreement with the SDK ───────────────────────────────────────

/// Big-endian 32-byte encoding of a small integer, matching how the SDK feeds field elements
/// to Poseidon.
fn be(v: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&v.to_be_bytes());
    out
}

#[test]
fn on_chain_root_matches_the_sdk_for_a_fixed_vector() {
    // The SDK builds the tree the prover uses; this program builds the root the proof must
    // match. Nothing tested that the two agree — it was inferred from devnet withdrawals
    // succeeding. This pins it with a vector computed independently by the SDK
    // (sdk MerkleTree(20), circomlibjs Poseidon):
    //
    //   leaves = [1, 2, 3, 12345678901234567890, 7]
    //   root   = 0x145f6703d126f5bd9c60adea4f8294be751ca5e551c92678360090da5ff24ef4
    //
    // A divergence here means every withdrawal fails, so it is worth a hard-coded expectation:
    // it fails loudly at build time instead of silently on-chain.
    const EXPECTED_ROOT: [u8; 32] = [
        0x14, 0x5f, 0x67, 0x03, 0xd1, 0x26, 0xf5, 0xbd, 0x9c, 0x60, 0xad, 0xea, 0x4f, 0x82,
        0x94, 0xbe, 0x75, 0x1c, 0xa5, 0xe5, 0x51, 0xc9, 0x26, 0x78, 0x36, 0x00, 0x90, 0xda,
        0x5f, 0xf2, 0x4e, 0xf4,
    ];

    let leaves = [be(1), be(2), be(3), be(12_345_678_901_234_567_890u128), be(7)];
    let mut pool = fresh_pool();
    let mut root = [0u8; 32];
    for l in &leaves {
        root = pool.insert(*l).expect("insert");
    }

    assert_eq!(
        root, EXPECTED_ROOT,
        "on-chain root diverged from the SDK reference — the prover and the program disagree \
         about the tree, so no proof can verify"
    );
}
