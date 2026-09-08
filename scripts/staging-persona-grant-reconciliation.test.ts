import { describe, expect, test } from "bun:test";
import { type ResetGrant, reconcileResetGrants } from "./staging-persona-grant-reconciliation";

const read: ResetGrant = {
  schema: "api_next",
  objectKind: "table",
  objectIdentity: "memberships",
  grantee: "runtime_fixture",
  privilege: "SELECT",
  grantOption: false,
};
const write = { ...read, privilege: "INSERT" };

describe("reset grant reconciliation", () => {
  test("only an explicit policy admits a missing new grant and rejects allow/deny conflicts", () => {
    const policy = { explicitNew: [read], forbidden: [write] };
    const result = reconcileResetGrants({ before: [], replay: [write], reviewed: [read], policy });
    expect(result.newGrants).toEqual([read]);
    expect(result.revoke).toEqual([write]);
    expect(result.unfulfilledReviewed).toEqual([]);
    expect(() => reconcileResetGrants({ before: [], replay: [], reviewed: [], policy })).toThrow(
      "new_grant_not_reviewed",
    );
    expect(() =>
      reconcileResetGrants({ before: [], replay: [], reviewed: [read, write], policy }),
    ).toThrow("grant_policy_conflict");
    expect(() =>
      reconcileResetGrants({
        before: [],
        replay: [],
        reviewed: [],
        policy: { explicitNew: [], forbidden: [{ ...write, grantOption: true }] },
      }),
    ).toThrow("denial_grant_option_invalid");
  });
  test("reapplies only old-minus-replay intersected with the reviewed manifest", () => {
    const unreviewed = { ...read, privilege: "DELETE" };
    const result = reconcileResetGrants({
      before: [read, write, unreviewed],
      replay: [read],
      reviewed: [read, write],
    });
    expect(result.replayCreated).toEqual([read]);
    expect(result.previousOnly).toHaveLength(2);
    expect(result.reapply).toEqual([write]);
    expect(result.unfulfilledReviewed).toEqual([]);
    expect(result.execution_authorized).toBe(false);
  });

  test("does not invent a reviewed privilege absent from both observed sets", () => {
    const result = reconcileResetGrants({ before: [read], replay: [read], reviewed: [write] });
    expect(result.reapply).toEqual([]);
    expect(result.unfulfilledReviewed).toEqual([write]);
  });

  test("never substitutes grant-option authority or another grantee", () => {
    const result = reconcileResetGrants({
      before: [
        { ...read, grantOption: true },
        { ...read, grantee: "PUBLIC" },
      ],
      replay: [],
      reviewed: [read],
    });
    expect(result.reapply).toEqual([]);
    expect(result.unfulfilledReviewed).toEqual([read]);
  });

  test("deduplicates and snapshots facts without depending on input order", () => {
    const result = reconcileResetGrants({
      before: [write, read, read],
      replay: [],
      reviewed: [read, write],
    });
    expect(result).toEqual(
      reconcileResetGrants({ before: [read, write], replay: [], reviewed: [write, read] }),
    );
    expect(result.reapply).toHaveLength(2);
    expect(Object.isFrozen(result.reapply[0])).toBe(true);
  });

  test("refuses malformed privilege facts", () => {
    expect(() =>
      reconcileResetGrants({
        before: [{ ...read, privilege: "EXECUTE" }],
        replay: [],
        reviewed: [],
      }),
    ).toThrow("reset_grant_fact_invalid");
  });
});
