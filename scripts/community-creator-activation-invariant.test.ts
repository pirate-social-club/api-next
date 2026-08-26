import { describe, expect, test } from "bun:test";

import {
  auditCommunityCreatorActivation,
  auditConfiguredCommunityCreatorActivation,
  hasNoActionCommunityCreatorForeignKey,
} from "./community-creator-activation-invariant";

const NO_ACTION_SCHEMA = `
  ALTER TABLE ONLY communities
    ADD CONSTRAINT communities_created_by_user_id_fkey
    FOREIGN KEY (created_by_user_id) REFERENCES users(user_id);
`;

const CASCADE_SCHEMA = `
  ALTER TABLE ONLY communities
    ADD CONSTRAINT communities_created_by_user_id_fkey
    FOREIGN KEY (created_by_user_id) REFERENCES users(user_id) ON DELETE CASCADE;
`;

const input = (
  overrides: Partial<Parameters<typeof auditCommunityCreatorActivation>[0]> = {},
): Parameters<typeof auditCommunityCreatorActivation>[0] => ({
  apiEnvironment: "production",
  selfPassEnabled: "false",
  veryOauthEnabled: "false",
  schemaSql: "CREATE TABLE communities (created_by_user_id text NOT NULL);",
  ...overrides,
});

describe("community creator activation invariant", () => {
  test("accepts the checked-in production configuration while both providers are disabled", async () => {
    expect(await auditConfiguredCommunityCreatorActivation()).toEqual([]);
  });

  test.each(["SELF_PASS_ENABLED", "VERY_OAUTH_ENABLED"] as const)(
    "rejects %s activation before the creator foreign key exists",
    (provider) => {
      const overrides =
        provider === "SELF_PASS_ENABLED"
          ? { selfPassEnabled: "true" }
          : { veryOauthEnabled: "true" };

      expect(auditCommunityCreatorActivation(input(overrides))).toEqual([
        `http/production: ${provider} requires communities.created_by_user_id to reference users.user_id with NO ACTION delete semantics`,
      ]);
    },
  );

  test("accepts provider activation after the NO ACTION creator foreign key lands", () => {
    expect(
      auditCommunityCreatorActivation(
        input({ selfPassEnabled: "true", veryOauthEnabled: true, schemaSql: NO_ACTION_SCHEMA }),
      ),
    ).toEqual([]);
  });

  test("does not accept cascade deletion as creator integrity", () => {
    expect(hasNoActionCommunityCreatorForeignKey(CASCADE_SCHEMA)).toBeFalse();
    expect(
      auditCommunityCreatorActivation(
        input({ selfPassEnabled: "true", schemaSql: CASCADE_SCHEMA }),
      ),
    ).toHaveLength(1);
  });

  test("fails when the named production block is not explicitly production", () => {
    expect(auditCommunityCreatorActivation(input({ apiEnvironment: "staging" }))).toEqual([
      "http/production: API_NEXT_ENV must be production, got staging",
    ]);
  });
});
