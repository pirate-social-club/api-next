import { describe, expect, test } from "bun:test";
import {
  AlertCollector,
  type SpacesFinalIssuanceVerifier,
  type SpacesReconciliationStore,
  type SpacesVerificationTargetV1,
} from "@pirate/application";
import type { AlertSink } from "@pirate/platform-cf";
import { Effect } from "effect";
import { JobContext } from "./registry.ts";
import { makeSpacesReconciliationJob } from "./spaces-reconciliation.ts";

const sink: AlertSink = {
  log: () => undefined,
  delivery: { markSent: () => Effect.succeed(true), compensate: () => Effect.void },
};

const target = (label: string): SpacesVerificationTargetV1 => ({
  claim_id: `claim-${label}`,
  lease_token: `slease_${"a".repeat(32)}`,
  network: "regtest",
  namespace_root: "charizard",
  handle_label: label,
  script_pubkey_hex: `5120${"1".repeat(64)}`,
});

describe("Spaces reconciliation job", () => {
  test("finalizes only independently verified claims and retries unavailable evidence", async () => {
    const finalized: string[] = [];
    const conflicted: string[] = [];
    const retried: string[] = [];
    const alerts: string[] = [];
    const evidence = {
      certificate_sha256_hex: "a".repeat(64),
      commitment_txid_hex: "b".repeat(64),
      commitment_root_hex: "c".repeat(64),
      mined_height: 100,
      verified_tip_height: 245,
      verifier_id: "independent-verifier",
      verifier_version: "test-v1",
      observed_at: new Date().toISOString(),
    };
    const store: SpacesReconciliationStore = {
      markOverdue: () => Effect.succeed(["claim-overdue"]),
      unalertedOverdue: () => Effect.succeed(["claim-overdue"]),
      markOverdueAlerted: () => Effect.void,
      unalertedScopeAnomalies: () =>
        Effect.succeed([{ anomaly_id: "anomaly-1", reason: "space_not_assigned" }]),
      markScopeAnomalyAlerted: () => Effect.void,
      leaseDue: () =>
        Effect.succeed([
          target("verified"),
          target("missing"),
          target("offline"),
          target("occupied"),
        ]),
      retryLater: (item) =>
        Effect.sync(() => {
          retried.push(item.claim_id);
          return "scheduled" as const;
        }),
      finalize: (item) =>
        Effect.sync(() => {
          finalized.push(item.claim_id);
          return "issued" as const;
        }),
      recordConflict: (item) =>
        Effect.sync(() => {
          conflicted.push(item.claim_id);
          return "conflict" as const;
        }),
    };
    const verifier: SpacesFinalIssuanceVerifier = {
      verify: (item) =>
        item.handle_label === "offline"
          ? Effect.fail(new Error("verifier unavailable"))
          : Effect.succeed(
              item.handle_label === "missing"
                ? { kind: "pending" as const }
                : item.handle_label === "occupied"
                  ? {
                      kind: "occupied_other" as const,
                      observed_script_pubkey_hex: `5120${"2".repeat(64)}`,
                      evidence,
                    }
                  : { kind: "final" as const, evidence },
            ),
    };
    const job = makeSpacesReconciliationJob(sink, store, verifier, {
      overdueThresholdSeconds: 86_400,
      measurementReference: "regtest-measurement-fixture",
    });
    await Effect.runPromise(
      job.run.pipe(
        Effect.provideService(AlertCollector, {
          emit: (alert) =>
            Effect.sync(() => {
              alerts.push(alert.key);
            }),
        }),
        Effect.provideService(JobContext, {
          adapterSafety: { isProven: () => false, markAbortedOrFenced: () => undefined },
          attemptId: "attempt-1",
          lease: () => ({ expiresAt: Date.now() + 120_000, generation: 1, owner: "test" }),
          owner: "test",
        }),
      ),
    );
    expect(finalized).toEqual(["claim-verified"]);
    expect(conflicted).toEqual(["claim-occupied"]);
    expect(retried).toEqual(["claim-missing", "claim-offline"]);
    expect(alerts).toEqual([
      "spaces-native:issuance-overdue",
      "spaces-native:registry-scope-anomaly",
    ]);
    expect(job.requiresAdapterSafety).toBe(true);
  });
});
