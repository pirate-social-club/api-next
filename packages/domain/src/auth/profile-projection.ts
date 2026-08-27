import { normalizeIdentityCountryAlpha2 } from "../gates/country-codes.ts";

const NORMALIZABLE_PUBLIC_ID_PREFIXES = new Set(["usr"]);

type VerificationProvider = "self" | "zkpassport" | "very";
type VerificationState = "unverified" | "pending" | "verified" | "expired";

type VerificationCapabilityState = {
  readonly state: VerificationState;
  readonly provider?: VerificationProvider | null;
  readonly proof_type?: "unique_human" | null;
  readonly mechanism?: string | null;
  readonly verified_at?: number | null;
};

type VerifiedCapabilityState<ProofType extends string> = {
  readonly state: Exclude<VerificationState, "pending">;
  readonly provider?: Exclude<VerificationProvider, "very"> | null;
  readonly proof_type?: ProofType | null;
  readonly mechanism?: string | null;
  readonly verified_at?: number | null;
};

type WalletScoreCapabilityState = {
  readonly state: Exclude<VerificationState, "pending">;
  readonly provider?: "passport" | null;
  readonly proof_type?: "wallet_score" | null;
  readonly mechanism?: "stamps-api-v2" | null;
  readonly verified_at?: number | null;
  readonly score_decimal?: string | null;
  readonly score_threshold_decimal?: string | null;
  readonly passing_score?: boolean | null;
  readonly last_scored_at?: number | null;
  readonly expires_at?: number | null;
  readonly stamps?:
    | readonly {
        readonly stamp_name?: string;
        readonly stamp_score_decimal?: string;
      }[]
    | null;
};

export type VerificationCapabilitiesResponse = {
  readonly unique_human: VerificationCapabilityState;
  readonly age_over_18: VerifiedCapabilityState<"age_over_18">;
  readonly minimum_age: VerifiedCapabilityState<"minimum_age"> & {
    readonly value?: number | null;
  };
  readonly nationality: VerifiedCapabilityState<"nationality"> & {
    readonly value?: string | null;
  };
  readonly gender: VerifiedCapabilityState<"gender"> & {
    readonly value?: "M" | "F" | null;
  };
  readonly wallet_score: WalletScoreCapabilityState;
};

export type UserVerificationState =
  | "unverified"
  | "pending"
  | "verified"
  | "reverification_required";

export type UserResponse = {
  readonly id: string;
  readonly object: "user";
  readonly primary_wallet_attachment?: string | null;
  readonly verification_state: UserVerificationState;
  readonly capability_provider?: "self" | "zkpassport" | "very" | null;
  readonly verification_capabilities: VerificationCapabilitiesResponse;
  readonly verified_at?: number | null;
  readonly created: number;
};

export type LegacyUserInput = {
  readonly user_id: string;
  readonly primary_wallet_attachment_id?: string | null;
  readonly verification_state: UserVerificationState;
  readonly capability_provider?: "self" | "very" | null;
  readonly verification_capabilities: VerificationCapabilitiesResponse;
  readonly verified_at?: string | null;
  readonly created_at: string;
};

export type UserRowInput = {
  readonly user_id: string;
  readonly primary_wallet_attachment_id: string | null;
  readonly capability_provider?: string | null;
  readonly verification_capabilities_json: string | null | undefined;
  readonly verified_at: string | null;
  readonly created_at: string;
};

export type ProfileRowInput = {
  readonly user_id: string;
  readonly display_name: string | null;
  readonly bio: string | null;
  readonly bio_source: "ens" | "manual" | "none" | null;
  readonly avatar_ref: string | null;
  readonly avatar_source: "ens" | "upload" | "none" | null;
  readonly cover_ref: string | null;
  readonly cover_source: "ens" | "upload" | "none" | null;
  readonly preferred_locale: string | null;
  readonly display_verified_nationality_badge: number;
  readonly global_handle_id: string;
  readonly primary_linked_handle_id: string | null;
  readonly xmtp_inbox_id: string | null;
  readonly created_at: string;
};

