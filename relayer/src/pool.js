// relayer/src/pool.js
// N-2 — validate that an account really is a SolnadoCash pool before reading it.
//
// Both endpoints used to fetch whatever account the caller named and read raw byte
// offsets from it. That let an attacker point the relayer at an account they control:
// they write their own Merkle root at the root-history offset, build a genuinely valid
// Groth16 proof against a tree they constructed (the proving key is public), and both
// the off-chain proof check and preflight pass. The relayer then signs and pays for a
// transaction that dies on the program's first check — pool ownership — burning fees on
// every attempt.
//
// The fix is to establish that the account is a real pool BEFORE any byte of it is
// treated as meaningful.

// Anchor discriminator for the Pool account: first 8 bytes of
// sha256("account:Pool"). Must match POOL_DISCRIMINATOR in
// programs/solnadocash/src/withdraw.rs.
export const POOL_DISCRIMINATOR = Buffer.from([
  0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc,
]);

// 8-byte discriminator + Pool struct (see state.rs).
export const POOL_ACCOUNT_LEN = 8 + 8968;

// Offsets including the discriminator.
const OFF_DENOMINATION = 8 + 64;
const OFF_NEXT_INDEX = 8 + 80;
const OFF_TREASURY = 8 + 88;
const OFF_IS_PAUSED = 8 + 123;

/**
 * Fetch and validate a pool account.
 *
 * @returns {Promise<{ok: true, data: Buffer, denomination: bigint, treasury: Buffer,
 *   nextIndex: bigint, isPaused: boolean} | {ok: false, status: number, error: string, message: string}>}
 */
export async function loadPool(connection, programId, poolPubkey) {
  const info = await connection.getAccountInfo(poolPubkey);
  if (!info) {
    return {
      ok: false,
      status: 404,
      error: "PoolNotFound",
      message: "No account exists at that address.",
    };
  }

  // 1. Ownership: only the program can have created a real pool.
  if (!info.owner.equals(programId)) {
    return {
      ok: false,
      status: 400,
      error: "NotAPool",
      message: `Account is owned by ${info.owner.toBase58()}, not the SolnadoCash program.`,
    };
  }

  // 2. Length: guards every offset read below.
  if (info.data.length < POOL_ACCOUNT_LEN) {
    return {
      ok: false,
      status: 400,
      error: "NotAPool",
      message: `Account is ${info.data.length} bytes, expected ${POOL_ACCOUNT_LEN}.`,
    };
  }

  // 3. Discriminator: distinguishes a Pool from any other account this program owns
  //    (vaults and nullifier accounts are also program-owned).
  if (!info.data.subarray(0, 8).equals(POOL_DISCRIMINATOR)) {
    return {
      ok: false,
      status: 400,
      error: "NotAPool",
      message: "Account discriminator is not Pool.",
    };
  }

  return {
    ok: true,
    data: info.data,
    denomination: info.data.readBigUInt64LE(OFF_DENOMINATION),
    treasury: info.data.subarray(OFF_TREASURY, OFF_TREASURY + 32),
    nextIndex: info.data.readBigUInt64LE(OFF_NEXT_INDEX),
    isPaused: info.data[OFF_IS_PAUSED] === 1,
  };
}
