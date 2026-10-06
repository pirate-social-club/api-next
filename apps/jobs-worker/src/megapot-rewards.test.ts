import { describe, expect, test } from "bun:test";
import { MegapotDrawingObservationRejected, RewardOperationsPaused } from "@pirate/application";
import {
  MegapotWorkStorageFailed,
  type MegapotWorkStore,
} from "@pirate/platform-cf/megapot-work-repository";
import { Effect } from "effect";
import {
  type MegapotRewardsRuntime,
  megapotRewardsDrawingObservationAlert,
  megapotRewardsLivenessAlerts,
  observeMegapotDrawingForCycle,
  resolveGasTopupRuntime,
  runMegapotRewardsCycle,
  writeMegapotRewardsCycleSnapshot,
} from "./megapot-rewards-cycle.ts";

const drawing = (status: Parameters<MegapotWorkStore["loadDrawings"]>[0]["statuses"][number]) => ({
  poolLegId: "leg-1",
  drawingId: 101n,
  status,
  attestationId: "attestation-1",
  ticketPriceAtomic: 1_000_000n,
});

function fixture(approvalKind: "submitted" | "confirmed") {
  const calls: string[] = [];
  const work: MegapotWorkStore = {
    loadChainEffects: () =>
      Effect.succeed([{ effectId: "effect-1", effectKind: "ticket_purchase" }]),
    loadPendingFunding: ({ limit, cursor }) =>
      Effect.sync(() => calls.push(`load-pending-funding:${limit}:${cursor}`)).pipe(
        Effect.as(["funding-pending-1"]),
      ),
    loadDrawings: ({ statuses }) => Effect.succeed(statuses.map(drawing)),
    loadCredits: () => Effect.succeed(["credit-1"]),
    loadRefunds: () => Effect.succeed(["funding-1"]),
    loadAgedPending: () => Effect.sync(() => calls.push("load-aged-pending")).pipe(Effect.as([])),
  };
  const call = (name: string) =>
    Effect.sync(() => {
      calls.push(name);
      return { kind: "complete" };
    });
  const runtime: MegapotRewardsRuntime = {
    reconcile: () => call("reconcile"),
    reconcileFunding: (fundingEffectId) =>
      call(`reconcile-funding:${fundingEffectId}`).pipe(Effect.as({ kind: "confirmed" })),
    observeDrawing: () => call("observe-drawing").pipe(Effect.as(true)),
    observeSolvency: () => call("observe-solvency"),
    freezeDue: () => call("cutoff").pipe(Effect.as([{}])),
    publishCommitment: () => call("commitment"),
    approve: () => call("approval").pipe(Effect.as({ kind: approvalKind })),
    closeUnavailablePurchase: () => call("purchase-window").pipe(Effect.as(null)),
    purchase: () => call("purchase").pipe(Effect.as({ kind: "submitted" })),
    sweep: () => call("sweep"),
    claim: () => call("claim"),
    allocate: () => call("allocate"),
    closeExpiredOffers: () => call("close-expired").pipe(Effect.as([{}])),
    refund: () => call("refund"),
    payout: () => call("payout"),
  };
  return { calls, runtime, work };
}

