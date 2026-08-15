export const SUPPORTED_REWARD_IDENTITY_PROVIDERS = ["self", "zkpassport", "very"] as const;
export type RewardIdentityProvider = (typeof SUPPORTED_REWARD_IDENTITY_PROVIDERS)[number];

export const INTERACTIVE_VERIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

export type VerificationCapabilityState = "unverified" | "pending" | "verified" | "expired";

export type VerificationCapability = {
  state: VerificationCapabilityState;
  provider: RewardIdentityProvider | null;
  proof_type: string | null;
  mechanism: string | null;
  verified_at: number | string | null;
};

export type VerificationValueCapability = VerificationCapability & {
  value: string | number | null;
};

export type WalletScoreCapability = VerificationCapability & {
  score_decimal: string | null;
  score_threshold_decimal: string | null;
  passing_score: boolean | null;
  last_scored_at: number | string | null;
  expires_at: number | string | null;
  stamps: unknown;
};

export type VerificationCapabilities = {
  unique_human: VerificationCapability;
  age_over_18: VerificationCapability;
  minimum_age: VerificationValueCapability;
  nationality: VerificationValueCapability;
  gender: VerificationValueCapability;
  wallet_score: WalletScoreCapability;
};

export function interactiveVerificationExpiresAt(verifiedAt: Date): string {
  return new Date(verifiedAt.getTime() + INTERACTIVE_VERIFICATION_TTL_MS).toISOString();
}

function timestampToMs(timestamp: number | string | null | undefined): number | null {
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
  const expiresMs = timestampToMs(timestamp);
  return expiresMs !== null && expiresMs <= nowMs;
}

function isOlderThanTtl(
  verifiedAt: number | string | null | undefined,
  ttlMs: number,
  nowMs: number,
): boolean {
  const verifiedMs = timestampToMs(verifiedAt);
  if (verifiedMs === null) return false;
  return Number.isFinite(verifiedMs) && verifiedMs + ttlMs <= nowMs;
}

export function buildDefaultVerificationCapabilities(): VerificationCapabilities {
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

export function applyLazyCapabilityExpiry(
  capabilities: VerificationCapabilities,
  nowMs = Date.now(),
): VerificationCapabilities {
  const next: VerificationCapabilities = {
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
    isOlderThanTtl(next.unique_human.verified_at, INTERACTIVE_VERIFICATION_TTL_MS, nowMs)
  ) {
    next.unique_human.state = "expired";
  }

  for (const capability of [next.age_over_18, next.minimum_age, next.nationality, next.gender]) {
    if (
      capability.state === "verified" &&
      (capability.provider === "self" || capability.provider === "zkpassport") &&
      isOlderThanTtl(capability.verified_at, INTERACTIVE_VERIFICATION_TTL_MS, nowMs)
    ) {
      capability.state = "expired";
    }
  }

  if (next.wallet_score.state === "verified" && isExpiredAt(next.wallet_score.expires_at, nowMs)) {
    next.wallet_score.state = "expired";
  }

  return next;
}

export function parseVerificationCapabilities(
  raw: string | null | undefined,
  nowMs = Date.now(),
): VerificationCapabilities {
  const defaults = buildDefaultVerificationCapabilities();
  if (!raw) return applyLazyCapabilityExpiry(defaults, nowMs);

  try {
    const parsed = JSON.parse(raw) as Partial<VerificationCapabilities>;
    return applyLazyCapabilityExpiry(
      {
        unique_human: parsed.unique_human ?? defaults.unique_human,
        age_over_18: parsed.age_over_18 ?? defaults.age_over_18,
        minimum_age: parsed.minimum_age ?? defaults.minimum_age,
        nationality: parsed.nationality ?? defaults.nationality,
        gender: parsed.gender ?? defaults.gender,
        wallet_score: parsed.wallet_score ?? defaults.wallet_score,
      },
      nowMs,
    );
  } catch {
    return applyLazyCapabilityExpiry(defaults, nowMs);
  }
}

export function deriveVerificationState(
  capabilities: VerificationCapabilities,
): "unverified" | "pending" | "verified" | "reverification_required" {
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

export type RewardIdentityCandidate = {
  identityNullifierId: string;
  provider: string;
  mechanism: string;
  nullifierHash: string;
  sourceAttestationId: string | null;
  firstSeenAt: string;
};

export type RewardIdentityMaterial = {
  identityNullifierId: string;
  provider: RewardIdentityProvider;
  mechanism: string;
  nullifierHash: string;
};

export type ActiveUniqueHumanEvidence = {
  provider: string;
  sourceIdentityNullifierId: string | null;
};

export function resolveRewardIdentityProvider(
  raw: string | undefined,
): RewardIdentityProvider | null {
  const provider = String(raw ?? "")
    .trim()
    .toLowerCase();
  return SUPPORTED_REWARD_IDENTITY_PROVIDERS.find((candidate) => candidate === provider) ?? null;
}

function orderedCandidates(
  candidates: readonly RewardIdentityCandidate[],
): RewardIdentityCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const leftProvider = resolveRewardIdentityProvider(left.candidate.provider);
      const rightProvider = resolveRewardIdentityProvider(right.candidate.provider);
      const leftRank = leftProvider === "self" ? 0 : leftProvider === "zkpassport" ? 1 : 2;
      const rightRank = rightProvider === "self" ? 0 : rightProvider === "zkpassport" ? 1 : 2;
      return (
        leftRank - rightRank ||
        left.candidate.firstSeenAt.localeCompare(right.candidate.firstSeenAt) ||
        left.candidate.identityNullifierId.localeCompare(right.candidate.identityNullifierId) ||
        left.index - right.index
      );
    })
    .map(({ candidate }) => candidate);
}

