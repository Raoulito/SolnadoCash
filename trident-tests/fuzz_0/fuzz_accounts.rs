use trident_fuzz::fuzzing::*;

/// Storage for all account addresses used in fuzz testing.
///
/// This struct serves as a centralized repository for account addresses,
/// enabling their reuse across different instruction flows and test scenarios.
///
/// Docs: https://ackee.xyz/trident/docs/latest/trident-api-macro/trident-types/fuzz-accounts/
#[derive(Default)]
pub struct AccountAddresses {
    pub pool: AddressStorage,

    pub vault: AddressStorage,

    pub depositor: AddressStorage,

    pub system_program: AddressStorage,

    pub admin: AddressStorage,

    pub treasury: AddressStorage,

    pub nullifier_pda: AddressStorage,

    pub recipient: AddressStorage,

    pub relayer: AddressStorage,
}