describe("Megapot rewards scheduled cycle", () => {
  test("writes one versioned cycle summary without entity identifiers", () => {
    const events: unknown[] = [];
    const written = writeMegapotRewardsCycleSnapshot(
      {
        reconciled: 1,
        fundingObserved: 3,
        fundingConfirmed: 1,
        fundingDeferred: 2,
        observed: 1,
        drawingObservationFailed: false,
        frozen: 0,
        committed: 0,
        purchased: 0,
        swept: 1,
        claimed: 0,
        allocated: 0,
        terminalOffers: 1,
        refunded: 1,
        paid: 0,
        gasTopups: 0,
        failures: ["RewardRefundRejected"],
        failureDiagnostics: [],
        agedPending: [
          { family: "chain_effects", count: 2, oldestAgeSeconds: 1_200 },
          { family: "refund_liabilities", count: 1, oldestAgeSeconds: 900 },
        ],
      },
      {
        environment: "staging",
        emittedAt: "2026-08-30T05:00:00.000Z",
        durationMs: 1_234,
        workerVersion: {
          id: "worker-version-1",
          tag: "",
          timestamp: "2026-08-30T04:59:00.000Z",
        },
      },
      (event, fields) => events.push({ event, fields }),
    );
    expect(written).toBe(true);
    expect(events).toEqual([
      {
        event: "megapot.rewards.cycle",
        fields: expect.objectContaining({
          event: "megapot.rewards.cycle",
          schema_version: 4,
          environment: "staging",
          worker_version_id: "worker-version-1",
          duration_ms: 1_234,
          funding_observed_count: 3,
          funding_confirmed_count: 1,
          funding_deferred_count: 2,
          observed_count: 1,
          swept_count: 1,
          terminal_offer_count: 1,
          refunded_count: 1,
          failure_count: 1,
          failure_tags: ["RewardRefundRejected"],
          failure_diagnostics: [],
          liveness_status: "available",
          aged_pending_threshold_seconds: 600,
          aged_pending_total_count: 3,
          aged_chain_effect_count: 2,
          aged_funding_effect_count: 0,
          aged_drawing_count: 0,
          aged_credit_count: 0,
          aged_refund_liability_count: 1,
          oldest_aged_pending_seconds: 1_200,
          outcome: "degraded",
          sampled: false,
        }),
      },
    ]);
  });

  test("keeps an unavailable cycle-summary sink diagnostic-only", () => {
    expect(
      writeMegapotRewardsCycleSnapshot(
        {
          reconciled: 0,
          observed: 0,
          drawingObservationFailed: false,
          frozen: 0,
          committed: 0,
          purchased: 0,
          swept: 0,
          claimed: 0,
          allocated: 0,
          terminalOffers: 0,
          refunded: 0,
          paid: 0,
          gasTopups: 0,
          failures: [],
          failureDiagnostics: [],
          agedPending: [],
        },
        {
          environment: "staging",
          emittedAt: "2026-08-30T05:00:00.000Z",
          durationMs: 50,
          workerVersion: {
            id: "worker-version-1",
            tag: "",
            timestamp: "2026-08-30T04:59:00.000Z",
          },
        },
        () => {
          throw new Error("sink unavailable");
        },
      ),
    ).toBe(false);
  });

  test("records an unavailable liveness projection without false zero counts", () => {
    const events: unknown[] = [];
    expect(
      writeMegapotRewardsCycleSnapshot(
        {
          reconciled: 0,
          observed: 0,
          drawingObservationFailed: false,
          frozen: 0,
          committed: 0,
          purchased: 0,
          swept: 0,
          claimed: 0,
          allocated: 0,
          terminalOffers: 0,
          refunded: 0,
          paid: 0,
          gasTopups: 0,
          failures: [],
          failureDiagnostics: [],
          agedPending: null,
        },
        {
          environment: "staging",
          emittedAt: "2026-08-30T05:00:00.000Z",
          durationMs: 50,
          workerVersion: {
            id: "worker-version-1",
            tag: "",
            timestamp: "2026-08-30T04:59:00.000Z",
          },
        },
        (_event, fields) => events.push(fields),
      ),
    ).toBe(true);
    expect(events[0]).toMatchObject({
      liveness_status: "unavailable",
      aged_pending_total_count: null,
      aged_chain_effect_count: null,
      aged_funding_effect_count: null,
      aged_drawing_count: null,
      aged_credit_count: null,
      aged_refund_liability_count: null,
      oldest_aged_pending_seconds: null,
      outcome: "degraded",
    });
  });

  test("advances every persisted phase sequentially under one custody lane", async () => {
    const { calls, runtime, work } = fixture("confirmed");
    const result = await Effect.runPromise(runMegapotRewardsCycle({ work, runtime, now: () => 0 }));
    expect(calls).toEqual([
      "reconcile",
      "observe-drawing",
      "observe-solvency",
      "cutoff",
      "commitment",
      "approval",
      "purchase",
      "sweep",
      "sweep",
      "claim",
      "allocate",
      "close-expired",
      "refund",
      "payout",
      "load-pending-funding:10:0",
      "reconcile-funding:funding-pending-1",
      "load-aged-pending",
    ]);
    expect(result).toMatchObject({
      reconciled: 1,
      fundingObserved: 1,
      fundingConfirmed: 1,
      observed: 1,
      drawingObservationFailed: false,
      frozen: 1,
      committed: 1,
      purchased: 1,
      swept: 2,
      claimed: 1,
      allocated: 1,
      terminalOffers: 1,
      refunded: 1,
      paid: 1,
      failures: [],
      failureDiagnostics: [],
      agedPending: [],
    });
  });

  test("keeps an unavailable liveness projection diagnostic-only", async () => {
    const { calls, runtime, work } = fixture("confirmed");
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work: {
          ...work,
          loadAgedPending: () =>
            Effect.fail(new MegapotWorkStorageFailed({ reason: "unavailable" })),
        },
        runtime,
      }),
    );

    expect(calls).toContain("payout");
    expect(result.agedPending).toBeNull();
    expect(result.failures).toEqual([]);
  });

  test("emits stable identifier-free high conditions for aged state families", () => {
    expect(
      megapotRewardsLivenessAlerts([
        { family: "drawings", count: 2, oldestAgeSeconds: 1_800 },
        { family: "credits", count: 1, oldestAgeSeconds: 900 },
      ]),
    ).toEqual([
      {
        key: "megapot-rewards:aged-drawings",
        severity: "high",
        body: "Reward drawing transitions exceeded their persisted schedule grace period.",
      },
      {
        key: "megapot-rewards:aged-credits",
        severity: "high",
        body: "Reward credits exceeded the payout grace period.",
      },
    ]);
    expect(megapotRewardsLivenessAlerts([])).toEqual([]);
    expect(megapotRewardsLivenessAlerts(null)).toEqual([
      {
        key: "megapot-rewards:aged-state-projection-unavailable",
        severity: "high",
        body: "The aggregate rewards liveness projection was unavailable.",
      },
    ]);
  });

  test("does not purchase until the shared allowance transaction is confirmed", async () => {
    const { calls, runtime, work } = fixture("submitted");
    const result = await Effect.runPromise(runMegapotRewardsCycle({ work, runtime }));
    expect(calls).toContain("approval");
    expect(calls).not.toContain("purchase");
    expect(result.purchased).toBe(0);
  });

  test("sends open gas top-ups after payouts and skips the step without a gas signer", async () => {
    const { calls, runtime, work } = fixture("confirmed");
    const skipped = await Effect.runPromise(runMegapotRewardsCycle({ work, runtime }));
    expect(skipped.gasTopups).toBe(0);

    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work,
        runtime: {
          ...runtime,
          gasTopups: {
            listOpen: () => Effect.succeed(["topup-fail", "topup-pass"]),
            send: (topupId) => {
              calls.push(`gas-topup:${topupId}`);
              return topupId === "topup-fail"
                ? Effect.fail({ _tag: "RewardGasTopupCoordinatorFailed" as const })
                : Effect.succeed({ kind: "submitted" });
            },
          },
        },
      }),
    );
    expect(result.gasTopups).toBe(1);
    expect(result.failures).toContain("RewardGasTopupCoordinatorFailed");
    expect(calls.lastIndexOf("gas-topup:topup-fail")).toBeGreaterThan(calls.lastIndexOf("payout"));
  });

  test("records a gas top-up listing failure and still reports liveness", async () => {
    const { calls, runtime, work } = fixture("confirmed");
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work,
        runtime: {
          ...runtime,
          gasTopups: {
            listOpen: () => Effect.fail({ _tag: "RewardGasTopupStorageFailed" as const }),
            send: () => Effect.succeed({}),
          },
        },
      }),
    );
    expect(result.gasTopups).toBe(0);
    expect(result.failures).toContain("RewardGasTopupStorageFailed");
    expect(result.agedPending).toEqual([]);
    expect(calls).toContain("load-aged-pending");
  });

  test("a gas wallet lookup failure never aborts the job and is recorded by the cycle", async () => {
    const makeRuntime = () => ({
      listOpen: () => Effect.succeed([] as readonly string[]),
      send: () => Effect.succeed({}),
    });
    const failedLookup = await Effect.runPromise(
      resolveGasTopupRuntime({
        loadActiveSigner: () => Effect.fail({ _tag: "RewardGasTopupStorageFailed" as const }),
        configuredSigner: "0xgas",
        makeRuntime,
      }),
    );
    expect(failedLookup.signerMismatch).toBe(false);
    const { runtime, work } = fixture("confirmed");
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({ work, runtime: { ...runtime, gasTopups: failedLookup.runtime } }),
    );
    expect(result.failures).toContain("RewardGasTopupStorageFailed");
    expect(result.paid).toBe(1);

    expect(
      await Effect.runPromise(
        resolveGasTopupRuntime({
          loadActiveSigner: () => Effect.succeed(null),
          configuredSigner: "0xgas",
          makeRuntime,
        }),
      ),
    ).toEqual({ runtime: null, signerMismatch: false });
    expect(
      await Effect.runPromise(
        resolveGasTopupRuntime({
          loadActiveSigner: () => Effect.succeed("0xother"),
          configuredSigner: "0xgas",
          makeRuntime,
        }),
      ),
    ).toEqual({ runtime: null, signerMismatch: true });
    const matched = await Effect.runPromise(
      resolveGasTopupRuntime({
        loadActiveSigner: () => Effect.succeed("0xgas"),
        configuredSigner: "0xgas",
        makeRuntime,
      }),
    );
    expect(matched.runtime).not.toBeNull();
  });

  test("does not count a pre-broadcast terminal closure as a purchase", async () => {
    const { runtime, work } = fixture("confirmed");
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work,
        runtime: {
          ...runtime,
          purchase: () => Effect.succeed({ kind: "closed" }),
        },
      }),
    );
    expect(result.purchased).toBe(0);
  });

  test("continues other candidates after a typed phase failure and reports its tag", async () => {
    const { runtime, work } = fixture("confirmed");
    let attempts = 0;
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work: {
          ...work,
          loadCredits: () => Effect.succeed(["credit-fail", "credit-pass"]),
        },
        runtime: {
          ...runtime,
          payout: () => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail({ _tag: "RewardPayoutRejected" as const })
              : Effect.succeed({});
          },
        },
      }),
    );
    expect(result.paid).toBe(1);
    expect(result.failures).toContain("RewardPayoutRejected");
    expect(result.failureDiagnostics).toEqual([]);
  });

  test("retains only allow-listed refund coordinator reasons and phases", async () => {
    const { runtime, work } = fixture("confirmed");
    const cases = [
      ["configuration", "invalid_config"],
      ["preflight", "deployment_attestation_mismatch"],
      ["preflight", "gas_floor_insufficient"],
      ["preflight", "production_disabled"],
      ["prepare", "signer_mismatch"],
      ["receipt", "receipt_evidence_invalid"],
      ["preflight", "solvency_insufficient"],
    ] as const;
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work: {
          ...work,
          loadRefunds: () => Effect.succeed(cases.map((_, index) => `funding-${index}`)),
        },
        runtime: {
          ...runtime,
          refund: (fundingEffectId) => {
            const index = Number(fundingEffectId.replace("funding-", ""));
            const [phase, reason] = cases[index] ?? cases[0];
            return Effect.fail({
              _tag: "RewardRefundCoordinatorFailed" as const,
              phase,
              reason,
            });
          },
        },
      }),
    );

    expect(result.refunded).toBe(0);
    expect(result.failures).toEqual(cases.map(() => "RewardRefundCoordinatorFailed"));
    expect(result.failureDiagnostics).toEqual(
      cases.map(([phase, reason]) => `RewardRefundCoordinatorFailed:${phase}:${reason}`),
    );
  });

  test("fails closed to the outer tag for unrecognized refund diagnostics", async () => {
    const { runtime, work } = fixture("confirmed");
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work,
        runtime: {
          ...runtime,
          refund: () =>
            Effect.fail({
              _tag: "RewardRefundCoordinatorFailed" as const,
              phase: "hostile-phase",
              reason: "secret-provider-detail",
            }),
        },
      }),
    );

    expect(result.failures).toContain("RewardRefundCoordinatorFailed");
    expect(result.failureDiagnostics).toEqual([]);
  });

  test("continues return-side work while the contract rolls to its next drawing", async () => {
    const { calls, runtime, work } = fixture("confirmed");
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work,
        runtime: {
          ...runtime,
          observeDrawing: () =>
            observeMegapotDrawingForCycle(
              Effect.sync(() => calls.push("observe-drawing")).pipe(
                Effect.andThen(
                  Effect.fail(new MegapotDrawingObservationRejected({ reason: "drawing-closed" })),
                ),
              ),
            ),
        },
      }),
    );

    expect(result.observed).toBe(0);
    expect(calls).toContain("observe-solvency");
    expect(calls).toContain("sweep");
    expect(calls).toContain("claim");
    expect(calls).toContain("allocate");
    expect(calls).toContain("refund");
    expect(calls).toContain("payout");
  });

  test("keeps every non-rollover drawing rejection fail-closed", async () => {
    await expect(
      Effect.runPromise(
        observeMegapotDrawingForCycle(
          Effect.fail(
            new MegapotDrawingObservationRejected({
              reason: "deployment-attestation-mismatch",
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "MegapotDrawingObservationRejected",
      reason: "deployment-attestation-mismatch",
    });
  });

  test("continues owed work when the new drawing is malformed or unobservable", async () => {
    const { calls, runtime, work } = fixture("confirmed");
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work,
        runtime: {
          ...runtime,
          observeDrawing: () =>
            Effect.sync(() => calls.push("observe-drawing")).pipe(
              Effect.andThen(
                Effect.fail(
                  new MegapotDrawingObservationRejected({
                    reason: "deployment-attestation-mismatch",
                  }),
                ),
              ),
            ),
        },
      }),
    );

    expect(result.observed).toBe(0);
    expect(result.drawingObservationFailed).toBe(true);
    expect(result.failures).toContain("MegapotDrawingObservationRejected");
    expect(calls).toContain("reconcile");
    expect(calls).toContain("observe-solvency");
    expect(calls).toContain("close-expired");
    expect(calls).toContain("refund");
    expect(calls).toContain("payout");
    expect(result.refunded).toBe(1);
    expect(result.paid).toBe(1);
    expect(
      megapotRewardsDrawingObservationAlert({
        drawingObservationFailed: result.drawingObservationFailed,
      }),
    ).toMatchObject({ key: "megapot-rewards:drawing-observation-failed" });
  });

  test("does not flag drawing observation when the rollover rejection closed a drawing", async () => {
    const { calls, runtime, work } = fixture("confirmed");
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work,
        runtime: {
          ...runtime,
          observeDrawing: () =>
            observeMegapotDrawingForCycle(
              Effect.sync(() => calls.push("observe-drawing")).pipe(
                Effect.andThen(
                  Effect.fail(new MegapotDrawingObservationRejected({ reason: "drawing-closed" })),
                ),
              ),
            ),
        },
      }),
    );

    expect(result.drawingObservationFailed).toBe(false);
    expect(result.failures).not.toContain("MegapotDrawingObservationRejected");
    expect(megapotRewardsDrawingObservationAlert(result)).toBeNull();
  });

  test("records a solvency observation failure without stopping the cycle", async () => {
    const { calls, runtime, work } = fixture("confirmed");
    let invocations = 0;
    const result = await Effect.runPromise(
      runMegapotRewardsCycle({
        work,
        runtime: {
          ...runtime,
          observeSolvency: () =>
            Effect.sync(() => {
              calls.push("observe-solvency");
              invocations += 1;
            }).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  invocations === 1
                    ? Effect.fail(new Error("solvency rpc unavailable"))
                    : Effect.void,
                ),
              ),
            ),
        },
      }),
    );

    expect(result.drawingObservationFailed).toBe(false);
    expect(result.failures).toContain("MegapotRewardsCycleExpectedFailure");
    expect(result.paid).toBe(1);
    expect(result.refunded).toBe(1);
    expect(calls).toContain("close-expired");
  });
});

