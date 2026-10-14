// Actual current267 five-principal recovery selection, independent of NEW rewards.
import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { makeControlPlaneAccountOriginalAdmissionReconciliation } from "../../../packages/platform-cf/src/account-original-admission-reconciliation.ts";
import { pgUrl } from "../../../packages/platform-cf/src/account-study-producer.pg-fixture.ts";
import { ownerFinancialGuestStudyReadinessSource } from "../../../packages/platform-cf/src/owner-financial-guest-study-readiness-source.ts";
import { defaultWorkerFixture } from "../../http-worker/src/guest-study-default-worker.pg-fixture.ts";
import { makeDefaultGuestStudyRecoveryComposition } from "./guest-study-recovery-managed-composition.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const pgTest = pgUrl ? test : test.skip;
pgTest(
  "current267 jobs admit five real LOGINs and retain original recovery with NEW rewards absent/false/true",
  async () => {
    const raw = await readFile(
      new URL(
        "../../../packages/platform-cf/src/owner-financial-guest-study-readiness-source.ts",
        import.meta.url,
      ),
    );
    expect(createHash("sha256").update(raw).digest("hex")).toBe(
      "fc69608523ff80f27abbd533e7364ee44d719ca138c9ce2d6e2b2e22d6ead003",
    );
    const source = ownerFinancialGuestStudyReadinessSource;
    if (source === null) throw new Error("Actual compiled current267 source required");
    expect(source.candidate.ledger).toHaveLength(267);
    expect(source.candidate.native_function_bodies).toHaveLength(423);
    expect(source.candidate.profiles.ordinaryAccount.functions).toHaveLength(124);
    await defaultWorkerFixture(
      async (f) => {
        const ordinary = f.principals.ordinaryAccount;
        if (ordinary === undefined) throw new Error("Verified actual fifth LOGIN required");
        expect(new Set(Object.values(f.principals).map((p) => p.role)).size).toBe(5);
        const before = await f.snapshot();
        let storageCalls = 0;
        // An idle original-source cycle must perform no storage operation. This is
        // an owned fixture boundary, not a fake native verifier or callback result.
        const bucket: Pick<R2Bucket, "put" | "delete"> = {
          put: async () => {
            storageCalls++;
            throw new Error("Idle recovery attempted PUT");
          },
          delete: async () => {
            storageCalls++;
            throw new Error("Idle recovery attempted DELETE");
          },
        };
        for (const newRewards of [undefined, "false", "true"] as const) {
          const recovery = await makeDefaultGuestStudyRecoveryComposition(
            {
              GUEST_STUDY_SERVING_ENABLED: "true",
              ...(newRewards === undefined ? {} : { GUEST_STUDY_REWARDS_ENABLED: newRewards }),
              CONTROL_PLANE: { connectionString: ordinary.url },
              GUEST_STUDY_PUBLIC_READ: { connectionString: f.principals.publicRead.url },
              GUEST_STUDY_CONTROLLED_LEARNING: { connectionString: f.principals.learning.url },
              GUEST_STUDY_CRON: { connectionString: f.principals.cron.url },
              GUEST_STUDY_READINESS_OBSERVER: { connectionString: f.principals.observer.url },
              LEARNER_AUDIO: bucket,
            },
            "test",
          );
          if (recovery === undefined || recovery.accountOriginalAdmissionRuntime === undefined)
            throw new Error("Current267 original recovery must survive disabled NEW rewards");
          const stages = recovery();
          expect(stages.maximumReleases).toBe(4);
          expect(await Effect.runPromise(stages.closed)).toEqual({
            examined: 0,
            completed: 0,
            pending: 0,
            skipped: 0,
          });
          if (stages.capturedChoices === undefined)
            throw new Error("Original captured choice recovery required");
          expect(await Effect.runPromise(stages.capturedChoices)).toEqual([]);
          expect(await Effect.runPromise(stages.releaseNext())).toEqual({ state: "idle" });
          await Effect.runPromise(stages.ephemeralCleanup);
          expect(
            await Effect.runPromise(
              makeControlPlaneAccountOriginalAdmissionReconciliation(
                recovery.accountOriginalAdmissionRuntime,
              ).recover(8),
            ),
          ).toEqual({ examined: 0, completed: 0, reconciled: 0, stale: 0 });
        }
        expect(await f.snapshot()).toEqual(before);
        expect(storageCalls).toBe(0);
        expect(f.providerCalls()).toBe(0);
      },
      source,
      false,
    );
  },
  120000,
);