export type GlobalHandleRowInput = {
  readonly global_handle_id: string;
  readonly platform_handle_id?: string;
  readonly owner_persona_id?: string;
  readonly generation?: number;
  readonly state_hash?: string;
  readonly cleanup_rename_available?: boolean;
  readonly label_display: string;
  readonly status: "active" | "redirect" | "retired";
  readonly tier: "generated" | "standard" | "premium";
  readonly issuance_source:
    | "generated_signup"
    | "free_cleanup_rename"
    | "reddit_verified_claim"
    | "paid_upgrade"
    | "admin_grant";
  readonly redirect_target_global_handle_id: string | null;
  readonly price_paid_cents: number | null;
  readonly free_rename_consumed: number;
  readonly issued_at: string;
  readonly replaced_at: string | null;
};

export type LinkedHandleRowInput = {
  readonly linked_handle_id: string;
  readonly kind: "pirate" | "ens";
  readonly label_display: string;
  readonly verification_state: "verified" | "unverified" | "stale";
  readonly metadata_json: string | null;
};

export type WalletAttachmentRowInput = {
  readonly wallet_attachment_id: string;
  readonly chain_namespace: string;
  readonly wallet_address_display: string;
  readonly is_primary: number;
};

export type GlobalHandleResponse = {
  readonly id: string;
  readonly object: "global_handle";
  readonly platform_handle_id?: string;
  readonly owner_persona_id?: string;
  readonly generation?: number;
  readonly state_hash?: string;
  readonly cleanup_rename_available?: boolean;
  readonly label: string;
  readonly tier: "generated" | "standard" | "premium";
  readonly status: "active" | "redirect" | "retired";
  readonly issuance_source:
    | "generated_signup"
    | "free_cleanup_rename"
    | "reddit_verified_claim"
    | "paid_upgrade"
    | "admin_grant";
  readonly redirect_target_global_handle?: string | null;
  readonly price_paid_cents?: number | null;
  readonly free_rename_consumed?: boolean;
  readonly issued_at: number;
  readonly replaced_at?: number | null;
};

export type LinkedHandleResponse = {
  readonly linked_handle: string;
  readonly label: string;
  readonly kind: "pirate" | "ens";
  readonly verification_state: "verified" | "unverified" | "stale";
  readonly metadata?: JsonObject | null;
};

export type ProfileResponse = {
  readonly id: string;
  readonly object: "profile";
  readonly display_name: string | null;
  readonly avatar_ref: string | null;
  readonly avatar_source: "ens" | "upload" | "none" | null;
  readonly cover_ref: string | null;
  readonly cover_source: "ens" | "upload" | "none" | null;
  readonly bio: string | null;
  readonly bio_source: "ens" | "manual" | "none" | null;
  readonly preferred_locale: string | null;
  readonly display_verified_nationality_badge: boolean;
  readonly nationality_badge_country: string | null;
  readonly linked_handles: readonly LinkedHandleResponse[];
  readonly primary_public_handle: LinkedHandleResponse | null;
  readonly primary_wallet_address: string | null;
  readonly xmtp_inbox: string | null;
  readonly global_handle: GlobalHandleResponse;
  readonly created: number;
};

export type WalletAttachmentResponse = {
  readonly wallet_attachment: string;
  readonly chain_namespace: string;
  readonly wallet_address: string;
  readonly is_primary: boolean;
};

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };

export function publicId(rawId: string, publicPrefix: string): string {
  const prefix = `${publicPrefix}_`;
  if (!NORMALIZABLE_PUBLIC_ID_PREFIXES.has(publicPrefix)) return `${prefix}${rawId}`;

  let normalized = rawId.trim();
  while (normalized.startsWith(prefix)) {
    normalized = normalized.slice(prefix.length);
  }
  return `${prefix}${normalized}`;
}

export function unixSeconds(value: string | Date): number {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Math.floor(timestamp / 1000);
}

export function nullableUnixSeconds(value: string | Date | null | undefined): number | null {
  return value == null ? null : unixSeconds(value);
}

function normalizeCapabilityProvider(
  provider: string | null | undefined,
): "self" | "zkpassport" | "very" | null {
  if (provider === "self" || provider === "very") return provider;
  if (provider === "zkpass") return "zkpassport";
  return null;
}