test("sponsor funding is observed last, one failure does not stop the rest, and the window rotates", async () => {
  const { calls, runtime, work } = fixture("confirmed");
  const result = await Effect.runPromise(
    runMegapotRewardsCycle({
      work: {
        ...work,
        loadPendingFunding: ({ limit, cursor }) =>
          Effect.sync(() => calls.push(`load-pending-funding:${limit}:${cursor}`)).pipe(
            Effect.as(["refused", "waiting", "confirmed"]),
          ),
      },
      runtime: {
        ...runtime,
        reconcileFunding: (fundingEffectId) =>
          Effect.sync(() => calls.push(`reconcile-funding:${fundingEffectId}`)).pipe(
            Effect.andThen(
              fundingEffectId === "refused"
                ? Effect.fail({ _tag: "RewardFundingCoordinatorFailed" })
                : Effect.succeed({
                    kind: fundingEffectId === "confirmed" ? "confirmed" : "confirming",
                  }),
            ),
          ),
      },
      // A large cycle limit must not widen the chain reads spent on funding.
      limit: 100,
      // Seven scheduled minutes in: the selection window has moved seven batches.
      now: () => 7 * 60_000,
    }),
  );
  expect(calls.slice(calls.indexOf("payout") + 1)).toEqual([
    "load-pending-funding:10:7",
    "reconcile-funding:refused",
    "reconcile-funding:waiting",
    "reconcile-funding:confirmed",
    "load-aged-pending",
  ]);
  expect(result).toMatchObject({ fundingObserved: 3, fundingConfirmed: 1, paid: 1 });
  expect(result).not.toHaveProperty("fundingDeferred");
  expect(result.failures).toEqual(["RewardFundingCoordinatorFailed"]);
});

