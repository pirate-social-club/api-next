import { describe, expect, test } from "bun:test";
import type { AlertSink } from "@pirate/platform-cf";
import type { makeHyperdriveControlPlaneLayer } from "@pirate/platform-cf/postgres";
import { Effect } from "effect";
import { makeSpacesReconciliationJob } from "./spaces-reconciliation.ts";
import {
  makeSpacesReconciliationComposition,
  type SpacesReconciliationBindings,
} from "./spaces-reconciliation-composition.ts";

const runtime = {} as ReturnType<typeof makeHyperdriveControlPlaneLayer>;
const credentials: SpacesReconciliationBindings = {
  SPACES_RECONCILIATION_ENABLED: "true",
  SPACES_RECONCILIATION_OVERDUE_SECONDS: "259200",
  SPACES_RECONCILIATION_MEASUREMENT_REFERENCE: "yahoo-supervised-pilot-2026-09-26",
  SPACES_VERIFIER_ACCESS_CLIENT_ID: "test-access-id",
  SPACES_VERIFIER_ACCESS_CLIENT_SECRET: "test-access-secret",
  SPACES_VERIFIER_BEARER_TOKEN: "test-verifier-token",
};
const sink: AlertSink = {
  log: () => undefined,
  delivery: { markSent: () => Effect.succeed(true), compensate: () => Effect.void },
};

describe("Spaces reconciliation runtime composition", () => {
  test("does not register a job without the exact enable flag", () => {
    expect(makeSpacesReconciliationComposition({}, runtime, "staging")).toBeUndefined();
    expect(
      makeSpacesReconciliationComposition(
        { ...credentials, SPACES_RECONCILIATION_ENABLED: "false" },
        runtime,
        "staging",
      ),
    ).toBeUndefined();
  });

  test("rejects production and ambiguous enablement", () => {
    expect(() => makeSpacesReconciliationComposition(credentials, runtime, "production")).toThrow();
    expect(() =>
      makeSpacesReconciliationComposition(
        { ...credentials, SPACES_RECONCILIATION_ENABLED: "TRUE" },
        runtime,
        "staging",
      ),
    ).toThrow();
  });

  test("requires all verifier credentials and a bounded overdue policy", () => {
    const withoutBearer = { ...credentials };
    delete withoutBearer.SPACES_VERIFIER_BEARER_TOKEN;
    expect(() => makeSpacesReconciliationComposition(withoutBearer, runtime, "staging")).toThrow();
    const withoutThreshold = { ...credentials };
    delete withoutThreshold.SPACES_RECONCILIATION_OVERDUE_SECONDS;
    expect(() =>
      makeSpacesReconciliationComposition(withoutThreshold, runtime, "staging"),
    ).toThrow();
    for (const threshold of ["0", "259200x", "31536001"]) {
      expect(() =>
        makeSpacesReconciliationComposition(
          { ...credentials, SPACES_RECONCILIATION_OVERDUE_SECONDS: threshold },
          runtime,
          "staging",
        ),
      ).toThrow();
    }
    expect(() =>
      makeSpacesReconciliationComposition(
        { ...credentials, SPACES_RECONCILIATION_MEASUREMENT_REFERENCE: " " },
        runtime,
        "staging",
      ),
    ).toThrow();
  });

  test("registers only the existing bounded finality job when enabled", () => {
    const composition = makeSpacesReconciliationComposition(credentials, runtime, "staging");
    expect(composition).toBeDefined();
    expect(composition?.overdueThresholdSeconds).toBe(259_200);
    if (composition === undefined) throw new Error("expected enabled composition");
    const job = makeSpacesReconciliationJob(
      sink,
      composition.store,
      composition.verifier,
      composition,
    );
    expect(job.name).toBe("spaces-native.final-issuance");
    expect(job.requiresAdapterSafety).toBe(true);
  });
});
