import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { OpenApiDocument } from "@pirate/contracts";
import {
  assertNoObsoleteBreakingChangeWaivers,
  type BreakingChangePolicy,
  filterAllowedBreakingChanges,
} from "./check-openapi-breaking.ts";

const OTHER_BASELINE_SHA = "b".repeat(40);
test("retires landed compatibility waivers from the active repository policy", async () => {
  const active = JSON.parse(
    await Bun.file(
      new URL("../packages/contracts/breaking-change-waivers.json", import.meta.url),
    ).text(),
  );
  expect(
    active.breakingChangeWaivers.every(
      (entry: { baselineSha: string }) =>
        entry.baselineSha !== "926e2b876c56111f0975c4a62b6db7c4595a4463",
    ),
  ).toBe(true);
});

test("single-funder declaration admits exactly seven enums and no later baseline or extra break", () => {
  const policy: BreakingChangePolicy = JSON.parse(
    readFileSync(
      new URL("./fixtures/openapi-single-funder-waivers-20261028.json", import.meta.url),
      "utf8",
    ),
  );
  const current: OpenApiDocument = JSON.parse(
    readFileSync(
      new URL("../apps/http-worker/src/generated/openapi.json", import.meta.url),
      "utf8",
    ),
  );
  const baseline = structuredClone(current);
  let removed = 0;
  const prior = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const child of value) prior(child);
      return;
    }
    const row = value as Record<string, unknown>;
    if (Array.isArray(row.enum) && row.enum.includes("single_funder_ticket_first_v1")) {
      row.enum = row.enum.filter((value) => value !== "single_funder_ticket_first_v1");
      removed++;
    }
    for (const child of Object.values(row)) prior(child);
  };
  prior(baseline);
  expect(removed).toBe(7);
  expect(policy.breakingChangeWaivers).toHaveLength(6);
  expect(policy.breakingChangeWaivers.flatMap((entry) => entry.expectedViolations)).toHaveLength(7);
  const sha = "926e2b876c56111f0975c4a62b6db7c4595a4463";
  expect(filterAllowedBreakingChanges(baseline, current, policy, sha)).toEqual([]);
  expect(filterAllowedBreakingChanges(baseline, current, policy, OTHER_BASELINE_SHA)).toHaveLength(
    7,
  );
  const extra = structuredClone(current);
  delete extra.paths["/communities/{communityId}/posts/{postId}/megapot-participation"];
  expect(() => filterAllowedBreakingChanges(baseline, extra, policy, sha)).toThrow();
  expect(() =>
    assertNoObsoleteBreakingChangeWaivers(policy, OTHER_BASELINE_SHA, () => true),
  ).toThrow("obsolete baseline");
});

test("treasury transition admits only seven enums and seven closed recipient fields at its exact baseline", () => {
  const policy: BreakingChangePolicy = JSON.parse(
    readFileSync(
      new URL("../packages/contracts/breaking-change-waivers.json", import.meta.url),
      "utf8",
    ),
  );
  const current: OpenApiDocument = JSON.parse(
    readFileSync(
      new URL("../apps/http-worker/src/generated/openapi.json", import.meta.url),
      "utf8",
    ),
  );
  const baseline = structuredClone(current);
  let enums = 0,
    recipients = 0;
  const prior = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) prior(item);
      return;
    }
    const row = value as Record<string, unknown>;
    if (Array.isArray(row.enum) && row.enum.includes("safe_treasury_ticket_first_v1")) {
      row.enum = row.enum.filter((v) => v !== "safe_treasury_ticket_first_v1");
      enums++;
    }
    if ("empty_winnings_recipient" in row) {
      delete row.empty_winnings_recipient;
      recipients++;
    }
    for (const item of Object.values(row)) prior(item);
  };
  prior(baseline);
  expect([enums, recipients]).toEqual([7, 7]);
  const sha = "1b8a9bb9b5683a995dba2bd5c18609af45755a61";
  expect(filterAllowedBreakingChanges(baseline, current, policy, sha)).toEqual([]);
  expect(filterAllowedBreakingChanges(baseline, current, policy, OTHER_BASELINE_SHA)).toHaveLength(
    14,
  );
  const extra = structuredClone(current);
  delete extra.paths["/communities/{communityId}/posts/{postId}/megapot-participation"];
  expect(() => filterAllowedBreakingChanges(baseline, extra, policy, sha)).toThrow();
  expect(() =>
    assertNoObsoleteBreakingChangeWaivers(policy, OTHER_BASELINE_SHA, () => true),
  ).toThrow("obsolete baseline");
});