test("slow funding observations stop at the time budget after every obligation has run", async () => {
  const { calls, runtime, work } = fixture("confirmed");
  let clock = 0;
  const result = await Effect.runPromise(
    runMegapotRewardsCycle({
      work: {
        ...work,
        loadPendingFunding: () => Effect.succeed(["slow-1", "slow-2", "slow-3", "slow-4"]),
      },
      runtime: {
        ...runtime,
        // Each observation uses six seconds of chain time and then fails.
        reconcileFunding: (fundingEffectId) =>
          Effect.sync(() => {
            calls.push(`reconcile-funding:${fundingEffectId}`);
            clock += 6_000;
          }).pipe(Effect.andThen(Effect.fail({ _tag: "RewardFundingCoordinatorFailed" }))),
      },
      now: () => clock,
    }),
  );
  const funding = calls.filter((call) => call.startsWith("reconcile-funding:"));
  expect(funding).toEqual(["reconcile-funding:slow-1", "reconcile-funding:slow-2"]);
  for (const obligation of ["close-expired", "refund", "payout"])
    expect(calls.indexOf(obligation)).toBeLessThan(calls.indexOf(funding[0] ?? ""));
  expect(calls.at(-1)).toBe("load-aged-pending");
  expect(result).toMatchObject({
    fundingObserved: 2,
    fundingDeferred: 2,
    terminalOffers: 1,
    refunded: 1,
    paid: 1,
  });
  expect(result).not.toHaveProperty("fundingConfirmed");
});

