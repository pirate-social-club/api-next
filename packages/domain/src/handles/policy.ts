// Handle policy pure core, ported from the old
// communities/handles/handle-policy-service.ts. The old module had no unit
// suite; the invariants here were characterized against its observed behavior
// (2026-08-15). HttpError throws become plain Errors carrying stable message
// codes; the application layer maps them onto the error catalog.

export type HandleClaimSettings = {
  flat_price_cents?: number | undefined;
  premium_price_cents?: number | undefined;
  premium_max_length?: number | undefined;
  min_length?: number | undefined;
  max_length?: number | undefined;
  quote_ttl_seconds?: number | undefined;
  reserved_labels?: string[] | undefined;
  special_price_cents_by_label?: Record<string, number> | undefined;
  issuance_mode?: "app_internal" | "spaces_subspace" | undefined;
};

export function normalizeCommunityHandleLabel(desiredLabel: unknown): {
  labelNormalized: string;
  labelDisplay: string;
} {
  if (typeof desiredLabel !== "string") {
    throw new Error("invalid_desired_label");
  }
  const trimmed = desiredLabel.trim().toLowerCase();
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const withoutSuffix = withoutAt.includes("@")
    ? withoutAt.slice(0, withoutAt.indexOf("@"))
    : withoutAt;

  const isAsciiLabel = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(withoutSuffix);
  const isPunycodeLabel = /^xn--[a-z0-9-]+$/u.test(withoutSuffix);
  if (!withoutSuffix || (!isAsciiLabel && !isPunycodeLabel)) {
    throw new Error("invalid_desired_label");
  }
  return { labelNormalized: withoutSuffix, labelDisplay: withoutSuffix };
}

export function parseHandleClaimSettings(raw: string | null): HandleClaimSettings {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      flat_price_cents: finiteNonNegativeInteger(parsed.flat_price_cents),
      premium_price_cents: finiteNonNegativeInteger(parsed.premium_price_cents),
      premium_max_length: finitePositiveInteger(parsed.premium_max_length),
      min_length: finitePositiveInteger(parsed.min_length),
      max_length: finitePositiveInteger(parsed.max_length),
      quote_ttl_seconds: finitePositiveInteger(parsed.quote_ttl_seconds),
      issuance_mode: parsed.issuance_mode === "spaces_subspace" ? "spaces_subspace" : undefined,
      reserved_labels: Array.isArray(parsed.reserved_labels)
        ? parsed.reserved_labels.filter((value): value is string => typeof value === "string")
        : undefined,
      special_price_cents_by_label: parseSpecialPrices(parsed.special_price_cents_by_label),
    };
  } catch {
    throw new Error("invalid_settings_json");
  }
}

function parseSpecialPrices(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .map(([label, price]) => {
      const parsedPrice = finiteNonNegativeInteger(price);
      if (parsedPrice == null) return null;
      return [normalizeCommunityHandleLabel(label).labelNormalized, parsedPrice] as const;
    })
    .filter((entry): entry is readonly [string, number] => entry != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

export function withHandlePrefix(prefix: string, value: string): string {
  return value.startsWith(`${prefix}_`) ? value : `${prefix}_${value}`;
}

export function protocolIssuanceRequired(settings: HandleClaimSettings): boolean {
  return settings.issuance_mode === "spaces_subspace";
}

// Policy writes reject spaces_subspace outright; app_internal and unset stay
// writable. Anything else is a bad request.
export function assertWritableHandleIssuanceMode(
  value: unknown,
): HandleClaimSettings["issuance_mode"] {
  if (value == null || value === "app_internal") return undefined;
  if (value === "spaces_subspace") {
    throw new Error("protocol_issued_names_unavailable");
  }
  throw new Error("invalid_issuance_mode");
}

export function namespaceSupportsSpacesSubspace(
  policy: Pick<NamespacePolicyLabels, "display_label" | "normalized_label" | "route_family">,
): boolean {
  return (
    policy.route_family === "spaces" ||
    policy.display_label.startsWith("@") ||
    policy.normalized_label.startsWith("@")
  );
}

export type NamespacePolicyLabels = {
  display_label: string;
  normalized_label: string;
  route_family: string | null;
};

function optionalIntegerSetting(
  value: unknown,
  key: keyof HandleClaimSettings,
  options: { min: number },
): number | undefined {
  if (value == null) return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < options.min) {
    throw new Error(`${String(key)}_must_be_integer_min_${options.min}`);
  }
  return numeric;
}

export function sanitizeSettings(
  input: HandleClaimSettings | null | undefined,
): HandleClaimSettings {
  if (!input) return {};
  const settings: HandleClaimSettings = {
    flat_price_cents: optionalIntegerSetting(input.flat_price_cents, "flat_price_cents", {
      min: 0,
    }),
    premium_price_cents: optionalIntegerSetting(input.premium_price_cents, "premium_price_cents", {
      min: 0,
    }),
    premium_max_length: optionalIntegerSetting(input.premium_max_length, "premium_max_length", {
      min: 1,
    }),
    min_length: optionalIntegerSetting(input.min_length, "min_length", { min: 1 }),
    max_length: optionalIntegerSetting(input.max_length, "max_length", { min: 1 }),
    quote_ttl_seconds: optionalIntegerSetting(input.quote_ttl_seconds, "quote_ttl_seconds", {
      min: 60,
    }),
    issuance_mode: assertWritableHandleIssuanceMode(input.issuance_mode),
    reserved_labels: Array.isArray(input.reserved_labels)
      ? input.reserved_labels.map((label) => normalizeCommunityHandleLabel(label).labelNormalized)
      : undefined,
    special_price_cents_by_label: parseSpecialPrices(input.special_price_cents_by_label),
  };
  if (
    settings.min_length != null &&
    settings.max_length != null &&
    settings.min_length > settings.max_length
  ) {
    throw new Error("min_length_must_be_lte_max_length");
  }
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as HandleClaimSettings;
}
