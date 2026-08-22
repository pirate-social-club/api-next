import { describe, expect, test } from "bun:test";

import {
  parseVeryStagingFixtureOptions,
  VeryStagingFixtureError,
} from "./very-staging-community-fixture-options.ts";

const environment = {
  API_NEXT_ENV: "staging",
  CONTROL_PLANE_POSTGRES_ADMIN_URL: "postgres://fixture.invalid/control-plane",
} as const;

const base = [
  "seed",
  "--community-id",
  "community-very-staging-fixture-acceptance-v1",
  "--operator-user-id",
  "operator-fixture-owner",
] as const;

describe("Very staging community fixture options", () => {
  test("defaults to a read-only dry run", () => {
    expect(parseVeryStagingFixtureOptions(base, environment)).toEqual({
      action: "seed",
      mode: "dry-run",
      communityId: "community-very-staging-fixture-acceptance-v1",
      operatorUserId: "operator-fixture-owner",
      connectionString: environment.CONTROL_PLANE_POSTGRES_ADMIN_URL,
    });
  });

  test("requires an explicit staging confirmation before apply", () => {
    expect(() => parseVeryStagingFixtureOptions([...base, "--apply"], environment)).toThrow(
      "Applying requires --confirm-staging.",
    );
    expect(
      parseVeryStagingFixtureOptions([...base, "--apply", "--confirm-staging"], environment),
    ).toMatchObject({ mode: "apply" });
  });

  test("accepts deactivation through the same guarded command", () => {
    expect(
      parseVeryStagingFixtureOptions(["deactivate", ...base.slice(1)], environment),
    ).toMatchObject({
      action: "deactivate",
      mode: "dry-run",
    });
  });

  test("refuses non-staging and missing database configuration", () => {
    expect(() =>
      parseVeryStagingFixtureOptions(base, {
        ...environment,
        API_NEXT_ENV: "production",
      }),
    ).toThrow("Refusing to run unless API_NEXT_ENV=staging.");
    expect(() =>
      parseVeryStagingFixtureOptions(base, {
        API_NEXT_ENV: "staging",
      }),
    ).toThrow("CONTROL_PLANE_POSTGRES_ADMIN_URL is required.");
  });

  test("requires an obviously synthetic community id and persisted operator id", () => {
    expect(() =>
      parseVeryStagingFixtureOptions(
        [
          "seed",
          "--community-id",
          "community-real",
          "--operator-user-id",
          "operator-fixture-owner",
        ],
        environment,
      ),
    ).toThrow("--community-id must start with community-very-staging-fixture-");
    expect(() =>
      parseVeryStagingFixtureOptions(
        [
          "seed",
          "--community-id",
          "community-very-staging-fixture-acceptance-v1",
          "--operator-user-id",
          " operator-fixture-owner ",
        ],
        environment,
      ),
    ).toThrow(VeryStagingFixtureError);
  });

  test("rejects contradictory and unknown options", () => {
    expect(() =>
      parseVeryStagingFixtureOptions(
        [...base, "--apply", "--dry-run", "--confirm-staging"],
        environment,
      ),
    ).toThrow("Choose either --dry-run or --apply.");
    expect(() => parseVeryStagingFixtureOptions([...base, "--force"], environment)).toThrow(
      "Unknown option: --force",
    );
  });
});