test("a cycle that is already late skips funding observation without a chain read", async () => {
  const { calls, runtime, work } = fixture("confirmed");
  let clock = 0;
  const result = await Effect.runPromise(
    runMegapotRewardsCycle({
      work,
      runtime: {
        ...runtime,
        // Payouts alone carry the cycle past the latest funding start.
        payout: () =>
          Effect.sync(() => {
            calls.push("payout");
            clock = 31_000;
            return { kind: "complete" };
          }),
      },
      now: () => clock,
    }),
  );
  expect(calls.some((call) => call.includes("funding"))).toBe(false);
  expect(calls.at(-1)).toBe("load-aged-pending");
  expect(result).not.toHaveProperty("fundingObserved");
});

test("setup that used most of the job leaves no room and funding is skipped", async () => {
  const { calls, runtime, work } = fixture("confirmed");
  const result = await Effect.runPromise(
    runMegapotRewardsCycle({
      work,
      runtime,
      // The runner's clock started 29 seconds before the cycle did.
      jobStartedAt: 1_000_000 - 29_000,
      now: () => 1_000_000,
    }),
  );
  expect(calls.some((call) => call.includes("funding"))).toBe(false);
  expect(result).toMatchObject({ paid: 1, refunded: 1, agedPending: [] });
  expect(result).not.toHaveProperty("fundingObserved");
});