function buildDefaultVerificationCapabilities(): VerificationCapabilitiesResponse {
  return {
    unique_human: {
      state: "unverified",
      provider: null,
      proof_type: null,
      mechanism: null,
      verified_at: null,
    },
    age_over_18: {
      state: "unverified",
      provider: null,
      proof_type: null,
      mechanism: null,
      verified_at: null,
    },
    minimum_age: {
      state: "unverified",
      value: null,
      provider: null,
      proof_type: null,
      mechanism: null,
      verified_at: null,
    },
    nationality: {
      state: "unverified",
      value: null,
      provider: null,
      proof_type: null,
      mechanism: null,
      verified_at: null,
    },
    gender: {
      state: "unverified",
      value: null,
      provider: null,
      proof_type: null,
      mechanism: null,
      verified_at: null,
    },
    wallet_score: {
      state: "unverified",
      provider: null,
      proof_type: null,
      mechanism: null,
      verified_at: null,
      score_decimal: null,
      score_threshold_decimal: null,
      passing_score: null,
      last_scored_at: null,
      expires_at: null,
      stamps: null,
    },
  };
}

function capabilityTimestampToMs(timestamp: number | string | null | undefined): number | null {
  if (typeof timestamp === "number") {
    const millis = timestamp * 1_000;
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof timestamp === "string") {
    const millis = Date.parse(timestamp);
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

function isExpiredAt(timestamp: number | string | null | undefined, nowMs: number): boolean {
  const expiresMs = capabilityTimestampToMs(timestamp);
  return expiresMs !== null && expiresMs <= nowMs;
}

function isOlderThanTtl(verifiedAt: number | string | null | undefined, nowMs: number): boolean {
  const verifiedMs = capabilityTimestampToMs(verifiedAt);
  return verifiedMs !== null && verifiedMs + 90 * 24 * 60 * 60 * 1_000 <= nowMs;
}

function normalizeCapabilityTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.floor(value) : null;
  }
  if (typeof value === "string") {
    const timestampMs = Date.parse(value);
    return Number.isFinite(timestampMs) ? Math.floor(timestampMs / 1_000) : null;
  }
  return null;
}

function normalizeCapabilityTimestampField(capability: { readonly verified_at?: unknown }): {
  readonly verified_at?: number | null;
} {
  return capability.verified_at === undefined
    ? {}
    : { verified_at: normalizeCapabilityTimestamp(capability.verified_at) };
}

function normalizeVerificationCapabilityTimestamps(
  capabilities: VerificationCapabilitiesResponse,
): VerificationCapabilitiesResponse {
  const walletScore = capabilities.wallet_score;
  return {
    unique_human: {
      ...capabilities.unique_human,
      ...normalizeCapabilityTimestampField(capabilities.unique_human),
    },
    age_over_18: {
      ...capabilities.age_over_18,
      ...normalizeCapabilityTimestampField(capabilities.age_over_18),
    },
    minimum_age: {
      ...capabilities.minimum_age,
      ...normalizeCapabilityTimestampField(capabilities.minimum_age),
    },
    nationality: {
      ...capabilities.nationality,
      ...normalizeCapabilityTimestampField(capabilities.nationality),
    },
    gender: {
      ...capabilities.gender,
      ...normalizeCapabilityTimestampField(capabilities.gender),
    },
    wallet_score: {
      ...walletScore,
      ...normalizeCapabilityTimestampField(walletScore),
      ...(walletScore.last_scored_at === undefined
        ? {}
        : { last_scored_at: normalizeCapabilityTimestamp(walletScore.last_scored_at) }),
      ...(walletScore.expires_at === undefined
        ? {}
        : { expires_at: normalizeCapabilityTimestamp(walletScore.expires_at) }),
    },
  };
}

function applyLazyCapabilityExpiry(
  capabilities: VerificationCapabilitiesResponse,
  nowMs = Date.now(),
): VerificationCapabilitiesResponse {
  const next = {
    unique_human: { ...capabilities.unique_human },
    age_over_18: { ...capabilities.age_over_18 },
    minimum_age: { ...capabilities.minimum_age },
    nationality: { ...capabilities.nationality },
    gender: { ...capabilities.gender },
    wallet_score: { ...capabilities.wallet_score },
  };

  if (
    next.unique_human.state === "verified" &&
    (next.unique_human.provider === "self" ||
      next.unique_human.provider === "very" ||
      next.unique_human.provider === "zkpassport") &&
    isOlderThanTtl(next.unique_human.verified_at, nowMs)
  ) {
    next.unique_human.state = "expired";
  }

  for (const capability of [next.age_over_18, next.minimum_age, next.nationality, next.gender]) {
    if (
      capability.state === "verified" &&
      (capability.provider === "self" || capability.provider === "zkpassport") &&
      isOlderThanTtl(capability.verified_at, nowMs)
    ) {
      capability.state = "expired";
    }
  }

  if (next.wallet_score.state === "verified" && isExpiredAt(next.wallet_score.expires_at, nowMs)) {
    next.wallet_score.state = "expired";
  }

  return next;
}

