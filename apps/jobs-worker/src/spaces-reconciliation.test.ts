import { describe, expect, spyOn, test } from "bun:test";
import {
  AlertCollector,
  type SpacesFinalIssuanceVerifier,
  type SpacesReconciliationStore,
  type SpacesVerificationTargetV1,
} from "@pirate/application";
import type { AlertSink } from "@pirate/platform-cf";
import { makeSpacesFinalIssuanceVerifier } from "@pirate/platform-cf/spaces-final-issuance-verifier";
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

const credentials = {
  accessClientId: "test-id",
  accessClientSecret: "test-secret",
  bearerToken: "test-token",
};

function verificationFixture(
  verifier: SpacesFinalIssuanceVerifier,
  targets: readonly SpacesVerificationTargetV1[] = [{ ...target("test"), network: "mainnet" }],
) {
  const retried: string[] = [];
  const store: SpacesReconciliationStore = {
    markOverdue: () => Effect.succeed([]),
    unalertedOverdue: () => Effect.succeed([]),
    markOverdueAlerted: () => Effect.void,
    unalertedScopeAnomalies: () => Effect.succeed([]),
    markScopeAnomalyAlerted: () => Effect.void,
    leaseDue: () => Effect.succeed(targets),
    retryLater: (item) =>
      Effect.sync(() => {
        retried.push(item.claim_id);
        return "scheduled" as const;
      }),
    finalize: () => Effect.succeed("issued"),
    recordConflict: () => Effect.succeed("conflict"),
  };
  const job = makeSpacesReconciliationJob(sink, store, verifier, {
    overdueThresholdSeconds: 86_400,
    measurementReference: "logging-regression-fixture",
  });
  return {
    retried,
    effect: job.run.pipe(
      Effect.provideService(AlertCollector, { emit: () => Effect.void }),
      Effect.provideService(JobContext, {
        adapterSafety: { isProven: () => false, markAbortedOrFenced: () => undefined },
        attemptId: "attempt-logging",
        lease: () => ({ expiresAt: Date.now() + 120_000, generation: 1, owner: "test" }),
        owner: "test",
      }),
    ),
  };
}

const unobservedWarning = [
  "spaces.final_issuance.verifier_retry",
  { phase: "effect_failure_or_timeout", status: null },
];

describe("Spaces reconciliation job", () => {
  test.each([502, 503])(
    "logs an adapter HTTP %s failure once and still retries",
    async (status) => {
      const warnings: unknown[][] = [];
      const logger = spyOn(console, "warn").mockImplementation((...args) => {
        warnings.push(args);
      });
      try {
        const fixture = verificationFixture(
          makeSpacesFinalIssuanceVerifier(credentials, async () => new Response(null, { status })),
        );
        await Effect.runPromise(fixture.effect);
        expect(fixture.retried).toEqual(["claim-test"]);
        expect(warnings).toEqual([
          ["spaces.final_issuance.verifier_retry", { phase: "verify_response", status }],
        ]);
      } finally {
        logger.mockRestore();
      }
    },
  );

  test.each([
    { ...target("bad-network"), network: "regtest" as const },
    { ...target("bad-script"), network: "mainnet" as const, script_pubkey_hex: "invalid" },
  ])("keeps the job warning for pre-request rejection $claim_id", async (invalidTarget) => {
    let requests = 0;
    const warnings: unknown[][] = [];
    const logger = spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });
    try {
      const fixture = verificationFixture(
        makeSpacesFinalIssuanceVerifier(credentials, async () => {
          requests += 1;
          return new Response(null, { status: 503 });
        }),
        [invalidTarget],
      );
      await Effect.runPromise(fixture.effect);
      expect(requests).toBe(0);
      expect(fixture.retried).toEqual([invalidTarget.claim_id]);
      expect(warnings).toEqual([unobservedWarning]);
    } finally {
      logger.mockRestore();
    }
  });

  test("keeps the job warning for an otherwise unlogged verifier failure", async () => {
    const warnings: unknown[][] = [];
    const logger = spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });
    try {
      const fixture = verificationFixture({
        verify: () => Effect.fail(new Error("private upstream detail")),
      });
      await Effect.runPromise(fixture.effect);
      expect(warnings).toEqual([unobservedWarning]);
      expect(fixture.retried).toEqual(["claim-test"]);
    } finally {
      logger.mockRestore();
    }
  });

  test("does not carry a logged failure into the next verification", async () => {
    const warnings: unknown[][] = [];
    const logger = spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });
    try {
      const fixture = verificationFixture(
        makeSpacesFinalIssuanceVerifier(
          credentials,
          async () => new Response(null, { status: 503 }),
        ),
        [{ ...target("logged"), network: "mainnet" }, target("unlogged")],
      );
      await Effect.runPromise(fixture.effect);
      expect(warnings).toEqual([
        ["spaces.final_issuance.verifier_retry", { phase: "verify_response", status: 503 }],
        unobservedWarning,
      ]);
      expect(fixture.retried).toEqual(["claim-logged", "claim-unlogged"]);
    } finally {
      logger.mockRestore();
    }
  });

  test("resets diagnostic state when the same verification Effect is executed again", async () => {
    const warnings: unknown[][] = [];
    const logger = spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });
    try {
      let requests = 0;
      const verifier = makeSpacesFinalIssuanceVerifier(credentials, async () => {
        requests += 1;
        if (requests === 1) return new Response(null, { status: 503 });
        return new Response(
          new ReadableStream({
            cancel() {
              throw new Error("private cancellation detail");
            },
          }),
          { status: 409 },
        );
      });
      const verification = verifier.verify({ ...target("replayed"), network: "mainnet" });
      const fixture = verificationFixture({ verify: () => verification });
      await Effect.runPromise(fixture.effect);
      await Effect.runPromise(fixture.effect);
      expect(warnings).toEqual([
        ["spaces.final_issuance.verifier_retry", { phase: "verify_response", status: 503 }],
        unobservedWarning,
      ]);
      expect(fixture.retried).toEqual(["claim-test", "claim-test"]);
    } finally {
      logger.mockRestore();
    }
  });

  test("keeps the job warning and retry when the outer deadline expires", async () => {
    const warnings: unknown[][] = [];
    const logger = spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });
    try {
      const fixture = verificationFixture({ verify: () => Effect.never });
      await Effect.runPromise(fixture.effect);
      expect(warnings).toEqual([unobservedWarning]);
      expect(fixture.retried).toEqual(["claim-test"]);
    } finally {
      logger.mockRestore();
    }
  }, 15_000);

  test("logs an outer interruption even when the adapter never reaches a handler", async () => {
    const warnings: unknown[][] = [];
    const logger = spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args);
    });
    try {
      const started = Promise.withResolvers<void>();
      const fixture = verificationFixture({
        verify: () => Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never)),
      });
      const controller = new AbortController();
      const run = Effect.runPromiseExit(fixture.effect, { signal: controller.signal });
      await started.promise;
      controller.abort();
      await run;
      expect(warnings).toEqual([unobservedWarning]);
      expect(fixture.retried).toEqual([]);
    } finally {
      logger.mockRestore();
    }
  });

  test("finalizes only independently verified claims and retries unavailable evidence", async () => {
    const finalized: string[] = [];
    const conflicted: string[] = [];
    const retried: string[] = [];
    const alerts: string[] = [];
    const evidence = {
      certificate_sha256_hex: "a".repeat(64),
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