const tightDeadlines = { budgetMs: 40, latestStartMs: 40, hardStopMs: 80, reportByMs: 120 };

test("a database statement that never returns is cut off and the cycle still reports", async () => {
  const { calls, runtime, work } = fixture("confirmed");
  const startedAt = Date.now();
  const result = await Effect.runPromise(
    runMegapotRewardsCycle({
      work: {
        ...work,
        loadPendingFunding: () => Effect.succeed(["hung", "after-hung"]),
      },
      runtime: {
        ...runtime,
        reconcileFunding: (fundingEffectId) =>
          Effect.sync(() => calls.push(`reconcile-funding:${fundingEffectId}`)).pipe(
            Effect.andThen(Effect.never),
          ),
      },
      fundingDeadlines: tightDeadlines,
    }),
  );
  expect(Date.now() - startedAt).toBeLessThan(2_000);
  expect(calls.filter((call) => call.startsWith("reconcile-funding:"))).toEqual([
    "reconcile-funding:hung",
  ]);
  expect(calls.at(-1)).toBe("load-aged-pending");
  expect(result).toMatchObject({ fundingObserved: 1, fundingDeferred: 1, paid: 1, refunded: 1 });
  expect(result.failures).toEqual(["MegapotRewardsFundingDeadlineExceeded"]);
  expect(result.agedPending).toEqual([]);
});

