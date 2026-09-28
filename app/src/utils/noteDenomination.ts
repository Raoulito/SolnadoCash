// app/src/utils/noteDenomination.ts
//
// L-4. A note states its own denomination, and nothing checks that claim against the pool it names.
// The program accepts any 32-byte commitment into any pool and pays pool.denomination, and the
// circuit takes the denomination only as a private input. So a leaf built for 100 SOL can be
// deposited into the 0.1 SOL pool for 0.1 SOL and withdrawn for 0.0997 SOL, and the app displayed
// "100 SOL" for it the whole way. Reproduced on a local validator against the deployed program.
//
// The note's value is still needed to prove (it is inside the leaf), but every amount the app shows
// or validates comes from the pool, and a disagreement is stated plainly.

const sol = (lamports: bigint) => (Number(lamports) / 1e9).toString();

/** A warning when a note claims a different amount than its pool pays, otherwise null. */
export function denominationMismatch(noteLamports: bigint, poolLamports: bigint): string | null {
  if (noteLamports === poolLamports) return null;
  return (
    `This note says ${sol(noteLamports)} SOL, but its pool pays ${sol(poolLamports)} SOL per ` +
    `withdrawal, so that is the most you can receive. A note is only worth what its pool pays. ` +
    `One that claims more was not made by a deposit of that amount, or has been altered: do not ` +
    `buy it or accept it as payment for its stated amount.`
  );
}
