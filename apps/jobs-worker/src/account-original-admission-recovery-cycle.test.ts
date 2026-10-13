import { expect, test } from "bun:test";
import { ControlPlaneTransactionOutcomeUnknown } from "@pirate/application";
import { Effect } from "effect";
import { runStudySourceRecoveryCycle, type StudySourceRecoveryStages } from "./study-source-recovery-cycle.ts";
const account = { claimed: 1, recovered: 1, storageFailures: 0, fenced: 0 };
const guest = { examined: 0, completed: 0, pending: 0, skipped: 0 };
test("original Account reconciliation runs after spoken and before any Guest source or expiry", async () => {
 const order: string[] = [];
 const stages: StudySourceRecoveryStages = {
  account: Effect.sync(() => { order.push("spoken"); return account; }),
  accountOriginalAdmissionReconciliation: Effect.sync(() => { order.push("account-original"); return { examined: 1, reconciled: 1 }; }),
  guest: { closed: Effect.sync(() => { order.push("guest"); return guest; }),
   capturedChoices: Effect.sync(() => { order.push("guest-choice"); return []; }),
   releaseNext: () => Effect.sync(() => { order.push("expiry"); return { state: "idle" as const }; }),
   maximumReleases: 1, ephemeralCleanup: Effect.sync(() => { order.push("cleanup"); }) },
 };
 await Effect.runPromise(runStudySourceRecoveryCycle(stages));
 expect(order).toEqual(["spoken", "account-original", "guest", "guest-choice", "expiry", "cleanup"]);
});
test("original Account reconcile unknown stops every later stage without retry", async () => {
 let calls = 0; let later = 0;
 const unknown = new ControlPlaneTransactionOutcomeUnknown({ phase: "commit", label: "original-account-reconcile", limitMs: 1, elapsedMs: 1 });
 const stages: StudySourceRecoveryStages = { account: Effect.succeed(account),
  accountOriginalAdmissionReconciliation: Effect.sync(() => { calls++; }).pipe(Effect.flatMap(() => Effect.fail(unknown))),
  guest: { closed: Effect.sync(() => { later++; return guest; }),
   capturedChoices: Effect.sync(() => { later++; return []; }),
   releaseNext: () => Effect.sync(() => { later++; return { state: "idle" as const }; }),
   maximumReleases: 1, ephemeralCleanup: Effect.sync(() => { later++; }) },
 };
 expect(await Effect.runPromise(Effect.flip(runStudySourceRecoveryCycle(stages)))).toBe(unknown);
 expect(calls).toBe(1); expect(later).toBe(0);
});