test("a funding listing that never returns is cut off without observing anything", async () => {
  const { calls, runtime, work } = fixture("confirmed");
  const result = await Effect.runPromise(
    runMegapotRewardsCycle({
      work: { ...work, loadPendingFunding: () => Effect.never },
      runtime,
      fundingDeadlines: tightDeadlines,
    }),
  );
  expect(calls.some((call) => call.startsWith("reconcile-funding:"))).toBe(false);
  expect(result.failures).toEqual(["MegapotRewardsFundingDeadlineExceeded"]);
  expect(result).toMatchObject({ paid: 1, agedPending: [] });
});

test("a liveness projection that never returns is reported unavailable, not lost", async () => {
  const { runtime, work } = fixture("confirmed");
  const startedAt = Date.now();
  const result = await Effect.runPromise(
    runMegapotRewardsCycle({
      work: { ...work, loadAgedPending: () => Effect.never },
      runtime,
      fundingDeadlines: tightDeadlines,
    }),
  );
  expect(Date.now() - startedAt).toBeLessThan(4_000);
  expect(result.agedPending).toBeNull();
  expect(result).toMatchObject({ fundingObserved: 1, fundingConfirmed: 1, paid: 1 });
});

test("a cycle past its reporting bound never starts the liveness read", async () => {
  const { calls, runtime, work } = fixture("confirmed");
  const startedAt = Date.now();
  const result = await Effect.runPromise(
    runMegapotRewardsCycle({
      work,
      runtime,
      // The runner's clock started 49 seconds before the cycle did.
      jobStartedAt: 1_000_000 - 49_000,
      now: () => 1_000_000,
    }),
  );
  expect(Date.now() - startedAt).toBeLessThan(500);
  expect(calls).not.toContain("load-aged-pending");
  expect(calls.some((call) => call.includes("funding"))).toBe(false);
  expect(result.agedPending).toBeNull();
  expect(result.paid).toBe(1);
});

test("a failed funding listing is recorded and liveness is still reported", async () => {
  const { calls, runtime, work } = fixture("confirmed");
  const result = await Effect.runPromise(
    runMegapotRewardsCycle({
      work: {
        ...work,
        loadPendingFunding: () =>
          Effect.fail(new MegapotWorkStorageFailed({ reason: "unavailable" })),
      },
      runtime,
      now: () => 0,
    }),
  );
  expect(result.failures).toEqual(["MegapotWorkStorageFailed"]);
  expect(result.paid).toBe(1);
  expect(calls.at(-1)).toBe("load-aged-pending");
});

test("a paused cycle records holds, keeps reconciling and does not report storage failures", async () => {
  const { runtime, work, calls } = fixture("confirmed");
  const hold = () => Effect.fail(new RewardOperationsPaused({ reason: "paused" }));
  const result = await Effect.runPromise(
    runMegapotRewardsCycle({
      work,
      runtime: {
        ...runtime,
        approve: hold,
        purchase: hold,
        claim: hold,
        refund: hold,
        payout: hold,
      },
    }),
  );
  expect(result.pausedHolds).toBeGreaterThan(0);
  expect(result.failures).toEqual([]);
  expect(result.failureDiagnostics).toEqual([]);
  expect(calls).toContain("reconcile");
});

test("a paused approval still runs proven-unsent purchase-window cleanup", async () => {
  const { runtime, work, calls } = fixture("confirmed");
  const result = await Effect.runPromise(
    runMegapotRewardsCycle({
      work,
      runtime: {
        ...runtime,
        approve: () => Effect.fail(new RewardOperationsPaused({ reason: "paused" })),
        closeUnavailablePurchase: () =>
          Effect.sync(() => calls.push("closed_purchase_unavailable")),
      },
    }),
  );
  expect(calls).toContain("closed_purchase_unavailable");
  expect(calls).not.toContain("purchase");
  expect(result.purchased).toBe(0);
  expect(result.pausedHolds).toBe(1);
  expect(result.failures).toEqual([]);
});
