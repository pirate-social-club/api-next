import { describe, expect, test } from "bun:test";
import type {
  HnsEdgeStatusSnapshotV1,
  HnsEdgeStatusStore,
} from "@pirate/application/use-cases/hns-edge-status";
import { AuthError, type HnsEdgeStatusReportV1 } from "@pirate/contracts";
import { Effect } from "effect";
import { hnsEdgeAlertBearerMatches } from "./hns-edge-alert-auth.ts";
import { makeHnsEdgeStatusHandlers } from "./hns-edge-status-handlers.ts";
import { makeHnsEdgeStatusComposition } from "./hns-edge-status-page.ts";
import { createHttpWorker } from "./transport.ts";

const now = 1_800_000_000;
const token = "a".repeat(48);

const report: HnsEdgeStatusReportV1 = {
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
        soa: 900_000,
        app_a: 900_000,
        app_tlsa: 900_000,
        wildcard_tlsa: 900_000,
      },
    },
    {
      view_id: "secondary",
      zone_serial: 2_026_080_805,
      rrsig_remaining_seconds: {
        dnskey: 900_000,
        soa: 900_000,
        app_a: 900_000,
        app_tlsa: 900_000,
        wildcard_tlsa: 900_000,
      },
    },
  ],
  app: {
    certificate_not_after_unix_seconds: now + 30 * 86_400,
    served_spki_sha256: "a".repeat(64),
    primary_tlsa_spki_sha256: "a".repeat(64),
    secondary_tlsa_spki_sha256: "a".repeat(64),
    http_status: 421,
  },
  failed_units: [],
};

function app(
  renewal: {
    delayed_job_count?: number;
    terminal_job_count?: number;
    serving_remaining_seconds?: number;
  } = {},
) {
  let snapshot: HnsEdgeStatusSnapshotV1 | null = null;
  const store: HnsEdgeStatusStore = {
    load: () => Effect.succeed(snapshot),
    save: (value) =>
      Effect.sync(() => {
        snapshot = value;
      }),
  };
  const composition = makeHnsEdgeStatusComposition(true, {
    access_validator: {
      verify: async (assertion) => {
        if (assertion !== "valid-access") throw new Error("denied");
      },
    },
    store,
    renewal_status_store: {
      load: () =>
        Effect.succeed({
          last_successful_tick_unix_seconds: now - 60,
          freshness_threshold_seconds: 7_200,
          active_root_count: 1,
          healthy_root_count: 1,
          delayed_job_count: 0,
          terminal_job_count: 0,
          earliest_serving_valid_until_unix_seconds: now + 3600,
          serving_remaining_seconds: 3600,
          earliest_health_valid_until_unix_seconds: now + 86_400,
          ...renewal,
        }),
    },
    clock: { nowUnixSeconds: () => now },
  });
  if (!composition.enabled) throw new Error("test composition disabled");
  return createHttpWorker({
    hnsEdgeStatus: composition,
    handlers: makeHnsEdgeStatusHandlers(composition),
    authenticate: async ({ endpoint, credentials }) => {
      if (
        endpoint.auth.policy.kind !== "sharedSecret" ||
        endpoint.auth.policy.name !== "hns-edge-status" ||
        !(await hnsEdgeAlertBearerMatches(credentials.authorization, token))
      ) {
        throw new AuthError({ message: "Authentication failed" });
      }
      return {
        kind: "device",
        subject: "hns-edge-status",
        scopes: ["hns-edge-status:deliver"],
      };
    },
    authorize: ({ endpoint, input }) => {
      if (
        endpoint.auth.policy.kind !== "sharedSecret" ||
        input.principal?.subject !== "hns-edge-status" ||
        input.principal.scopes?.includes("hns-edge-status:deliver") !== true
      ) {
        throw new AuthError({ message: "Authorization failed" });
      }
    },
  });
}

describe("HNS edge status HTTP surface", () => {
  test("accepts the typed heartbeat and renders edge plus renewal status", async () => {
    const worker = app();
    const published = await worker.request(
      new Request("https://worker.test/internal/hns-edge-status", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(report),
      }),
    );
    expect(published.status).toBe(202);
    expect(await published.json()).toEqual({
      accepted: true,
      observed_at_unix_seconds: now - 60,
    });

    const page = await worker.request(
      new Request("https://worker.test/admin/hns", {
        headers: { "cf-access-jwt-assertion": "valid-access" },
      }),
    );
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain("HNS needs attention");
    expect(html).toContain("Retained app HTTP");
    expect(html).toContain(">421<");
    expect(html).toContain("Health renewal scheduler");
    expect(html).toContain("Imported root health");
    expect(html).toContain("0 delayed · 0 terminal");
    expect(html).toContain("1.0 hours remaining");
    expect(html).not.toContain("email");
  });

  test("denies origin bypass and leaves a disabled route undiscoverable", async () => {
    expect((await app().request("https://worker.test/admin/hns")).status).toBe(401);
    expect(
      (
        await app().request(
          new Request("https://worker.test/admin/hns", {
            headers: { "cf-access-jwt-assertion": "invalid-access" },
          }),
        )
      ).status,
    ).toBe(401);
    expect((await createHttpWorker().request("https://worker.test/admin/hns")).status).toBe(404);
  });
});

for (const renewal of [
  { delayed_job_count: 1 },
  { terminal_job_count: 1 },
  { serving_remaining_seconds: 0 },
]) {
  test("a fresh heartbeat cannot hide renewal or serving validity failure", async () => {
    const worker = app(renewal);
    await worker.request(
      new Request("https://worker.test/internal/hns-edge-status", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...report, app: { ...report.app, http_status: 200 } }),
      }),
    );
    const response = await worker.request(
      new Request("https://worker.test/admin/hns", {
        headers: { "cf-access-jwt-assertion": "valid-access" },
      }),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("HNS needs attention");
    expect(html).toContain(
      `${renewal.delayed_job_count ?? 0} delayed · ${renewal.terminal_job_count ?? 0} terminal`,
    );
  });
}
