/**
 * Pure policy for a cryptographically verified Pirate application session.
 *
 * Signature verification, key lookup, configuration loading, and control-plane
 * I/O belong to the application/platform layers. This module accepts decoded
 * claims and a control-plane snapshot so the security decisions remain
 * deterministic and testable without importing a runtime or a database.
 */

export const PIRATE_SESSION_POLICY = {
  algorithm: "RS256",
  typ: "JWT",
  issuer: "pirate-api",
  audience: "pirate-app",
  defaultScope: "pirate_app_session",
  defaultTtlSeconds: 3_600,
} as const;

export type SessionClassification = "user" | "device";

export type SessionScope = {
  readonly value: string;
  readonly tokens: readonly string[];
};

export type SessionUserRecord = {
  readonly userId: string;
  readonly status?: "active" | "deleted";
};

export type SessionAliasRecord = {
  readonly sourceUserId: string;
  readonly canonicalUserId: string;
  readonly kind: "alias" | "merge";
  readonly status: "active" | "finalizing" | "completed" | "inactive";
};

export type SessionPolicyClaims = Readonly<Record<string, unknown>>;

export type SessionPolicyFailureCode =
  | "authentication_failed"
  | "invalid_claims"
  | "token_expired"
  | "token_not_yet_valid"
  | "insufficient_scope"
  | "classification_mismatch"
  | "control_plane_record_missing"
  | "canonical_alias_invalid";

/** Deliberately contains no token, claim, user id, or database detail. */
export type SessionPolicyFailure = {
  readonly _tag: "SessionPolicyFailure";
  readonly code: SessionPolicyFailureCode;
  readonly message: "Authentication failed" | "Insufficient OAuth scope";
};

export type CanonicalUserAliasResult = {
  readonly sourceUserId: string;
  readonly canonicalUserId: string;
  readonly aliasPath: readonly string[];
};

export type AuthenticatedSessionPrincipal = {
  readonly userId: string;
  readonly classification: SessionClassification;
  readonly scope: SessionScope;
  readonly canonical: CanonicalUserAliasResult;
  readonly issuedAt: number;
  readonly expiresAt: number;
};

export type SessionPolicyResult =
  | { readonly ok: true; readonly principal: AuthenticatedSessionPrincipal }
  | { readonly ok: false; readonly failure: SessionPolicyFailure };

export type CanonicalAliasResult =
  | { readonly ok: true; readonly canonical: CanonicalUserAliasResult }
  | { readonly ok: false; readonly failure: SessionPolicyFailure };

export type SessionPolicyInput = {
  /** Claims are accepted only after the platform verifier proves the signature. */
  readonly claims: SessionPolicyClaims;
  readonly users: readonly SessionUserRecord[];
  readonly aliases: readonly SessionAliasRecord[];
  readonly nowSeconds: number;
  readonly requiredScope?: string;
  readonly requiredClassification?: SessionClassification;
  readonly issuer?: string;
  readonly audience?: string;
  readonly defaultScope?: string;
  /** An optional deployment-specific upper bound; omission keeps TTL positive-only. */
  readonly maxTtlSeconds?: number;
  readonly maxAliasDepth?: number;
};

function failure(code: SessionPolicyFailureCode): SessionPolicyFailure {
  return {
    _tag: "SessionPolicyFailure",
    code,
    message: code === "insufficient_scope" ? "Insufficient OAuth scope" : "Authentication failed",
  };
}

function failed(code: SessionPolicyFailureCode): SessionPolicyResult {
  return { ok: false, failure: failure(code) };
}

function isActiveUser(user: SessionUserRecord | undefined): boolean {
  return user !== undefined && user.status !== "deleted";
}

function findActiveUser(
  users: readonly SessionUserRecord[],
  userId: string,
): SessionUserRecord | undefined {
  const matches = users.filter((user) => user.userId === userId && isActiveUser(user));
  return matches.length === 1 ? matches[0] : undefined;
}

function findAlias(
  aliases: readonly SessionAliasRecord[],
  sourceUserId: string,
): SessionAliasRecord | null | "invalid" {
  const candidates = aliases.filter(
    (alias) =>
      alias.sourceUserId === sourceUserId &&
      ((alias.kind === "alias" && alias.status === "active") ||
        (alias.kind === "merge" &&
          (alias.status === "finalizing" || alias.status === "completed"))),
  );
  if (candidates.length === 0) return null;

  // Active aliases take precedence over merge rows as they do in the old
  // query. More than one candidate at that priority is not deterministic and
  // must fail closed rather than selecting whichever row happens to be first.
  const priority = candidates.some((alias) => alias.kind === "alias") ? "alias" : "merge";
  const selected = candidates.filter((alias) => alias.kind === priority);
  const [only] = selected;
  return selected.length === 1 && only !== undefined ? only : "invalid";
}

/**
 * Resolve a source user through active aliases and completed/finalizing merges.
 * Every target is re-checked as active before it can become canonical.
 */