function parseProfileVerificationCapabilities(
  raw: string | null | undefined,
  nowMs = Date.now(),
): VerificationCapabilitiesResponse {
  const defaults = buildDefaultVerificationCapabilities();
  if (!raw)
    return normalizeVerificationCapabilityTimestamps(applyLazyCapabilityExpiry(defaults, nowMs));

  try {
    const parsed = JSON.parse(raw) as Partial<VerificationCapabilitiesResponse>;
    return normalizeVerificationCapabilityTimestamps(
      applyLazyCapabilityExpiry(
        {
          unique_human: parsed.unique_human ?? defaults.unique_human,
          age_over_18: parsed.age_over_18 ?? defaults.age_over_18,
          minimum_age: parsed.minimum_age ?? defaults.minimum_age,
          nationality: parsed.nationality ?? defaults.nationality,
          gender: parsed.gender ?? defaults.gender,
          wallet_score: parsed.wallet_score ?? defaults.wallet_score,
        },
        nowMs,
      ),
    );
  } catch {
    return normalizeVerificationCapabilityTimestamps(applyLazyCapabilityExpiry(defaults, nowMs));
  }
}

function deriveProfileVerificationState(
  capabilities: VerificationCapabilitiesResponse,
): UserVerificationState {
  switch (capabilities.unique_human.state) {
    case "verified":
      return "verified";
    case "pending":
      return "pending";
    case "expired":
      return "reverification_required";
    default:
      return "unverified";
  }
}

export function serializeUserRow(row: UserRowInput): UserResponse {
  const verificationCapabilities = parseProfileVerificationCapabilities(
    row.verification_capabilities_json,
  );
  return {
    id: publicId(row.user_id, "usr"),
    object: "user",
    primary_wallet_attachment: row.primary_wallet_attachment_id,
    verification_state: deriveProfileVerificationState(verificationCapabilities),
    capability_provider: normalizeCapabilityProvider(row.capability_provider),
    verification_capabilities: verificationCapabilities,
    verified_at: nullableUnixSeconds(row.verified_at),
    created: unixSeconds(row.created_at),
  };
}

export function serializeUser(user: LegacyUserInput): UserResponse {
  return {
    id: publicId(user.user_id, "usr"),
    object: "user",
    ...(user.primary_wallet_attachment_id === undefined
      ? {}
      : { primary_wallet_attachment: user.primary_wallet_attachment_id }),
    verification_state: user.verification_state,
    ...(user.capability_provider === undefined
      ? {}
      : { capability_provider: user.capability_provider }),
    verification_capabilities: user.verification_capabilities,
    ...(user.verified_at === undefined
      ? {}
      : { verified_at: nullableUnixSeconds(user.verified_at) }),
    created: unixSeconds(user.created_at),
  };
}

export function serializeGlobalHandle(row: GlobalHandleRowInput): GlobalHandleResponse {
  return {
    id: `gh_${row.global_handle_id}`,
    object: "global_handle",
    ...(row.platform_handle_id === undefined ? {} : { platform_handle_id: row.platform_handle_id }),
    ...(row.owner_persona_id === undefined ? {} : { owner_persona_id: row.owner_persona_id }),
    ...(row.generation === undefined ? {} : { generation: row.generation }),
    ...(row.state_hash === undefined ? {} : { state_hash: row.state_hash }),
    ...(row.cleanup_rename_available === undefined
      ? {}
      : { cleanup_rename_available: row.cleanup_rename_available }),
    label: row.label_display,
    tier: row.tier,
    status: row.status,
    issuance_source: row.issuance_source,
    redirect_target_global_handle: row.redirect_target_global_handle_id,
    price_paid_cents: row.price_paid_cents,
    free_rename_consumed: Boolean(row.free_rename_consumed),
    issued_at: unixSeconds(row.issued_at),
    replaced_at: nullableUnixSeconds(row.replaced_at),
  };
}

