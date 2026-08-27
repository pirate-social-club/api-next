import { describe, expect, test } from "bun:test";
import { makeDataRegistrationComposition } from "./composition";

const base = {
  CONTROL_PLANE: { connectionString: "postgres://postgres:postgres@127.0.0.1:5432/postgres" },
  DATA_REGISTRATION_WORKFLOW: {
    get: async () => ({ status: async () => ({ status: "unknown" }) }),
    createBatch: async () => [],
  },
};

describe("DATA registration composition", () => {
  test("does not require or read provider credentials while disabled", () => {
    expect(
      makeDataRegistrationComposition({
        ...base,
        API_NEXT_ENV: "staging",
        DATA_REGISTRATION_ENABLED: "false",
      }).workflow.options,
    ).toEqual({ enabled: false });
  });

  test("refuses to activate the reviewed direct-key adapter outside staging", () => {
    expect(() =>
      makeDataRegistrationComposition({
        ...base,
        API_NEXT_ENV: "production",
        DATA_REGISTRATION_ENABLED: "true",
      }),
    ).toThrow("staging-only");
  });
});
