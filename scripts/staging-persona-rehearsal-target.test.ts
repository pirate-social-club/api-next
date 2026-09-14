import { expect, test } from "bun:test";
import {
  assertRehearsalBranchIdentity,
  assertRestoredFromApprovedBackup,
  readRehearsalTarget,
  rehearsalTarget,
  STAGING_MAIN_BRANCH_ID,
  REHEARSAL_TARGET_VARIABLES as VARS,
} from "./staging-persona-rehearsal-target.ts";

const bound = {
  [VARS.branchId]: "abkmnvey02z5",
  [VARS.branchName]: "persona-reset-rehearsal-r5-20260906",
  [VARS.backupId]: "xvvo8r6tcaa5",
  [VARS.dataDigest]: "0b1c97ef5efa0d32eee31cf220e9d5a41f74c7cfecbe782c03f16caaf2628bf8",
};
const target = readRehearsalTarget(bound);
const observed = () => ({
  database: { id: "mvydkmmwh5x4", kind: "postgresql" },
  branch: {
    id: target.branchId,
    name: target.branchName,
    ready: true,
    state: "ready",
    restored_from_branch: { id: "syu03e00w3ux" },
  },
  access: { branch: { id: target.branchId }, default: true, access_host_url: "host.example" },
});
const assert = (patch: (value: ReturnType<typeof observed>) => void) => {
  const value = observed();
  patch(value);
  return () => assertRehearsalBranchIdentity(target, "mvydkmmwh5x4", "syu03e00w3ux", value);
};

test("an unbound target refuses instead of defaulting to a previous branch", () => {
  for (const key of Object.values(VARS))
    expect(() => readRehearsalTarget({ ...bound, [key]: undefined })).toThrow(
      `rehearsal_target_unbound:${key}`,
    );
});

test("a malformed identifier or digest refuses before anything is contacted", () => {
  expect(() => readRehearsalTarget({ ...bound, [VARS.branchId]: "Not An Id" })).toThrow(
    "rehearsal_target_invalid",
  );
  expect(() => readRehearsalTarget({ ...bound, [VARS.branchName]: "-leading-dash" })).toThrow(
    "rehearsal_target_invalid",
  );
  expect(() => readRehearsalTarget({ ...bound, [VARS.dataDigest]: "short" })).toThrow(
    "rehearsal_target_invalid",
  );
  expect(() => readRehearsalTarget({ ...bound, [VARS.backupId]: bound[VARS.branchId] })).toThrow(
    "rehearsal_target_identifiers_collide",
  );
});

test("the bound target is what both consumers read, so they cannot drift apart", () => {
  // One read, one frozen value. The defect this replaces was the same branch
  // written into two files independently.
  expect(Object.isFrozen(target)).toBe(true);
  expect(readRehearsalTarget(bound)).toEqual(target);
});

test("a provider branch that is not the bound one is refused, field by field", () => {
  expect(assert(() => undefined)()).toBe("host.example");
  expect(assert((v) => (v.branch.id = "otherbranch1"))).toThrow("rehearsal_target_branch_mismatch");
  expect(assert((v) => (v.branch.name = "persona-reset-rehearsal-20260906"))).toThrow(
    "rehearsal_target_branch_mismatch",
  );
  expect(assert((v) => (v.access.branch = { id: "otherbranch1" }))).toThrow(
    "rehearsal_target_access_mismatch",
  );
  expect(assert((v) => (v.branch.restored_from_branch = { id: "wrongsource1" }))).toThrow(
    "rehearsal_target_source_mismatch",
  );
  expect(assert((v) => (v.database.id = "otherdatabase"))).toThrow(
    "rehearsal_target_database_mismatch",
  );
});

test("a branch that is not ready is refused even when it is the right branch", () => {
  expect(assert((v) => (v.branch.ready = false))).toThrow("rehearsal_target_branch_not_ready");
  expect(assert((v) => (v.branch.state = "pending"))).toThrow("rehearsal_target_branch_not_ready");
});

test("live staging can never be the target, whichever way it is named", () => {
  expect(() => readRehearsalTarget({ ...bound, [VARS.branchId]: STAGING_MAIN_BRANCH_ID })).toThrow(
    "rehearsal_target_is_live_staging",
  );
  expect(() => readRehearsalTarget({ ...bound, [VARS.branchName]: "main" })).toThrow(
    "rehearsal_target_is_live_staging",
  );
});

test("both consumers share one snapshot rather than reading independently", () => {
  for (const [key, value] of Object.entries(bound)) process.env[key] = value;
  // Same object identity, so the runner and the inventory cannot disagree
  // about which branch they are exercising.
  expect(rehearsalTarget()).toBe(rehearsalTarget());
  expect(Object.isFrozen(rehearsalTarget())).toBe(true);
});

test("the bound branch must be one the approved backup actually restored", () => {
  const observation = {
    backup_id: target.backupId,
    source_branch_id: STAGING_MAIN_BRANCH_ID,
    restored_branch_ids: [target.branchId],
  };
  expect(() => assertRestoredFromApprovedBackup(target, observation)).not.toThrow();
  expect(() =>
    assertRestoredFromApprovedBackup(target, { ...observation, backup_id: "otherbackup1" }),
  ).toThrow("rehearsal_target_backup_mismatch");
  expect(() =>
    assertRestoredFromApprovedBackup(target, {
      ...observation,
      source_branch_id: "othersource1",
    }),
  ).toThrow("rehearsal_target_backup_source_mismatch");
  // A branch that agrees about its source but was restored from a different
  // backup is still not the approved target.
  expect(() =>
    assertRestoredFromApprovedBackup(target, { ...observation, restored_branch_ids: ["another1"] }),
  ).toThrow("rehearsal_target_not_restored_from_backup");
});
