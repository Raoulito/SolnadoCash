//! Trident sequence fuzzing for SolnadoCash.
//!
//! What this target is for, and what it deliberately is not
//! ────────────────────────────────────────────────────────
//! Trident cannot produce a valid Groth16 proof, so it can never drive a SUCCESSFUL
//! withdrawal. That rules out fuzzing the happy path — which is fine, because the happy
//! path is already covered by 32 on-chain integration tests with real proofs.
//!
//! What Trident adds is the thing those tests do not do: random INSTRUCTION SEQUENCES.
//! Every existing on-chain test is essentially single-shot (set up, one operation,
//! assert). This explores interleavings — deposit/withdraw/pause/unpause in arbitrary
//! order, with fuzzed data and account substitutions — and asserts global invariants
//! after every step.
//!
//! The property under test, stated plainly:
//!
//!     No sequence of operations, without a valid ZK proof, may remove lamports from a
//!     vault or leave pool state inconsistent.
//!
//! Invariants checked after each flow:
//!   I1  vault lamports == rent + next_index * denomination      (no funds leak)
//!   I2  next_index only ever increases, by exactly 1 per successful deposit
//!   I3  next_index <= SATURATION_THRESHOLD                      (hard cap holds)
//!   I4  denomination, admin, treasury, bump, vault_bump are immutable after init
//!   I5  a fuzzed withdraw never succeeds (it cannot hold a valid proof)

use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
mod types;
use types::solnadocash::*;
use types::WithdrawArgs;

const DENOMINATION: u64 = 1_000_000_000; // 1 SOL
const POOL_VERSION: u8 = 0;
const SATURATION_THRESHOLD: u64 = 950_000;

// Pool account offsets, including the 8-byte discriminator.
const OFF_ADMIN: usize = 8;
const OFF_DENOM: usize = 8 + 64;
const OFF_NEXT_INDEX: usize = 8 + 80;
const OFF_TREASURY: usize = 8 + 88;
const OFF_BUMP: usize = 8 + 121;
const OFF_VAULT_BUMP: usize = 8 + 122;
const OFF_ROOT_HISTORY: usize = 8 + 136;
const OFF_IS_PAUSED: usize = 8 + 123;

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,

    // Reference state the invariants are checked against.
    pool: Pubkey,
    vault: Pubkey,
    admin: Pubkey,
    treasury: Pubkey,
    recipient: Pubkey,
    relayer: Pubkey,
    outsider: Pubkey,
    initialised: bool,
    /// Rent-exempt reserve the vault was created with, so I1 can subtract it.
    vault_rent: u64,
    /// Our own count of accepted deposits, independent of on-chain next_index.
    expected_deposits: u64,
    /// Highest next_index seen, to prove monotonicity (I2).
    last_next_index: u64,
    /// Snapshot of the immutable fields (I4).
    immutable_snapshot: Option<Vec<u8>>,
}

impl FuzzTest {
    fn read_pool(&mut self) -> Option<Vec<u8>> {
        let acc = self.trident.get_account(&self.pool);
        let data = acc.data().to_vec();
        if data.len() < OFF_IS_PAUSED + 1 {
            None
        } else {
            Some(data)
        }
    }

    fn vault_lamports(&mut self) -> u64 {
        self.trident.get_account(&self.vault).lamports()
    }

    fn u64_at(data: &[u8], off: usize) -> u64 {
        u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
    }

