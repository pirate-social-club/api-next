import { Schema } from "effect";
import { Hash, parseDelegation, type Delegation } from "./records.ts";
import { Seconds } from "./protocol.ts";
export const Observation = Schema.Struct({
  network: Schema.Literals(["main", "regtest"]),
  genesis: Hash,
  tipHash: Hash,
  tipHeight: Seconds,
  tipTime: Seconds,
  fetchedAt: Seconds,
  safeRoot: Hash,
  safeResourceDigest: Hash,
  safeOwnershipEpoch: Hash,
  safeHeight: Seconds,
  resourceDigest: Hash,
  ownershipEpoch: Hash,
  inclusionHash: Hash,
  inclusionHeight: Seconds,
  inclusionTime: Seconds,
  canonical: Schema.Boolean,
  transferPending: Schema.Boolean,
  expired: Schema.Boolean,
  delegation: Schema.String,
  challenge: Schema.String,
});
export type Observation = typeof Observation.Type;
export type EvidenceOutcome =
  | {
      status: "unavailable";
      reason:
        | "observer_timeout"
        | "observer_stale"
        | "observer_disagreement"
        | "chain_freshness_unconfirmed"
        | "ownership_history_unavailable"
        | "internal_error";
    }
  | {
      status: "waiting";
      reason: "transfer_pending" | "publication_pending" | "maturity_pending";
      observation?: Observation;
    }
  | { status: "denied"; reason: "ownership_changed" | "delegation_revoked" }
  | { status: "verified"; observation: Observation };
export function safeEntryHeight(height: number, interval: number): number {
  if (
    !Number.isSafeInteger(height) ||
    height < 0 ||
    !Number.isSafeInteger(interval) ||
    interval < 1
  )
    throw new Error("invalid_height");
  const mod = height % interval;
  return height - (mod >= 12 ? 0 : mod);
}
export function agree(
  a: Observation | null,
  b: Observation | null,
  now: number,
  expected: Delegation & {
    network: string;
    genesis: string;
    challenge: string;
    resourceDigest: string;
    ownershipEpoch?: string;
  },
): EvidenceOutcome {
  if (!a || !b) return { status: "unavailable", reason: "observer_timeout" };
  const decode = Schema.decodeUnknownSync(Observation);
  try {
    decode(a, { onExcessProperty: "error" });
    decode(b, { onExcessProperty: "error" });
  } catch {
    return { status: "unavailable", reason: "observer_stale" };
  }
  if (
    [a, b].some(
      (o) =>
        o.fetchedAt > now ||
        now - o.fetchedAt > 60 ||
        o.tipTime > now + 120 ||
        o.safeHeight > o.tipHeight,
    )
  )
    return { status: "unavailable", reason: "observer_stale" };
  // Compare both reachable observers; never downgrade disagreement to a one-node quorum.
  const keys = [
    "network",
    "genesis",
    "tipHash",
    "tipHeight",
    "tipTime",
    "safeRoot",
    "safeResourceDigest",
    "safeOwnershipEpoch",
    "safeHeight",
    "resourceDigest",
    "ownershipEpoch",
    "inclusionHash",
    "inclusionHeight",
    "inclusionTime",
    "canonical",
    "transferPending",
    "expired",
    "delegation",
    "challenge",
  ] as const;
  if (keys.some((k) => a[k] !== b[k]))
    return { status: "unavailable", reason: "observer_disagreement" };
  if (
    a.network !== expected.network ||
    a.genesis !== expected.genesis ||
    !a.canonical
  )
    return { status: "unavailable", reason: "observer_disagreement" };
  if (now - a.tipTime > 21600)
    return { status: "unavailable", reason: "chain_freshness_unconfirmed" };
  // Current/safe ownership disagreement is provisional, even when both nodes
  // agree on the tip. A reorg must be able to restore the original ceremony.
  if (a.ownershipEpoch !== a.safeOwnershipEpoch)
    return { status: "unavailable", reason: "observer_stale" };
  if (
    a.expired ||
    (expected.ownershipEpoch && a.ownershipEpoch !== expected.ownershipEpoch)
  )
    return { status: "denied", reason: "ownership_changed" };
  if (a.transferPending)
    return { status: "waiting", reason: "transfer_pending" };
  let delegation: Delegation;
  try {
    delegation = parseDelegation(a.delegation);
  } catch {
    return { status: "waiting", reason: "publication_pending" };
  }
  if (
    JSON.stringify(delegation) !==
      JSON.stringify({
        chainId: expected.chainId,
        registry: expected.registry,
        controller: expected.controller,
        communityId: expected.communityId,
      }) ||
    a.challenge !== expected.challenge ||
    a.resourceDigest !== expected.resourceDigest
  )
    return { status: "waiting", reason: "publication_pending" };
  if (
    a.inclusionHeight > a.safeHeight ||
    a.safeResourceDigest !== a.resourceDigest ||
    a.safeOwnershipEpoch !== a.ownershipEpoch
  )
    return { status: "waiting", reason: "maturity_pending", observation: a };
  return { status: "verified", observation: a };
}