export function resolveCanonicalUserAlias(input: {
  readonly sourceUserId: string;
  readonly users: readonly SessionUserRecord[];
  readonly aliases: readonly SessionAliasRecord[];
  readonly maxAliasDepth?: number;
}): CanonicalAliasResult {
  const sourceUserId = input.sourceUserId;
  if (!sourceUserId || findActiveUser(input.users, sourceUserId) === undefined) {
    return { ok: false, failure: failure("control_plane_record_missing") };
  }

  const maxAliasDepth = input.maxAliasDepth ?? 8;
  if (!Number.isSafeInteger(maxAliasDepth) || maxAliasDepth <= 0) {
    return { ok: false, failure: failure("canonical_alias_invalid") };
  }

  const visited = new Set<string>();
  const aliasPath: string[] = [];
  let current = sourceUserId;

  for (let depth = 0; depth < maxAliasDepth; depth += 1) {
    if (visited.has(current) || findActiveUser(input.users, current) === undefined) {
      return { ok: false, failure: failure("canonical_alias_invalid") };
    }
    visited.add(current);

    const alias = findAlias(input.aliases, current);
    if (alias === "invalid") {
      return { ok: false, failure: failure("canonical_alias_invalid") };
    }
    if (alias === null) {
      return {
        ok: true,
        canonical: { sourceUserId, canonicalUserId: current, aliasPath },
      };
    }

    if (!alias.canonicalUserId || alias.canonicalUserId === current) {
      return { ok: false, failure: failure("canonical_alias_invalid") };
    }
    aliasPath.push(current);
    current = alias.canonicalUserId;
  }

  return { ok: false, failure: failure("canonical_alias_invalid") };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function scopeForClaim(value: unknown, defaultScope: string): SessionScope | SessionPolicyFailure {
  if (value === undefined) {
    return { value: defaultScope, tokens: [defaultScope] };
  }
  if (typeof value !== "string") return failure("invalid_claims");
  const trimmed = value.trim();
  if (!trimmed) return failure("invalid_claims");
  const tokens = trimmed.split(/\s+/);
  return { value: trimmed, tokens };
}

function isSessionScope(value: SessionScope | SessionPolicyFailure): value is SessionScope {
  return !("_tag" in value);
}

/**
 * Apply the shared session claims and authorization policy after crypto.
 * Protected-header algorithm/type and the signature are intentionally not
 * checked here; the platform verifier must enforce RS256/JWT before calling
 * this function.
 */
export function evaluateSessionPolicy(input: SessionPolicyInput): SessionPolicyResult {
  const issuer = input.issuer ?? PIRATE_SESSION_POLICY.issuer;
  const audience = input.audience ?? PIRATE_SESSION_POLICY.audience;
  const defaultScope = input.defaultScope ?? PIRATE_SESSION_POLICY.defaultScope;

  if (!isSafeInteger(input.nowSeconds) || input.nowSeconds < 0) {
    return failed("invalid_claims");
  }
  if (
    input.maxTtlSeconds !== undefined &&
    (!isSafeInteger(input.maxTtlSeconds) || input.maxTtlSeconds <= 0)
  ) {
    return failed("invalid_claims");
  }

  const claims = input.claims;
  if (claims.iss !== issuer || claims.aud !== audience) {
    return failed("invalid_claims");
  }

  if (!isSafeInteger(claims.iat) || !isSafeInteger(claims.exp)) {
    return failed("invalid_claims");
  }
  if (claims.iat < 0 || claims.exp < 0 || claims.exp <= claims.iat) {
    return failed("invalid_claims");
  }
  const ttlSeconds = claims.exp - claims.iat;
  if (input.maxTtlSeconds !== undefined && ttlSeconds > input.maxTtlSeconds) {
    return failed("invalid_claims");
  }
  if (claims.iat > input.nowSeconds) {
    return failed("token_not_yet_valid");
  }
  if (claims.exp <= input.nowSeconds) {
    return failed("token_expired");
  }
  if (claims.nbf !== undefined) {
    if (!isSafeInteger(claims.nbf) || claims.nbf < 0) return failed("invalid_claims");
    if (claims.nbf > input.nowSeconds) return failed("token_not_yet_valid");
  }

  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.trim() !== claims.sub) {
    return failed("authentication_failed");
  }

  const scope = scopeForClaim(claims.scope, defaultScope);
  if (!isSessionScope(scope)) return { ok: false, failure: scope };
  const classification: SessionClassification = scope.value === defaultScope ? "user" : "device";

  if (
    input.requiredClassification !== undefined &&
    input.requiredClassification !== classification
  ) {
    return failed("classification_mismatch");
  }

  if (
    classification === "device" &&
    input.requiredScope !== undefined &&
    !scope.tokens.includes(input.requiredScope)
  ) {
    return failed("insufficient_scope");
  }

  const canonical = resolveCanonicalUserAlias({
    sourceUserId: claims.sub,
    users: input.users,
    aliases: input.aliases,
    ...(input.maxAliasDepth === undefined ? {} : { maxAliasDepth: input.maxAliasDepth }),
  });
  if (!canonical.ok) return { ok: false, failure: canonical.failure };

  return {
    ok: true,
    principal: {
      userId: canonical.canonical.canonicalUserId,
      classification,
      scope,
      canonical: canonical.canonical,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
    },
  };
}