    /// Check every invariant. Called after each flow.
    fn check_invariants(&mut self, context: &str) {
        if !self.initialised {
            return;
        }
        let data = match self.read_pool() {
            Some(d) => d,
            None => panic!("[{context}] pool account disappeared"),
        };

        let next_index = Self::u64_at(&data, OFF_NEXT_INDEX);
        let denom = Self::u64_at(&data, OFF_DENOM);
        let vault = self.vault_lamports();

        // I1 — no lamports may leave the vault without a valid proof.
        let expected_vault = self
            .vault_rent
            .checked_add(next_index.checked_mul(denom).expect("vault math overflow"))
            .expect("vault math overflow");
        assert_eq!(
            vault, expected_vault,
            "[{context}] I1 VIOLATED: vault has {vault}, expected {expected_vault} \
             (rent {} + {next_index} deposits x {denom})",
            self.vault_rent
        );

        // I2 — next_index is monotonic and matches our own accounting.
        assert!(
            next_index >= self.last_next_index,
            "[{context}] I2 VIOLATED: next_index went backwards ({} -> {next_index})",
            self.last_next_index
        );
        assert_eq!(
            next_index, self.expected_deposits,
            "[{context}] I2 VIOLATED: on-chain next_index {next_index} != accepted deposits {}",
            self.expected_deposits
        );
        self.last_next_index = next_index;

        // I3 — the saturation cap is never exceeded.
        assert!(
            next_index <= SATURATION_THRESHOLD,
            "[{context}] I3 VIOLATED: next_index {next_index} exceeds saturation threshold"
        );

        // I4 — immutable fields never change after initialisation.
        let mut snap = Vec::new();
        snap.extend_from_slice(&data[OFF_ADMIN..OFF_ADMIN + 32]);
        snap.extend_from_slice(&data[OFF_DENOM..OFF_DENOM + 8]);
        snap.extend_from_slice(&data[OFF_TREASURY..OFF_TREASURY + 32]);
        snap.push(data[OFF_BUMP]);
        snap.push(data[OFF_VAULT_BUMP]);
        match &self.immutable_snapshot {
            None => self.immutable_snapshot = Some(snap),
            Some(prev) => assert_eq!(
                prev, &snap,
                "[{context}] I4 VIOLATED: an immutable pool field changed \
                 (admin/denomination/treasury/bump)"
            ),
        }
    }
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            pool: Pubkey::default(),
            vault: Pubkey::default(),
            admin: Pubkey::default(),
            treasury: Pubkey::default(),
            recipient: Pubkey::default(),
            relayer: Pubkey::default(),
            outsider: Pubkey::default(),
            initialised: false,
            vault_rent: 0,
            expected_deposits: 0,
            last_next_index: 0,
            immutable_snapshot: None,
        }
    }

    /// Create one pool per iteration so each sequence starts from a known state.
    #[init]
    fn start(&mut self) {
        // The admin/depositor/relayer must SIGN, and Trident can only sign for its own
        // payer, so use that identity for every signing role. Non-signing roles
        // (treasury, recipient) and the deliberately-unauthorised `outsider` are random.
        self.admin = self.trident.payer().pubkey();
        self.treasury = self.trident.random_pubkey();
        self.recipient = self.trident.random_pubkey();
        self.relayer = self.trident.payer().pubkey();
        self.outsider = self.trident.random_pubkey();
        self.trident.airdrop(&self.admin, 1_000_000_000_000);

        let denom_le = DENOMINATION.to_le_bytes();
        let (pool, _) = Pubkey::find_program_address(
            &[
                b"pool",
                self.admin.as_ref(),
                Pubkey::default().as_ref(),
                &denom_le,
                &[POOL_VERSION],
            ],
            &program_id(),
        );
        let (vault, _) = Pubkey::find_program_address(&[b"vault", pool.as_ref()], &program_id());
        self.pool = pool;
        self.vault = vault;

        let ix = InitializePoolInstruction::data(InitializePoolInstructionData::new(
            DENOMINATION,
            POOL_VERSION,
        ))
        .accounts(InitializePoolInstructionAccounts::new(
            self.admin, pool, vault, self.treasury,
        ));

        let init_result = self
            .trident
            .process_transaction(&[ix.instruction()], Some("initialize_pool"));
        if !init_result.is_success() && std::env::var("TRIDENT_DIAG").is_ok() {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open("/tmp/trident_diag.txt")
            {
                let _ = writeln!(f, "result: {:?}", init_result.get_result());
                let _ = writeln!(f, "logs:\n{}", init_result.logs());
                let _ = writeln!(f, "---");
            }
        }
        if init_result.is_success() {
            if std::env::var("TRIDENT_DIAG").is_ok() {
                use std::io::Write;
                let pool_len = self.trident.get_account(&self.pool).data().len();
                let vault_lam = self.vault_lamports();
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true).append(true).open("/tmp/trident_diag.txt") {
                    let _ = writeln!(f, "init ok: pool_data_len={pool_len} vault_lamports={vault_lam}");
                }
            }
            self.initialised = true;
            self.vault_rent = self.vault_lamports();
            self.expected_deposits = 0;
            self.last_next_index = 0;
            self.immutable_snapshot = None;
            self.check_invariants("init");
        }
    }

    /// Deposit with a fuzzed commitment. Any 32 bytes is legal input; the program must
    /// either accept it and grow the tree by exactly one, or reject it and change
    /// nothing.
    #[flow]
    fn flow_deposit(&mut self) {
        let mut commitment = [0u8; 32];
        self.trident.random_bytes(&mut commitment);
        if !self.initialised {
            return;
        }
        let before = self.read_pool().map(|d| Self::u64_at(&d, OFF_NEXT_INDEX));
        let paused = self.read_pool().map(|d| d[OFF_IS_PAUSED] == 1).unwrap_or(false);

        let ix = DepositInstruction::data(DepositInstructionData::new(commitment)).accounts(
            DepositInstructionAccounts::new(self.pool, self.vault, self.admin),
        );

        let result = self
            .trident
            .process_transaction(&[ix.instruction()], Some("deposit"));
        if result.is_success() {
            // A deposit must be impossible while paused.
            assert!(!paused, "deposit succeeded while the pool was PAUSED");
            self.expected_deposits += 1;
        } else if let Some(b) = before {
            // A rejected deposit must leave the counter untouched.
            let after = self.read_pool().map(|d| Self::u64_at(&d, OFF_NEXT_INDEX));
            assert_eq!(after, Some(b), "rejected deposit still moved next_index");
        }
        self.check_invariants("deposit");
    }

    /// Withdraw with fully fuzzed arguments. This can never hold a valid proof, so it
    /// must ALWAYS fail — and critically, must never move lamports (I1/I5).
    #[flow]
    fn flow_withdraw_garbage(&mut self) {
        let mut proof_a = [0u8; 64];
        let mut proof_b = [0u8; 128];
        let mut proof_c = [0u8; 64];
        let mut nullifier_hash = [0u8; 32];
        let mut root = [0u8; 32];
        let mut withdrawal_commitment = [0u8; 32];
        self.trident.random_bytes(&mut proof_a);
        self.trident.random_bytes(&mut proof_b);
        self.trident.random_bytes(&mut proof_c);
        self.trident.random_bytes(&mut nullifier_hash);
        self.trident.random_bytes(&mut root);
        self.trident.random_bytes(&mut withdrawal_commitment);
        // Sometimes feed a REAL root from the pool's history, so the fuzzer gets past the
        // root check and exercises the proof verifier and the fee path rather than
        // bouncing off RootNotFound every time.
        if self.trident.random_bool() {
            if let Some(d) = self.read_pool() {
                let idx = (d[OFF_IS_PAUSED] as usize) % 256;
                let start = OFF_ROOT_HISTORY + idx * 32;
                if d.len() >= start + 32 {
                    root.copy_from_slice(&d[start..start + 32]);
                }
            }
        }
        let mut fee_bytes = [0u8; 8];
        self.trident.random_bytes(&mut fee_bytes);
        let relayer_fee_max = u64::from_le_bytes(fee_bytes);
        self.trident.random_bytes(&mut fee_bytes);
        let relayer_fee_taken = u64::from_le_bytes(fee_bytes);
        if !self.initialised {
            return;
        }
        let (nullifier_pda, _) = Pubkey::find_program_address(
            &[b"nullifier", self.pool.as_ref(), &nullifier_hash],
            &program_id(),
        );
        let mut ix_data = WithdrawInstructionData::new(WithdrawArgs {
                proof_a,
                proof_b,
                proof_c,
                nullifier_hash,
                root,
                withdrawal_commitment,
            relayer_fee_max,
            relayer_fee_taken,
        });
        let _ = &mut ix_data;
        let ix = WithdrawInstruction::data(ix_data).accounts(WithdrawInstructionAccounts::new(
            self.pool,
            self.vault,
            nullifier_pda,
            self.recipient,
            self.treasury,
            self.relayer,
        ));

        let result = self
            .trident
            .process_transaction(&[ix.instruction()], Some("withdraw_garbage"));
        // I5 — a fuzzed withdrawal must never succeed.
        assert!(
            !result.is_success(),
            "I5 VIOLATED: withdraw succeeded WITHOUT a valid proof — funds can be stolen"
        );
        self.check_invariants("withdraw_garbage");
    }

    /// Pause with a fuzzed choice of signer. Only the admin may succeed.
    #[flow]
    fn flow_pause(&mut self) {
        let use_admin = self.trident.random_bool();
        if !self.initialised {
            return;
        }
        let signer = if use_admin {
            self.admin
        } else {
            self.outsider
        };
        let ix = PausePoolInstruction::data(PausePoolInstructionData::new())
            .accounts(PausePoolInstructionAccounts::new(signer, self.pool));

        let result = self
            .trident
            .process_transaction(&[ix.instruction()], Some("pause"));
        if result.is_success() {
            assert!(use_admin, "a NON-ADMIN paused the pool");
            let paused = self.read_pool().map(|d| d[OFF_IS_PAUSED] == 1).unwrap_or(false);
            assert!(paused, "pause returned ok but is_paused is not set");
        }
        self.check_invariants("pause");
    }

    /// Unpause with a fuzzed choice of signer. Only the admin may succeed.
    #[flow]
    fn flow_unpause(&mut self) {
        let use_admin = self.trident.random_bool();
        if !self.initialised {
            return;
        }
        let signer = if use_admin {
            self.admin
        } else {
            self.outsider
        };
        let ix = UnpausePoolInstruction::data(UnpausePoolInstructionData::new())
            .accounts(UnpausePoolInstructionAccounts::new(signer, self.pool));

        let result = self
            .trident
            .process_transaction(&[ix.instruction()], Some("unpause"));
        if result.is_success() {
            assert!(use_admin, "a NON-ADMIN unpaused the pool");
        }
        self.check_invariants("unpause");
    }

    /// Re-initialising an existing pool must always fail, whatever the parameters.
    #[flow]
    fn flow_reinit(&mut self) {
        let mut b = [0u8; 8];
        self.trident.random_bytes(&mut b);
        let denomination = u64::from_le_bytes(b);
        let version = b[0];
        if !self.initialised {
            return;
        }
        let ix = InitializePoolInstruction::data(InitializePoolInstructionData::new(
            denomination,
            version,
        ))
        .accounts(InitializePoolInstructionAccounts::new(
            self.admin,
            self.pool,
            self.vault,
            self.treasury,
        ));
        let result = self
            .trident
            .process_transaction(&[ix.instruction()], Some("reinit"));
        assert!(
            !result.is_success(),
            "re-initialisation of a live pool SUCCEEDED (denom {denomination}, version {version})"
        );
        self.check_invariants("reinit");
    }

    #[end]
    fn end(&mut self) {
        self.check_invariants("end");
    }
}

fn main() {
    FuzzTest::fuzz(500, 40);
}
