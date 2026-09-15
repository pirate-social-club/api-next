import { describe, expect, test } from "bun:test";
import { Auth, endpoint, endpoints } from "@pirate/contracts";
import { Schema } from "effect";
import { assertSupportedAuthPolicies, supportedAuthPolicy } from "./auth-policy.ts";

describe("HTTP worker authentication policy boundary", () => {
  test("admits every production endpoint through the explicit supported interpreter", () => {
    expect(() => assertSupportedAuthPolicies(endpoints)).not.toThrow();
  });

  test("rejects unsupported privileged kinds and unknown shared secrets", () => {
    for (const auth of [
      Auth.admin("admin:test"),
      Auth.operator("operator:test"),
      Auth.agentDelegated("agent:test"),
      Auth.device("device:test"),
      Auth.userOrAdminOrAgentDelegated("agent:test"),
      Auth.sharedSecret("telegram"),
    ]) {
      expect(() =>
        assertSupportedAuthPolicies([
          endpoint({ method: "GET", path: "/unsupported", auth, response: Schema.String }),
        ]),
      ).toThrow("HTTP worker authentication policy is unsupported");
    }
  });

  test("classifies the supported declarations without changing user semantics", () => {
    expect(supportedAuthPolicy(Auth.public().policy)).toEqual({ kind: "public" });
    expect(supportedAuthPolicy(Auth.user().policy)).toEqual({ kind: "user" });
    expect(supportedAuthPolicy(Auth.userOrAdmin().policy)).toEqual({ kind: "userOrAdmin" });
    expect(supportedAuthPolicy(Auth.sharedSecret("hns-edge-alert").policy)).toEqual({
      kind: "sharedSecret",
      name: "hns-edge-alert",
    });
  });
});