function toMaterial(candidate: RewardIdentityCandidate): RewardIdentityMaterial | null {
  const provider = resolveRewardIdentityProvider(candidate.provider);
  if (
    !provider ||
    !candidate.identityNullifierId ||
    !candidate.mechanism ||
    !candidate.nullifierHash
  ) {
    return null;
  }
  return {
    identityNullifierId: candidate.identityNullifierId,
    provider,
    mechanism: candidate.mechanism,
    nullifierHash: candidate.nullifierHash,
  };
}

export function selectActiveSupportedRewardIdentity(input: {
  candidates: readonly RewardIdentityCandidate[];
  durableEvidenceIds: ReadonlySet<string>;
  projection: VerificationCapabilities;
}): RewardIdentityMaterial | null {
  for (const candidate of orderedCandidates(input.candidates)) {
    const material = toMaterial(candidate);
    if (!material) continue;
    const active = candidate.sourceAttestationId
      ? input.durableEvidenceIds.has(candidate.identityNullifierId)
      : input.projection.unique_human.state === "verified" &&
        input.projection.unique_human.provider === material.provider;
    if (active) return material;
  }
  return null;
}

export function hasActiveUniqueHumanNullifier(
  evidence: readonly ActiveUniqueHumanEvidence[],
  requiredProvider: RewardIdentityProvider | null,
): boolean {
  if (!requiredProvider) return false;
  return evidence.some((item) => item.provider === requiredProvider);
}

export function selectActiveRewardIdentity(input: {
  candidates: readonly RewardIdentityCandidate[];
  requiredProvider: RewardIdentityProvider | null;
  evidence: readonly ActiveUniqueHumanEvidence[];
}): RewardIdentityMaterial | null {
  if (!input.requiredProvider) return null;
  const durableEvidenceIds = new Set(
    input.evidence
      .filter((item) => item.provider === input.requiredProvider)
      .map((item) => item.sourceIdentityNullifierId)
      .filter((value): value is string => value !== null),
  );
  if (durableEvidenceIds.size === 0) return null;

  for (const candidate of orderedCandidates(input.candidates)) {
    const material = toMaterial(candidate);
    if (
      material?.provider === input.requiredProvider &&
      durableEvidenceIds.has(material.identityNullifierId)
    ) {
      return material;
    }
  }
  return null;
}

type SubtleCryptoLike = {
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
};

export async function deriveRewardIdentityId(
  provider: RewardIdentityProvider,
  mechanism: string,
  nullifierHash: string,
): Promise<string> {
  const material = `${provider}:${mechanism}:${nullifierHash}`;
  const cryptoLike = (globalThis as typeof globalThis & { crypto: { subtle: SubtleCryptoLike } })
    .crypto;
  const digest = await cryptoLike.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `rwi_${hex}`;
}
