import { HnsAuthoritySuccessorPromotionRefusal } from "../../../packages/platform-cf/src/hns-authority-successor-promotion.ts";
import { HnsZoneAdoptionRefusal } from "../../../packages/platform-cf/src/hns-zone-adoption.ts";
import { HnsZoneAdoptionDeltaRefusal } from "../../../packages/platform-cf/src/hns-zone-adoption-delta.ts";
import { HnsRootReadinessObservationError } from "./observe-root.ts";
import { PowerDnsWildcardFamilyRefusal } from "./powerdns.ts";

// Exact fixed messages, never a prefix/character-class trust decision.
const successorRefusals = new Set([
  "HNS successor serving dependencies changed",
  "HNS successor namespace authority changed",
  "HNS successor inventory environment changed",
  "HNS successor observation is stale",
  "HNS successor health fence is invalid",
]);
const providerFailures = new Set([
  "PowerDNS request timed out",
  "HNS authority transfer timed out",
  "PowerDNS zone inspection failed",
  "PowerDNS DNSSEC key inspection failed",
  "PowerDNS DNSSEC key changed after preparation",
  "PowerDNS zone reconciliation failed",
  "PowerDNS DNSSEC rectification failed",
  "PowerDNS secondary notification failed",
  "PowerDNS zone serial did not advance",
  "PowerDNS wildcard address records did not take effect",
  "HNS zone adoption observation file is unavailable",
  "HNS authority provisioner configuration is invalid",
]);

export function zoneAdoptionRefusalReason(error: unknown): string | null {
  if (
    error instanceof HnsZoneAdoptionRefusal ||
    error instanceof HnsZoneAdoptionDeltaRefusal ||
    error instanceof PowerDnsWildcardFamilyRefusal
  )
    return error.message;
  if (error instanceof HnsAuthoritySuccessorPromotionRefusal)
    return "authority successor promotion refused";
  if (error instanceof HnsRootReadinessObservationError) return error.code;
  if (error instanceof Error && successorRefusals.has(error.message)) return error.message;
  return null;
}

export function describeZoneAdoptionFailure(error: unknown): Readonly<Record<string, string>> {
  if (!(error instanceof Error)) return { reason: "unclassified" };
  const code = "code" in error ? error.code : undefined;
  return {
    reason:
      zoneAdoptionRefusalReason(error) ??
      (providerFailures.has(error.message) ? error.message : "unclassified"),
    ...(/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? { error_name: error.name } : {}),
    ...(typeof code === "string" && /^[0-9A-Z_]{3,32}$/u.test(code) ? { code } : {}),
  };
}
