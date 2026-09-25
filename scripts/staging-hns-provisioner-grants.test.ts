import { describe, expect, test } from "bun:test";
import {
  HNS_PROVISIONER_MISSING_FUNCTIONS,
  parseProvisionerGrantCommand,
  provisionerGrantPlan,
  requirePrivilegeState,
} from "./staging-hns-provisioner-grants.ts";

const role = "pscale_api_fixture_runtime";
const privilegeRows = (execute: boolean) =>
  HNS_PROVISIONER_MISSING_FUNCTIONS.map((signature) => ({
    signature,
    exists: true,
    runtime_execute: execute,
    public_execute: false,
  }));
const refusal = (run: () => unknown): string => {
  try {
    run();
    return "admitted";
  } catch (error) {
    return (error as { readonly code?: string }).code ?? "unknown";
  }
};

describe("staging HNS provisioner grant plan", () => {
  test("binds a fixed function-only plan to one validated role", () => {
    const plan = provisionerGrantPlan(role);
    expect(plan.statements).toHaveLength(7);
    expect(plan.statements).toEqual(
      HNS_PROVISIONER_MISSING_FUNCTIONS.map(
        (signature) => `GRANT EXECUTE ON FUNCTION api_next.${signature} TO "${role}"`,
      ),
    );
    expect(plan.plan_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(provisionerGrantPlan(role).plan_sha256).toBe(plan.plan_sha256);
    expect(provisionerGrantPlan("pscale_api_other").plan_sha256).not.toBe(plan.plan_sha256);
    expect(refusal(() => provisionerGrantPlan("bad-role"))).toBe("runtime_role_invalid");
  });

  test("requires a typed plan digest to execute", () => {
    const digest = "a".repeat(64);
    expect(parseProvisionerGrantCommand([])).toEqual({
      execute: false,
      approved_plan_sha256: null,
    });
    expect(parseProvisionerGrantCommand(["--execute", "--approve-plan-sha256", digest])).toEqual({
      execute: true,
      approved_plan_sha256: digest,
    });
    expect(refusal(() => parseProvisionerGrantCommand(["--execute"]))).toBe("options_invalid");
    expect(
      refusal(() => parseProvisionerGrantCommand(["--execute", "--approve-plan-sha256", "bad"])),
    ).toBe("options_invalid");
    expect(refusal(() => parseProvisionerGrantCommand(["--force"]))).toBe("options_invalid");
  });

  test("refuses missing, public, already-granted and mismatched functions", () => {
    const before = privilegeRows(false);
    const after = privilegeRows(true);
    const first = before[0];
    if (first === undefined) throw new Error("fixed function list is empty");
    expect(refusal(() => requirePrivilegeState(before, false))).toBe("admitted");
    expect(refusal(() => requirePrivilegeState(after, true))).toBe("admitted");
    expect(refusal(() => requirePrivilegeState(after, false))).toBe("grant_state_drift");
    expect(refusal(() => requirePrivilegeState(before, true))).toBe("grant_readback_mismatch");
    expect(refusal(() => requirePrivilegeState(before.slice(1), false))).toBe("function_count");
    expect(
      refusal(() =>
        requirePrivilegeState([{ ...first, exists: false }, ...before.slice(1)], false),
      ),
    ).toBe("function_identity");
    expect(
      refusal(() =>
        requirePrivilegeState([{ ...first, public_execute: true }, ...before.slice(1)], false),
      ),
    ).toBe("public_execute");
    expect(
      refusal(() =>
        requirePrivilegeState([{ ...first, signature: "other()" }, ...before.slice(1)], false),
      ),
    ).toBe("function_identity");
  });
});
