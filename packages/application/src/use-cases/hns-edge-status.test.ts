import { describe, expect, test } from "bun:test";
import type { HnsEdgeStatusReportV1 } from "@pirate/contracts";
import { Effect } from "effect";
import {
  HnsEdgeStatusFailed,
  type HnsEdgeStatusSnapshotV1,
  type HnsEdgeStatusStore,
  makeHnsEdgeStatusService,
} from "./hns-edge-status.ts";

const now = 1_800_000_000;
const sha = (character: string) => character.repeat(64);

const report = (overrides: Partial<HnsEdgeStatusReportV1> = {}): HnsEdgeStatusReportV1 => ({
  version: "pirate-hns-edge-status-v1",
  observer_id: "pirate-hns-primary-vps-v1",
  root: "jazleeuw",
  observed_at_unix_seconds: now - 60,
  authority_views: [
    {
      view_id: "primary",
      zone_serial: 2_026_080_805,
      rrsig_remaining_seconds: {
        dnskey: 900_000,
        soa: 900_001,
        app_a: 900_002,
        app_tlsa: 900_003,
        wildcard_tlsa: 900_004,
      },
    },
    {
      view_id: "secondary",
      zone_serial: 2_026_080_805,
      rrsig_remaining_seconds: {
        dnskey: 900_000,
        soa: 900_001,
        app_a: 900_002,
        app_tlsa: 900_003,
        wildcard_tlsa: 900_004,
      },
    },
  ],
  app: {
    certificate_not_after_unix_seconds: now + 30 * 86_400,
    served_spki_sha256: sha("a"),
    primary_tlsa_spki_sha256: sha("a"),
    secondary_tlsa_spki_sha256: sha("a"),
    http_status: 200,
  },
  failed_units: [],
  ...overrides,
});

const memoryStore = (initial: HnsEdgeStatusSnapshotV1 | null = null) => {
  let current = initial;
  let saves = 0;
  const store: HnsEdgeStatusStore = {
    load: () => Effect.succeed(current),
    save: (snapshot) =>
      Effect.sync(() => {
        current = snapshot;
        saves += 1;
      }),
  };
  return { store, snapshot: () => current, saves: () => saves };
};

describe("HNS edge status service", () => {
  test("stores a fresh exact report and idempotently accepts its replay", async () => {
    const memory = memoryStore();
    const service = makeHnsEdgeStatusService({
      store: memory.store,
      clock: { nowUnixSeconds: () => now },
    });

    await expect(Effect.runPromise(service.publish(report()))).resolves.toEqual({
      accepted: true,
      observed_at_unix_seconds: now - 60,
    });
    await expect(Effect.runPromise(service.publish(report()))).resolves.toEqual({
      accepted: true,
      observed_at_unix_seconds: now - 60,
    });
    expect(memory.saves()).toBe(1);
    expect(memory.snapshot()?.received_at_unix_seconds).toBe(now);
  });

  test("refuses stale, conflicting, future, and non-canonical reports", async () => {
    const existing: HnsEdgeStatusSnapshotV1 = {
      version: "pirate-hns-edge-status-v1",
      received_at_unix_seconds: now - 30,
      report: report(),
    };
    const memory = memoryStore(existing);
    const service = makeHnsEdgeStatusService({
      store: memory.store,
      clock: { nowUnixSeconds: () => now },
    });
    const reason = async (candidate: HnsEdgeStatusReportV1) => {
      try {
        await Effect.runPromise(service.publish(candidate));
        return "accepted";
      } catch (error) {
        return error instanceof HnsEdgeStatusFailed ? error.reason : "unexpected";
      }
    };

    expect(await reason(report({ observed_at_unix_seconds: now - 61 }))).toBe("stale-report");
    expect(await reason(report({ app: { ...report().app, http_status: 421 } }))).toBe(
      "conflicting-report",
    );
    expect(await reason(report({ observed_at_unix_seconds: now + 301 }))).toBe("invalid-report");
    expect(await reason(report({ failed_units: ["z.service", "a.service"] }))).toBe(
      "invalid-report",
    );
    expect(memory.saves()).toBe(0);
  });

  test("derives health instead of trusting asserted booleans", async () => {
    const healthyStore = memoryStore({
      version: "pirate-hns-edge-status-v1",
      received_at_unix_seconds: now,
      report: report(),
    });
    const healthy = await Effect.runPromise(
      makeHnsEdgeStatusService({
        store: healthyStore.store,
        clock: { nowUnixSeconds: () => now },
      }).read(),
    );
    expect(healthy).toMatchObject({
      state: "healthy",
      heartbeat_fresh: true,
      rrsig_healthy: true,
      authority_serials_agree: true,
      spki_matches_tlsa: true,
      app_http_status: 200,
    });

    const attentionStore = memoryStore({
      version: "pirate-hns-edge-status-v1",
      received_at_unix_seconds: now,
      report: report({
        app: { ...report().app, http_status: 421, secondary_tlsa_spki_sha256: sha("b") },
      }),
    });
    const attention = await Effect.runPromise(
      makeHnsEdgeStatusService({
        store: attentionStore.store,
        clock: { nowUnixSeconds: () => now },
      }).read(),
    );
    expect(attention).toMatchObject({
      state: "attention",
      spki_matches_tlsa: false,
      app_http_status: 421,
    });
  });
});
