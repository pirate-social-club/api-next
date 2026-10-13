import { describe, expect, test } from "bun:test";
import { guestParticipationRegistry } from "@pirate/contracts";
import type { SessionTokenVerifier } from "@pirate/platform-cf/session-tokens";
import { makeGuestStudyServingComposition } from "./guest-study-serving-composition.ts";
import { createHttpWorker } from "./transport.ts";

describe("Guest Study serving admission", () => {
  test("absent or false admission is inert and production cannot activate", async () => {
    let verifies = 0;
    const accountVerifier: SessionTokenVerifier = {
      verify: () => {
        verifies++;
        throw new Error("Inert admission must not authenticate");
      },
    };
    const input = {
      environment: "staging",
      accountVerifier,
      ordinarySessionScope: "fixture-session",
    };
    expect(await makeGuestStudyServingComposition(input)).toBeNull();
    expect(
      await makeGuestStudyServingComposition({ ...input, enabledBinding: "false" }),
    ).toBeNull();
    for (const environment of ["production", "prod", "unknown"])
      await expect(
        makeGuestStudyServingComposition({ ...input, environment, enabledBinding: "true" }),
      ).rejects.toThrow("nonproduction");
    await expect(
      makeGuestStudyServingComposition({ ...input, enabledBinding: "TRUE" }),
    ).rejects.toThrow("nonproduction");
    await expect(
      makeGuestStudyServingComposition({ ...input, enabledBinding: "true" }),
    ).rejects.toThrow("Managed");
    expect(verifies).toBe(0);
  });
  test("actual Worker keeps all twenty-one operations unavailable without a managed graph with no body read or cookie issuance", async () => {
    const worker = createHttpWorker();
    for (const declaration of Object.values(guestParticipationRegistry)) {
      const path = declaration.path.replace(/:[A-Za-z_]+/gu, "fixture-id");
      const request = new Request(`https://community.example${path}`, {
        method: declaration.method,
        ...(declaration.method === "GET" ? {} : { body: "untrusted-body" }),
      });
      let reads = 0;
      const original = request.arrayBuffer.bind(request);
      request.arrayBuffer = async () => {
        reads++;
        return original();
      };
      const response = await worker.fetch(request);
      expect(response.status).toBe(404);
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(reads).toBe(0);
      expect(request.bodyUsed).toBe(false);
      if (declaration.auth.policy.kind === "browserParticipation")
        expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});
