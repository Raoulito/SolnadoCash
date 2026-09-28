// relayer/src/startup.js
//
// L-3. Which key the relayer signs with.
//
// The relayer is an internet-facing process that signs and pays for transactions with a hot key.
// When RELAYER_KEYPAIR was unset it fell back to ~/.config/solana/id.json, the Solana CLI's default
// wallet, which on an operator's machine is usually the key that deployed the program: its upgrade
// authority, and often the pool admin and treasury as well. Any file read or remote code execution in
// the relayer or its dependency tree would then hand over the key that can replace the program and
// drain every vault. Reproduced: with RELAYER_KEYPAIR unset the relayer started and signed as
// whatever key sat at that path.
//
// So the key must now be named explicitly, and the relayer refuses to run as the program's upgrade
// authority, which it reads from the chain rather than trusting configuration.

import { readFileSync } from "fs";
import { Keypair, PublicKey } from "@solana/web3.js";

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export class RelayerKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "RelayerKeyError";
  }
}

/** Load the relayer keypair from RELAYER_KEYPAIR. There is no default path. */
export function loadRelayerKeypair(env = process.env, read = readFileSync) {
  const path = env.RELAYER_KEYPAIR;
  if (!path) {
    throw new RelayerKeyError(
      "RELAYER_KEYPAIR is not set. Point it at a dedicated hot wallet that holds only enough SOL " +
        "for nullifier rent. The relayer no longer falls back to ~/.config/solana/id.json, which is " +
        "usually the key that deployed the program."
    );
  }
  let bytes;
  try {
    bytes = Uint8Array.from(JSON.parse(read(path, "utf8")));
  } catch (e) {
    throw new RelayerKeyError(`RELAYER_KEYPAIR (${path}) could not be read as a keypair: ${e.message}`);
  }
  return Keypair.fromSecretKey(bytes);
}

/**
 * The program's upgrade authority, or null if the program is immutable. Throws if the program's
 * accounts cannot be read or are not an upgradeable program, since the check cannot then be made.
 */
export async function upgradeAuthority(connection, programId) {
  const program = await connection.getAccountInfo(programId);
  if (!program || !program.owner.equals(UPGRADEABLE_LOADER) || program.data.length < 36) {
    throw new RelayerKeyError(`${programId.toBase58()} is not an upgradeable program on this cluster.`);
  }
  // UpgradeableLoaderState::Program { programdata_address } = tag u32 (2), then 32 bytes.
  if (program.data.readUInt32LE(0) !== 2) {
    throw new RelayerKeyError("Unexpected program account layout.");
  }
  const programData = new PublicKey(program.data.subarray(4, 36));
  const pd = await connection.getAccountInfo(programData);
  // UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address: Option<Pubkey> }
  // = tag u32 (3), slot u64, option u8, then 32 bytes when the option is Some.
  if (!pd || pd.data.length < 13 || pd.data.readUInt32LE(0) !== 3) {
    throw new RelayerKeyError("Unexpected program data account layout.");
  }
  if (pd.data[12] === 0) return null;
  return new PublicKey(pd.data.subarray(13, 45));
}

/** Refuse to run as the program's upgrade authority. */
export async function assertNotUpgradeAuthority(connection, programId, relayerPubkey) {
  const authority = await upgradeAuthority(connection, programId);
  if (authority && authority.equals(relayerPubkey)) {
    throw new RelayerKeyError(
      `RELAYER_KEYPAIR is the program's upgrade authority (${authority.toBase58()}). A relayer holds ` +
        "its key in an internet-facing process, so it must never be the key that can replace the " +
        "program. Use a dedicated hot wallet."
    );
  }
}
