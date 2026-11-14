import { Schema } from "effect";
import { preflightEncodeHnsResourceV1 } from "./resource-codec.ts";
import type { HnsRootResourceRecordV1 as Record } from "./resource-types.ts";

export const Address = Schema.String.check(
  Schema.isPattern(/^0x[0-9a-f]{40}$/),
);
export const Hash = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/));
export const Delegation = Schema.Struct({
  chainId: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 4294967295 }),
  ),
  registry: Address,
  controller: Address,
  communityId: Hash,
});
export type Delegation = typeof Delegation.Type;
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function unbase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("delegation_malformed");
  const bytes = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (base64url(bytes) !== value) throw new Error("delegation_malformed");
  return bytes;
}
export function delegationRecord(input: Delegation): string {
  const d = Schema.decodeUnknownSync(Delegation)(input, {
    onExcessProperty: "error",
  });
  const bytes = new Uint8Array(76);
  new DataView(bytes.buffer).setUint32(0, d.chainId);
  bytes.set(fromHex(d.registry), 4);
  bytes.set(fromHex(d.controller), 24);
  bytes.set(fromHex(d.communityId), 44);
  return "pd1:" + base64url(bytes);
}
export function parseDelegation(value: string): Delegation {
  if (!value.startsWith("pd1:")) throw new Error("delegation_malformed");
  const bytes = unbase64url(value.slice(4));
  if (bytes.length !== 76) throw new Error("delegation_malformed");
  return Schema.decodeUnknownSync(Delegation)({
    chainId: new DataView(bytes.buffer).getUint32(0),
    registry: toHex(bytes.slice(4, 24)),
    controller: toHex(bytes.slice(24, 44)),
    communityId: toHex(bytes.slice(44)),
  });
}
export function challengeRecord(digest: string): string {
  Schema.decodeUnknownSync(Hash)(digest);
  return "pc1:" + base64url(fromHex(digest));
}
export function fromHex(value: string): Uint8Array {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(value)) throw new Error("invalid_hex");
  return Uint8Array.from(value.slice(2).match(/../g) ?? [], (x) =>
    parseInt(x, 16),
  );
}
export function toHex(bytes: Uint8Array): string {
  return (
    "0x" + Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("")
  );
}
export async function preflight(
  existing: readonly Record[],
  delegation: Delegation,
  digest: string,
) {
  const text = delegationRecord(delegation),
    challenge = challengeRecord(digest);
  const existingProof = existing.filter(
    (r) =>
      r.type === "TXT" &&
      Array.isArray(r.txt) &&
      r.txt.some(
        (s: unknown) =>
          typeof s === "string" &&
          (s.startsWith("pd1:") || s.startsWith("pc1:")),
      ),
  );
  // Replacement needs a separately consented before-image; never silently remove an old proof.
  if (existingProof.length) throw new Error("proof_record_conflict");
  const records = [
    ...existing,
    { type: "TXT", txt: [text] },
    { type: "TXT", txt: [challenge] },
  ];
  const before = await preflightEncodeHnsResourceV1(existing);
  const after = await preflightEncodeHnsResourceV1(records);
  return {
    records,
    beforeBytes: before.bytes.length,
    afterBytes: after.bytes.length,
    bytes: after.bytes,
    sha256: after.sha256,
    beforeSha256: before.sha256,
  };
}
