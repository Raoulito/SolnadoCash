use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("pool is paused")]
    PoolPaused,
    #[msg("pool is saturated")]
    PoolSaturated,
    #[msg("merkle tree is full")]
    TreeFull,
    #[msg("root not found in history")]
    RootNotFound,
    #[msg("nullifier already spent")]
    NullifierAlreadySpent,
    #[msg("invalid proof")]
    InvalidProof,
    #[msg("proof deserialization failed")]
    ProofDeserializationFailed,
    #[msg("invalid withdrawal commitment")]
    InvalidWithdrawalCommitment,
    #[msg("relayer fee exceeds max")]
    RelayerFeeExceedsMax,
    #[msg("fee invariant violated")]
    FeeInvariantViolated,
    #[msg("denomination < 500")]
    DenominationTooLow,
    #[msg("version = 255")]
    VersionTooHigh,
    #[msg("poseidon hash failed")]
    PoseidonFailed,
    #[msg("invalid pool PDA")]
    InvalidPoolPda,
    #[msg("invalid vault PDA")]
    InvalidVaultPda,
    #[msg("invalid treasury")]
    InvalidTreasury,
    #[msg("relayer not signer")]
    RelayerNotSigner,
    #[msg("arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("groth16 verifier init failed")]
    BenchmarkVerifierInit,
    #[msg("groth16 proof verify failed")]
    BenchmarkVerifyFailed,
    #[msg("Poseidon hash failed in benchmark")]
    BenchmarkPoseidonHash,
    #[msg("invalid system program")]
    InvalidSystemProgram,
}
