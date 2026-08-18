import { describe, expect, test } from "bun:test";
import {
  evaluateSessionPolicy,
  resolveCanonicalUserAlias,
  type SessionAliasRecord,
  type SessionPolicyClaims,
  type SessionPolicyFailureCode,
  type SessionUserRecord,
} from "./session-policy";

const nowSeconds = 1_800_000_000;
const TEST_ISSUER = "api-next-session-test";
const TEST_AUDIENCE = "api-next-browser-test";
const TEST_SCOPE = "api-next-browser-session-test";
const claims = (overrides: SessionPolicyClaims = {}): SessionPolicyClaims => ({
  iss: TEST_ISSUER,
  aud: TEST_AUDIENCE,
  sub: "usr_source",
  scope: TEST_SCOPE,
  iat: nowSeconds - 60,
  exp: nowSeconds + 3_540,
  ...overrides,
});

const activeUsers = (...userIds: string[]): readonly SessionUserRecord[] =>
  userIds.map((userId) => ({ userId, status: "active" }));

const alias = (
  sourceUserId: string,
  canonicalUserId: string,
  overrides: Partial<SessionAliasRecord> = {},
): SessionAliasRecord => ({
  sourceUserId,
  canonicalUserId,
  kind: "alias",
  status: "active",
  ...overrides,
});

function evaluate(
  claimOverrides: SessionPolicyClaims = {},
  options: Partial<Parameters<typeof evaluateSessionPolicy>[0]> = {},
) {
  return evaluateSessionPolicy({
    claims: claims(claimOverrides),
    users: activeUsers("usr_source"),
    aliases: [],
    nowSeconds,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    defaultScope: TEST_SCOPE,
    ...options,
  });
}

describe("evaluateSessionPolicy", () => {
  test("accepts the exact shared user-session contract", () => {
    const result = evaluate();
    expect(result).toEqual({
      ok: true,
      principal: {
        userId: "usr_source",
        classification: "user",
        scope: { value: TEST_SCOPE, tokens: [TEST_SCOPE] },
        canonical: { sourceUserId: "usr_source", canonicalUserId: "usr_source", aliasPath: [] },
        issuedAt: nowSeconds - 60,
        expiresAt: nowSeconds + 3_540,
      },
    });
  });

  test("accepts a positive integer TTL and rejects zero, negative, fractional, and oversized TTLs", () => {
    const vectors: ReadonlyArray<
      readonly [string, SessionPolicyClaims, SessionPolicyFailureCode | undefined]
    > = [
      ["positive", { iat: nowSeconds - 1, exp: nowSeconds + 1 }, undefined],
      ["zero", { iat: nowSeconds, exp: nowSeconds }, "invalid_claims"],
      ["negative", { iat: nowSeconds + 1, exp: nowSeconds }, "invalid_claims"],
      ["fractional iat", { iat: nowSeconds - 0.5 }, "invalid_claims"],
      ["fractional exp", { exp: nowSeconds + 0.5 }, "invalid_claims"],
      ["oversized", { iat: nowSeconds - 10, exp: nowSeconds + 10 }, "invalid_claims"],
    ];
    for (const [name, overrides, expected] of vectors) {
      const result = evaluate(
        overrides,
        expected === "invalid_claims" && name === "oversized" ? { maxTtlSeconds: 15 } : {},
      );
      expect(result.ok ? undefined : result.failure.code, name).toBe(expected);
    }
  });

  test("requires issuer and audience to be exact scalar values", () => {
    const vectors: ReadonlyArray<readonly [string, SessionPolicyClaims]> = [
      ["wrong issuer", { iss: "other-api" }],
      ["wrong audience", { aud: "other-app" }],
      ["audience array", { aud: [TEST_AUDIENCE] }],
      ["issuer array", { iss: [TEST_ISSUER] }],
    ];
    for (const [name, overrides] of vectors) {
      const result = evaluate(overrides);
      expect(result.ok ? undefined : result.failure.code, name).toBe("invalid_claims");
    }
  });

  test("requires a non-padded, non-empty subject", () => {
    const vectors: ReadonlyArray<readonly [string, SessionPolicyClaims]> = [
      ["missing", { sub: undefined }],
      ["empty", { sub: "" }],
      ["whitespace", { sub: "   " }],
      ["padded", { sub: " usr_source " }],
      ["non-string", { sub: 42 }],
    ];
    for (const [name, overrides] of vectors) {
      const result = evaluate(overrides);
      expect(result.ok ? undefined : result.failure.code, name).toBe("authentication_failed");
    }
  });

  test("requires iat and exp and enforces temporal claims", () => {
    const vectors: ReadonlyArray<readonly [string, SessionPolicyClaims, SessionPolicyFailureCode]> =
      [
        ["missing iat", { iat: undefined }, "invalid_claims"],
        ["missing exp", { exp: undefined }, "invalid_claims"],
        ["expired", { exp: nowSeconds }, "token_expired"],
        ["past", { exp: nowSeconds - 1 }, "token_expired"],
        ["future iat", { iat: nowSeconds + 1 }, "token_not_yet_valid"],
        ["future nbf", { nbf: nowSeconds + 1 }, "token_not_yet_valid"],
        ["malformed nbf", { nbf: "later" }, "invalid_claims"],
      ];
    for (const [name, overrides, expected] of vectors) {
      const result = evaluate(overrides);
      expect(result.ok ? undefined : result.failure.code, name).toBe(expected);
    }
  });

  test("defaults only an omitted scope and rejects malformed or empty scope", () => {
    const omitted = evaluate({ scope: undefined });
    expect(omitted.ok ? undefined : omitted.failure.code).toBe("invalid_claims");

    const vectors: ReadonlyArray<readonly [string, SessionPolicyClaims]> = [
      ["non-string", { scope: 42 }],
      ["null", { scope: null }],
      ["empty", { scope: "   " }],
    ];
    for (const [name, overrides] of vectors) {
      const result = evaluate(overrides);
      expect(result.ok ? undefined : result.failure.code, name).toBe("invalid_claims");
    }
  });

  test("classifies only the exact default scope as a user session", () => {
    const user = evaluate({}, { requiredClassification: "user" });
    expect(user.ok && user.principal.classification).toBe("user");

    const device = evaluate(
      { scope: "profile:read live_room:attach" },
      { requiredClassification: "device", requiredScope: "profile:read" },
    );
    expect(device.ok && device.principal).toMatchObject({
      classification: "device",
      scope: {
        value: "profile:read live_room:attach",
        tokens: ["profile:read", "live_room:attach"],
      },
    });

    const mismatched = evaluate({}, { requiredClassification: "device" });
    expect(mismatched.ok ? undefined : mismatched.failure.code).toBe("classification_mismatch");
  });

  test("applies required scopes to device sessions while preserving user-session compatibility", () => {
    const user = evaluate({}, { requiredScope: "device-only-scope" });
    expect(user.ok).toBe(true);

    const missing = evaluate({ scope: "profile:read" }, { requiredScope: "posts:write" });
    expect(missing.ok ? undefined : missing.failure.code).toBe("insufficient_scope");

    const present = evaluate(
      { scope: "profile:read posts:write" },
      { requiredScope: "posts:write" },
    );
    expect(present.ok).toBe(true);
  });
});

