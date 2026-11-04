import { describe, expect, test } from "bun:test";
import { guestParticipationRegistry } from "@pirate/contracts";
import {
  guestAccountingNames,
  guestLearningNames,
} from "./guest-authority-controller-composition.ts";
import {
  type GuestStudyManagedBindings,
  makeDefaultGuestStudyManagedRuntime,
} from "./guest-study-managed-bindings.ts";

describe("Default managed Guest Study binding selection", () => {
  test("absent/false configuration reads no database, provider, origin or storage binding", () => {
    let reads = 0;
    const closed = (): never => {
      reads++;
      throw new Error("Inert path read a binding");
    };
    const configured = (enabled?: string): GuestStudyManagedBindings => ({
      ...(enabled === undefined ? {} : { GUEST_STUDY_SERVING_ENABLED: enabled }),
      get GUEST_STUDY_PUBLIC_READ() {
        return closed();
      },
      get GUEST_STUDY_CONTROLLED_LEARNING() {
        return closed();
      },
      get GUEST_STUDY_CRON() {
        return closed();
      },
      get GUEST_STUDY_READINESS_OBSERVER() {
        return closed();
      },
      get GUEST_STUDY_PRODUCT_ORIGIN() {
        return closed();
      },
      get ELEVENLABS_API_KEY() {
        return closed();
      },
      get LEARNER_AUDIO() {
        return closed();
      },
    });
    expect(makeDefaultGuestStudyManagedRuntime(configured(), "production")).toBeNull();
    expect(makeDefaultGuestStudyManagedRuntime(configured("false"), "staging")).toBeNull();
    expect(reads).toBe(0);
  });
  test("production/unknown/invalid enablement refuse before touching managed bindings", () => {
    for (const environment of ["production", "prod", "unknown"])
      expect(() =>
        makeDefaultGuestStudyManagedRuntime({ GUEST_STUDY_SERVING_ENABLED: "true" }, environment),
      ).toThrow("nonproduction");
    expect(() =>
      makeDefaultGuestStudyManagedRuntime({ GUEST_STUDY_SERVING_ENABLED: "TRUE" }, "staging"),
    ).toThrow("nonproduction");
  });
  test("admitted learning metadata leaves accounting disabled and cannot replace storage admission", () => {
    expect(guestLearningNames).toHaveLength(16);
    expect(guestAccountingNames).toHaveLength(5);
    for (const name of guestLearningNames)
      expect(guestParticipationRegistry[name].implementation).toBeUndefined();
    for (const name of guestAccountingNames)
      expect(guestParticipationRegistry[name].implementation).toBe("disabled");
    expect(() =>
      makeDefaultGuestStudyManagedRuntime(
        {
          GUEST_STUDY_SERVING_ENABLED: "true",
          GUEST_STUDY_PRODUCT_ORIGIN: "https://community.example",
        },
        "staging",
      ),
    ).toThrow("learner audio binding unavailable");
  });
});