function parseLinkedHandleMetadata(raw: string | null): JsonObject | null {
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function serializeLinkedHandleRow(row: LinkedHandleRowInput): LinkedHandleResponse {
  return {
    linked_handle: row.linked_handle_id,
    label: row.label_display,
    kind: row.kind,
    metadata: parseLinkedHandleMetadata(row.metadata_json),
    verification_state: row.verification_state,
  };
}

function serializePirateLinkedHandle(row: GlobalHandleRowInput): LinkedHandleResponse {
  return {
    linked_handle: `global:${row.global_handle_id}`,
    label: row.label_display,
    kind: "pirate",
    verification_state: "verified",
  };
}

type ProfileIdentitySource = {
  readonly verification_capabilities: {
    readonly nationality: {
      readonly state: Exclude<VerificationState, "pending">;
      readonly provider?: Exclude<VerificationProvider, "very"> | null | undefined;
      readonly value?: string | null | undefined;
    };
  };
};

export function assembleProfile(
  profileRow: ProfileRowInput,
  globalHandleRow: GlobalHandleRowInput,
  linkedHandleRows: readonly LinkedHandleRowInput[] = [],
  primaryWalletAddress: string | null = null,
  user?: ProfileIdentitySource | null,
): ProfileResponse {
  const externalLinkedHandles = linkedHandleRows.map(serializeLinkedHandleRow);
  const primaryPublicHandle = profileRow.primary_linked_handle_id
    ? (externalLinkedHandles.find(
        (handle) => handle.linked_handle === profileRow.primary_linked_handle_id,
      ) ?? null)
    : null;
  const nationality = user?.verification_capabilities.nationality;
  const nationalityBadgeCountry =
    profileRow.display_verified_nationality_badge === 1 &&
    nationality?.state === "verified" &&
    nationality.provider === "self"
      ? normalizeIdentityCountryAlpha2(nationality.value)
      : null;

  return {
    id: publicId(profileRow.user_id, "usr"),
    object: "profile",
    display_name: profileRow.display_name,
    avatar_ref: profileRow.avatar_ref,
    avatar_source: profileRow.avatar_source,
    cover_ref: profileRow.cover_ref,
    cover_source: profileRow.cover_source,
    bio: profileRow.bio,
    bio_source: profileRow.bio_source,
    preferred_locale: profileRow.preferred_locale,
    display_verified_nationality_badge: profileRow.display_verified_nationality_badge === 1,
    nationality_badge_country: nationalityBadgeCountry,
    linked_handles: [serializePirateLinkedHandle(globalHandleRow), ...externalLinkedHandles],
    primary_public_handle: primaryPublicHandle,
    primary_wallet_address: primaryWalletAddress,
    xmtp_inbox: profileRow.xmtp_inbox_id,
    global_handle: serializeGlobalHandle(globalHandleRow),
    created: unixSeconds(profileRow.created_at),
  };
}

export function getPrimaryWalletAddressFromRows(
  primaryWalletAttachmentId: string | null,
  walletRows: readonly WalletAttachmentRowInput[],
): string | null {
  const primaryWalletRow =
    (primaryWalletAttachmentId
      ? walletRows.find((row) => row.wallet_attachment_id === primaryWalletAttachmentId)
      : null) ??
    walletRows.find((row) => row.is_primary === 1) ??
    null;

  return primaryWalletRow?.wallet_address_display ?? null;
}

export function serializeWalletAttachments(
  rows: readonly WalletAttachmentRowInput[],
): WalletAttachmentResponse[] {
  return rows.map((row) => ({
    wallet_attachment: row.wallet_attachment_id,
    chain_namespace: row.chain_namespace,
    wallet_address: row.wallet_address_display,
    is_primary: Boolean(row.is_primary),
  }));
}

type PublicHandleProfile = Pick<ProfileResponse, "global_handle" | "primary_public_handle">;

export function getProfilePublicHandleLabel(profile: PublicHandleProfile): string {
  return profile.primary_public_handle?.label ?? profile.global_handle.label;
}

export function getProfilePublicHandleStem(profile: PublicHandleProfile): string {
  return getProfilePublicHandleLabel(profile)
    .replace(/\.pirate$/iu, "")
    .trim();
}
