import type { ConflictDetail } from "./outcomes.ts";
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
export class RecordConflict extends Error {
  readonly reason: "delegation_conflict" | "delegation_target_inactive";
  readonly detail: ConflictDetail;
  constructor(reason: RecordConflict["reason"], detail: ConflictDetail) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}
export async function preflight(
  existing: readonly Record[],
  delegation: Delegation,
  digest: string,
) {
  const text = delegationRecord(delegation),
    challenge = challengeRecord(digest);
  const selected = inspectRecords(existing, delegation);
  // An existing freshness record may belong to another in-flight ceremony.
  // Replacing it requires an explicit replacement flow, outside this slice.
  if (selected.challenge)
    throw new RecordConflict("delegation_conflict", "challenge_present");
  const records = [
    ...existing,
    ...(selected.routing
      ? []
      : [{ type: "NS", ns: routingRecord(delegation) }]),
    ...(selected.delegation ? [] : [{ type: "TXT", txt: [text] }]),
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

export function routingRecord(d: Pick<Delegation, "registry" | "chainId">) {
  return `${d.registry}.${d.chainId}._evm.`;
}
/** Matches the frozen resolver grammar; no legacy resolver runtime dependency. */
export function inspectRecords(
  existing: readonly Record[],
  expected: Delegation,
) {
  const targets = existing.filter(
    (r) =>
      r.type === "NS" &&
      typeof r.ns === "string" &&
      /(^|\.)_evm\.?$/i.test(r.ns),
  );
  if (targets.length > 1)
    throw new RecordConflict("delegation_conflict", "ambiguous_routing");
  const routing = targets[0]?.ns as string | undefined;
  if (routing) {
    const match = /^0x([0-9a-f]{40})\.([1-9][0-9]{0,19})\._evm\.?$/i.exec(
      routing,
    );
    if (!match)
      throw new RecordConflict("delegation_conflict", "malformed_record");
    if (BigInt(match[2]) !== BigInt(expected.chainId))
      throw new RecordConflict(
        "delegation_target_inactive",
        "active_registry_mismatch",
      );
    if (`0x${match[1].toLowerCase()}` !== expected.registry)
      throw new RecordConflict(
        "delegation_conflict",
        "active_registry_mismatch",
      );
  }
  const chains = new Set<number>();
  let delegation: string | undefined, challenge: string | undefined;
  for (const r of existing) {
    if (r.type !== "TXT" || !Array.isArray(r.txt)) continue;
    // Protocol records are one canonical string in their own TXT record.
    for (const value of r.txt) {
      if (typeof value !== "string" || !/^(pd1:|pc1:)/.test(value)) continue;
      if (r.txt.length !== 1)
        throw new RecordConflict("delegation_conflict", "malformed_record");
      if (value.startsWith("pc1:")) {
        let valid = false;
        try {
          valid =
            value.length === 47 && unbase64url(value.slice(4)).length === 32;
        } catch {
          /* classified below */
        }
        if (challenge || !valid)
          throw new RecordConflict("delegation_conflict", "malformed_record");
        challenge = value;
      } else {
        let d: Delegation;
        try {
          d = parseDelegation(value);
        } catch {
          throw new RecordConflict("delegation_conflict", "malformed_record");
        }
        if (chains.has(d.chainId))
          throw new RecordConflict("delegation_conflict", "duplicate_chain");
        chains.add(d.chainId);
        if (d.chainId === expected.chainId) {
          if (
            value !==
            delegationRecord({
              chainId: expected.chainId,
              registry: expected.registry,
              controller: expected.controller,
              communityId: expected.communityId,
            })
          )
            throw new RecordConflict(
              "delegation_conflict",
              "active_registry_mismatch",
            );
          delegation = value;
        }
      }
    }
  }
  return { routing, delegation, challenge };
}
