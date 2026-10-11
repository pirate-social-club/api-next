export type PowerDnsWildcardFamilyRrset = Readonly<{
  readonly type: string;
  readonly ttl: number;
  readonly records: readonly string[];
}>;

export class PowerDnsWildcardFamilyRefusal extends Error {}

export type PowerDnsWildcardFamilyResult = Readonly<{
  readonly family_state: "absent" | "partial" | "complete";
  /** False when the zone already held what was asked for and nothing was sent to change it. */
  readonly changed: boolean;
  readonly serial_before: number;
  readonly serial_after: number;
  readonly wildcard_family_before: readonly PowerDnsWildcardFamilyRrset[];
  readonly wildcard_family_after: readonly PowerDnsWildcardFamilyRrset[];
}>;

/** The wildcard owner's AAAA and HTTPS record sets as the provider holds them. */
export function wildcardFamilyOfZone(
  value: unknown,
  zoneName: string,
): readonly PowerDnsWildcardFamilyRrset[] {
  const rrsets =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Reflect.get(value, "rrsets")
      : undefined;
  if (!Array.isArray(rrsets)) throw new Error("PowerDNS retained rrsets are unavailable");
  const wildcard = `*.${zoneName}`;
  return rrsets
    .filter(
      (candidate): candidate is Record<string, unknown> =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        Reflect.get(candidate, "name") === wildcard &&
        (Reflect.get(candidate, "type") === "AAAA" || Reflect.get(candidate, "type") === "HTTPS"),
    )
    .map((candidate) => {
      const records = candidate.records;
      if (typeof candidate.ttl !== "number" || !Array.isArray(records))
        throw new Error("PowerDNS returned invalid zone data");
      return {
        type: String(candidate.type),
        ttl: candidate.ttl,
        records: records.map((record) => {
          const content =
            record !== null && typeof record === "object" && !Array.isArray(record)
              ? Reflect.get(record, "content")
              : undefined;
          if (typeof content !== "string" || Reflect.get(record, "disabled") !== false)
            throw new Error("PowerDNS returned invalid zone data");
          return content;
        }),
      };
    })
    .sort((left, right) => left.type.localeCompare(right.type));
}
