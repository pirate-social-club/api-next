import type { HnsAuthorityEmitViewV1 } from "@pirate/application/hns-host-persistence";
import { deriveCanonicalHnsAuthorityZoneBytesV1 } from "@pirate/hns-dns-runtime/dns-axfr-zone";

type DetachedDnsTranscriptEntryV1 = Readonly<{
  exchange_kind: "hns_rpc" | "child_authority_dns" | "parent_authority_dns";
  subject_reference: string;
  query_reference: string;
  response_bytes: Uint8Array;
}>;

class HnsAuthoritySuccessorZoneObservationError extends Error {
  readonly name = "HnsAuthoritySuccessorZoneObservationError";
}

function failed(): HnsAuthoritySuccessorZoneObservationError {
  return new HnsAuthoritySuccessorZoneObservationError(
    "HNS authority successor zone observation refused",
  );
}

function exactObject(
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function validLiveAuthorityView(
  value: unknown,
): value is Omit<HnsAuthorityEmitViewV1, "zone_bytes_digest"> {
  return (
    exactObject(value, [
      "attestation_kind",
      "authority_address",
      "outcome",
      "dnskey_key_tag",
      "derived_ds",
    ]) &&
    value.attestation_kind === "operator_attested_authority_view_v1" &&
    typeof value.authority_address === "string" &&
    (value.outcome === "observed" || value.outcome === "unavailable") &&
    (value.dnskey_key_tag === null || Number.isSafeInteger(value.dnskey_key_tag)) &&
    (value.derived_ds === null || Array.isArray(value.derived_ds))
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))));
}

export async function deriveHnsAuthoritySuccessorChildZoneObservationV1(
  rootLabel: string,
  expectedAuthorityAddresses: readonly [string, string],
  transcript: ReadonlyArray<DetachedDnsTranscriptEntryV1>,
  liveViews: ReadonlyArray<Omit<HnsAuthorityEmitViewV1, "zone_bytes_digest">>,
): Promise<
  Readonly<{
    zone_bytes: Uint8Array;
    zone_bytes_digest: string;
    authority_views: readonly [HnsAuthorityEmitViewV1, HnsAuthorityEmitViewV1];
  }>
> {
  if (
    liveViews.length !== 2 ||
    !liveViews.every(validLiveAuthorityView) ||
    new Set(liveViews.map((view) => view.authority_address)).size !== 2
  ) {
    throw failed();
  }
  const zones: Uint8Array[] = [];
  const views: HnsAuthorityEmitViewV1[] = [];
  for (const address of expectedAuthorityAddresses) {
    const entries = transcript.filter(
      (entry) =>
        entry.exchange_kind === "child_authority_dns" &&
        entry.subject_reference === address &&
        entry.query_reference === `axfr:${rootLabel}`,
    );
    const liveView = liveViews.find((view) => view.authority_address === address);
    if (entries.length !== 1 || liveView === undefined || liveView.outcome !== "observed") {
      throw failed();
    }
    let zoneBytes: Uint8Array;
    try {
      zoneBytes = deriveCanonicalHnsAuthorityZoneBytesV1({
        zone_name: rootLabel,
        response_sequence_bytes: entries[0]?.response_bytes ?? new Uint8Array(),
      });
    } catch {
      throw failed();
    }
    zones.push(zoneBytes);
    views.push({
      attestation_kind: liveView.attestation_kind,
      authority_address: liveView.authority_address,
      outcome: liveView.outcome,
      zone_bytes_digest: await sha256(zoneBytes),
      dnskey_key_tag: liveView.dnskey_key_tag,
      derived_ds: liveView.derived_ds,
    });
  }
  const firstZone = zones[0];
  const secondZone = zones[1];
  const firstView = views[0];
  const secondView = views[1];
  if (
    firstZone === undefined ||
    secondZone === undefined ||
    firstView === undefined ||
    secondView === undefined ||
    !equalBytes(firstZone, secondZone) ||
    firstView.zone_bytes_digest === null
  ) {
    throw failed();
  }
  return {
    zone_bytes: firstZone,
    zone_bytes_digest: firstView.zone_bytes_digest,
    authority_views: [firstView, secondView],
  };
}
