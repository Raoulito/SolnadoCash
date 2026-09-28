// snarkjs ships no type declarations. Only the calls the app's own code makes are declared, so a
// new use has to be typed deliberately rather than falling through to `any` everywhere.
declare module 'snarkjs' {
  export const groth16: {
    verify(
      vk: unknown,
      publicSignals: string[],
      proof: unknown
    ): Promise<boolean>;
  };
  export const zKey: {
    exportVerificationKey(zkeyFileName: string): Promise<Record<string, unknown>>;
  };
}
