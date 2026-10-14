import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  Auth,
  endpoint,
  endpoints,
  isRestrictedPracticeLearnerOperation,
  restrictedPracticeLearnerOperations,
} from "./index.ts";

describe("Restricted practice learner policy vocabulary", () => {
  test("the closed operation allowlist starts empty", () => {
    expect(restrictedPracticeLearnerOperations).toEqual([]);
    expect(endpoints.filter((e) => e.auth.policy.kind === "restrictedPracticeLearner")).toEqual([]);
  });

  test("undeclared operations are refused", () => {
    for (const operation of ["read_history", "", "user", undefined, 1]) {
      expect(isRestrictedPracticeLearnerOperation(operation)).toBe(false);
      expect(() => Auth.restrictedPracticeLearner(operation as never)).toThrow(
        "Invalid restricted practice learner",
      );
    }
  });

  test("a forged declaration cannot reach an endpoint value", () => {
    const forged = { policy: { kind: "restrictedPracticeLearner", operation: "read_history" } };
    expect(() =>
      endpoint({ method: "GET", path: "/forged", auth: forged as never, response: Schema.String }),
    ).toThrow("Invalid restricted practice learner");
  });
});
