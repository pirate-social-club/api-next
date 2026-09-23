import type { MegapotV2Environment } from "./megapot-v2.ts";

type Row = Readonly<Record<string, unknown>>;

export type MegapotImplementationIdentity = Readonly<{
  usdcImplementationAddress?: string;
  usdcImplementationCodeHash?: string;
}>;

function identity(address: unknown, codeHash: unknown): MegapotImplementationIdentity {
  if (
    typeof address !== "string" ||
    !/^0x[0-9a-f]{40}$/u.test(address) ||
    address === "0x0000000000000000000000000000000000000000" ||
    typeof codeHash !== "string" ||
    !/^0x[0-9a-f]{64}$/u.test(codeHash)
  ) {
    throw new Error("invalid megapot USDC implementation identity");
  }
  return {
    usdcImplementationAddress: address,
    usdcImplementationCodeHash: codeHash,
  };
}

export function megapotImplementationIdentityFromCandidate(
  candidate: MegapotImplementationIdentity,
): MegapotImplementationIdentity {
  const { usdcImplementationAddress: address, usdcImplementationCodeHash: codeHash } = candidate;
  if (address === undefined && codeHash === undefined) return {};
  return identity(address, codeHash);
}

export function megapotImplementationIdentityFromRow(
  row: Row,
  environment: MegapotV2Environment,
): MegapotImplementationIdentity {
  const address = row.usdc_implementation_address;
  const codeHash = row.usdc_implementation_code_hash;
  if (address === null && codeHash === null && environment !== "production") return {};
  return identity(address, codeHash);
}
