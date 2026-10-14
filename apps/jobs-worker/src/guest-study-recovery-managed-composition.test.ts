import { describe, expect, test } from "bun:test";
import {
  type GuestStudyRecoveryManagedBindings,
  makeDefaultGuestStudyRecoveryComposition,
} from "./guest-study-recovery-managed-composition.ts";

describe("Default Guest jobs managed selection", () => {
  test("inert source queues no jobs or managed reads; malformed/unsupported finance refuses first", async () => {
    let reads = 0;
    const closed = (): never => {
      reads++;
      throw new Error("inert recovery touched managed binding");
    };
    const bindings: GuestStudyRecoveryManagedBindings = {
      get CONTROL_PLANE() {
        return closed();
      },
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
      get LEARNER_AUDIO() {
        return closed();
      },
    };
    expect(await makeDefaultGuestStudyRecoveryComposition(bindings, "production")).toBeUndefined();
    await expect(
      makeDefaultGuestStudyRecoveryComposition({ GUEST_STUDY_REWARDS_ENABLED: "true" }, "staging"),
    ).rejects.toThrow("learning");
    await expect(
      makeDefaultGuestStudyRecoveryComposition(
        { GUEST_STUDY_SERVING_ENABLED: "true", GUEST_STUDY_REWARDS_ENABLED: "TRUE" },
        "staging",
      ),
    ).rejects.toThrow("invalid");
    await expect(
      makeDefaultGuestStudyRecoveryComposition(
        { GUEST_STUDY_SERVING_ENABLED: "true", GUEST_STUDY_REWARDS_ENABLED: "true" },
        "production",
      ),
    ).rejects.toThrow("nonproduction");
    expect(reads).toBe(0);
  });
});
