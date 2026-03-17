declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, string | string[]>,
      wasmFile: string,
      zkeyFileName: string
    ): Promise<{ proof: any; publicSignals: string[] }>;
    verify(
      vk: any,
      publicSignals: string[],
      proof: any
    ): Promise<boolean>;
  };
}

declare module "circomlibjs" {
  export function buildPoseidon(): Promise<any>;
}
