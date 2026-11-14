import { Schema } from "effect";
import {
  encodeAbiParameters,
  keccak256,
  stringToHex,
  hashTypedData,
  type Hex,
} from "viem";
import { Address, Hash, toHex } from "./records.ts";
export const Seconds = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const Binding = Schema.Struct({
  network: Schema.Literals(["main", "regtest"]),
  tld: Schema.String.check(
    Schema.isPattern(/^(?!xn--)(?!..--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  ),
  chainId: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 4294967295 }),
  ),
  registry: Address,
  wrapper: Address,
  controller: Address,
  grantSigner: Address,
  installationKey: Address,
  communityId: Hash,
  installationId: Hash,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  hostingOrigin: Schema.String,
  sourceSha256: Hash,
  deploymentDigest: Hash,
});
export type Binding = typeof Binding.Type;
const hashString = (s: string) => keccak256(stringToHex(s));
export function namespaceId(tld: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [hashString("pirate.namespace/1"), hashString(tld)],
    ),
  );
}
export function bindingDigest(input: Binding): Hex {
  const b = Schema.decodeUnknownSync(Binding)(input, {
    onExcessProperty: "error",
  });
  const origin = new URL(b.hostingOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== b.hostingOrigin ||
    origin.username ||
    origin.password
  )
    throw new Error("invalid_origin");
  const types = [
    "bytes32",
    "bytes32",
    "bytes32",
    "uint256",
    "address",
    "address",
    "address",
    "address",
    "address",
    "bytes32",
    "bytes32",
    "uint64",
    "bytes32",
    "bytes32",
    "bytes32",
  ] as const;
  return keccak256(
    encodeAbiParameters(
      types.map((type) => ({ type })),
      [
        hashString("pirate.namespace-ceremony-binding/1"),
        hashString(b.network),
        namespaceId(b.tld),
        BigInt(b.chainId),
        b.registry as Hex,
        b.wrapper as Hex,
        b.controller as Hex,
        b.grantSigner as Hex,
        b.installationKey as Hex,
        b.communityId as Hex,
        b.installationId as Hex,
        BigInt(b.revision),
        hashString(b.hostingOrigin),
        b.sourceSha256 as Hex,
        b.deploymentDigest as Hex,
      ],
    ),
  );
}
export const consentTypes = {
  CeremonyConsent: [
    { name: "ceremonyId", type: "bytes32" },
    { name: "bindingDigest", type: "bytes32" },
    { name: "resourceDigest", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
} as const;
export function consentData(
  binding: Binding,
  fields: {
    ceremonyId: string;
    bindingDigest: string;
    resourceDigest: string;
    nonce: string;
    issuedAt: number;
    deadline: number;
  },
) {
  return {
    domain: {
      name: "PirateNamespaceCeremony",
      version: "1",
      chainId: binding.chainId,
      verifyingContract: binding.wrapper as Hex,
    },
    primaryType: "CeremonyConsent" as const,
    types: consentTypes,
    message: {
      ceremonyId: fields.ceremonyId as Hex,
      bindingDigest: fields.bindingDigest as Hex,
      resourceDigest: fields.resourceDigest as Hex,
      nonce: fields.nonce as Hex,
      issuedAt: BigInt(fields.issuedAt),
      deadline: BigInt(fields.deadline),
    },
  };
}
export function consentHash(...args: Parameters<typeof consentData>): Hex {
  return hashTypedData(consentData(...args));
}
export async function challengeDigest(
  id: string,
  binding: string,
  nonce: string,
  publicationDeadline: number,
  maturitySeconds = 86400,
): Promise<Hex> {
  const encoded = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "uint64" },
    ],
    [
      hashString("pirate.hns-publication-challenge/1"),
      id as Hex,
      binding as Hex,
      nonce as Hex,
      BigInt(publicationDeadline),
      BigInt(maturitySeconds),
    ],
  );
  const bytes = Uint8Array.from(encoded.slice(2).match(/../g) ?? [], (x) =>
    parseInt(x, 16),
  );
  return toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ) as Hex;
}