describe("resolveCanonicalUserAlias", () => {
  test("accepts a source user with no alias", () => {
    expect(
      resolveCanonicalUserAlias({
        sourceUserId: "usr_source",
        users: activeUsers("usr_source"),
        aliases: [],
      }),
    ).toEqual({
      ok: true,
      canonical: { sourceUserId: "usr_source", canonicalUserId: "usr_source", aliasPath: [] },
    });
  });

  test("follows active aliases and finalizing/completed merges", () => {
    const users = activeUsers("usr_source", "usr_mid", "usr_canonical");
    const aliases = [
      alias("usr_source", "usr_mid"),
      alias("usr_mid", "usr_canonical", { kind: "merge", status: "completed" }),
    ];
    expect(resolveCanonicalUserAlias({ sourceUserId: "usr_source", users, aliases })).toEqual({
      ok: true,
      canonical: {
        sourceUserId: "usr_source",
        canonicalUserId: "usr_canonical",
        aliasPath: ["usr_source", "usr_mid"],
      },
    });
  });

  test("fails closed for missing, deleted, self, cyclic, too-deep, and ambiguous aliases", () => {
    const vectors: ReadonlyArray<
      readonly [string, Parameters<typeof resolveCanonicalUserAlias>[0]]
    > = [
      [
        "missing source",
        { sourceUserId: "usr_missing", users: activeUsers("usr_source"), aliases: [] },
      ],
      [
        "deleted source",
        {
          sourceUserId: "usr_source",
          users: [{ userId: "usr_source", status: "deleted" }],
          aliases: [],
        },
      ],
      [
        "missing target",
        {
          sourceUserId: "usr_source",
          users: activeUsers("usr_source"),
          aliases: [alias("usr_source", "usr_missing")],
        },
      ],
      [
        "deleted target",
        {
          sourceUserId: "usr_source",
          users: [
            { userId: "usr_source", status: "active" },
            { userId: "usr_deleted", status: "deleted" },
          ],
          aliases: [alias("usr_source", "usr_deleted")],
        },
      ],
      [
        "self alias",
        {
          sourceUserId: "usr_source",
          users: activeUsers("usr_source"),
          aliases: [alias("usr_source", "usr_source")],
        },
      ],
      [
        "cycle",
        {
          sourceUserId: "usr_source",
          users: activeUsers("usr_source", "usr_mid"),
          aliases: [alias("usr_source", "usr_mid"), alias("usr_mid", "usr_source")],
        },
      ],
      [
        "too deep",
        {
          sourceUserId: "usr_source",
          users: activeUsers("usr_source", "usr_1", "usr_2"),
          aliases: [alias("usr_source", "usr_1"), alias("usr_1", "usr_2")],
          maxAliasDepth: 1,
        },
      ],
      [
        "ambiguous",
        {
          sourceUserId: "usr_source",
          users: activeUsers("usr_source", "usr_a", "usr_b"),
          aliases: [alias("usr_source", "usr_a"), alias("usr_source", "usr_b")],
        },
      ],
    ];
    for (const [name, input] of vectors) {
      const result = resolveCanonicalUserAlias(input);
      expect(result.ok, name).toBe(false);
      if (!result.ok) {
        expect(result.failure.code, name).toMatch(
          /control_plane_record_missing|canonical_alias_invalid/,
        );
        expect(result.failure).not.toHaveProperty("userId");
        expect(result.failure).not.toHaveProperty("token");
      }
    }
  });

  test("ignores inactive aliases and rejects duplicate user records", () => {
    const inactive = resolveCanonicalUserAlias({
      sourceUserId: "usr_source",
      users: activeUsers("usr_source"),
      aliases: [alias("usr_source", "usr_missing", { status: "inactive" })],
    });
    expect(inactive.ok && inactive.canonical.canonicalUserId).toBe("usr_source");

    const duplicate = resolveCanonicalUserAlias({
      sourceUserId: "usr_source",
      users: activeUsers("usr_source", "usr_source"),
      aliases: [],
    });
    expect(duplicate.ok ? undefined : duplicate.failure.code).toBe("control_plane_record_missing");
  });
});
