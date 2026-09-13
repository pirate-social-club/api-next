import { expect, test } from "bun:test";
import type { HnsRootResourceRecordV1 } from "@pirate/application/namespace-ownership";
import { preflightEncodeHnsResourceV1 } from "@pirate/application/namespace-ownership";
import { makeDirectPostgresControlPlaneLayer } from "@pirate/platform-cf/postgres";
import { Effect } from "effect";
import { Client } from "pg";
import { makeProductionHnsActivationCurrentView } from "./hns-activation-current-view-composition.ts";
import {
  activate,
  enabledConfiguration,
  expectUntouched,
  lifecycle,
  prepareReadyImport,
} from "./hns-community-activation.pg-fixture.ts";

/**
 * The connected activation matrix: the production gatherer factory, the real
 * HTTP handlers and the real PostgreSQL repository, with the HSD RPC and the
 * database as the only fixtures.
 */

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;

type ConnectionLifecycle = { acquired: number; released: number; live: number };

/**
 * A direct control-plane layer whose client factory counts acquisition and
 * release, so a test can prove the identity read's connection is returned
 * before the network read rather than only that no transaction is open.
 */
function instrumentedControlPlaneLayer(connectionString: string, lifecycle: ConnectionLifecycle) {
  return makeDirectPostgresControlPlaneLayer(connectionString, {
    clientFactory: async (_url, config) => {
      const client = new Client(config);
      lifecycle.acquired += 1;
      lifecycle.live += 1;
      let ended = false;
      return {
        connection: client.connection,
        connect: () => client.connect(),
        query: (input: { readonly text: string; readonly values?: readonly unknown[] }) =>
          client.query({
            text: input.text,
            values: input.values === undefined ? [] : [...input.values],
          }) as never,
        end: async () => {
          if (!ended) {
            ended = true;
            lifecycle.released += 1;
            lifecycle.live -= 1;
          }
          await client.end();
        },
      };
    },
  });
}

pgTest(
  "matching current authority activates through the production gatherer",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const connections: ConnectionLifecycle = { acquired: 0, released: 0, live: 0 };
    let liveAtFirstRequest = -1;
    const ready = await prepareReadyImport({
      connectionString: url,
      onRequest: async () => {
        if (liveAtFirstRequest === -1) liveAtFirstRequest = connections.live;
      },
    });
    try {
      ready.hsd.setRecords(ready.planRecords);
      const expectedWireDigest = (await preflightEncodeHnsResourceV1(ready.planRecords)).sha256;
      expect((await lifecycle(ready))?.plan_encoded_resource_sha256).toBe(expectedWireDigest);
      const response = await activate(
        ready,
        makeProductionHnsActivationCurrentView(
          instrumentedControlPlaneLayer(ready.scopedConnectionString, connections),
          enabledConfiguration(ready.hsd.url),
        ),
        "activate-match",
      );
      expect(response.status).toBe(201);
      // The identity read's connection is acquired and released before the
      // observer's first RPC, so no scope is held across the provider read.
      expect(connections.acquired).toBeGreaterThan(0);
      expect(connections.released).toBe(connections.acquired);
      expect(connections.live).toBe(0);
      expect(liveAtFirstRequest).toBe(0);
      expect(await lifecycle(ready)).toMatchObject({ phase: "activated", generation: "1" });
      const session = await ready.admin.query<{ status: string; revision: string }>(
        "SELECT status, revision FROM hns_root_import_sessions WHERE root_import_session_id=$1",
        [ready.sessionId],
      );
      expect(session.rows[0]).toEqual({
        status: "activated",
        revision: String(ready.revision + 1),
      });
      const operations = await ready.admin.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM hns_root_import_activation_operations WHERE root_import_session_id=$1",
        [ready.sessionId],
      );
      expect(operations.rows[0]?.count).toBe(1);
      const appHost = await ready.admin.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM hns_community_app_host_activation_current WHERE community_id=$1",
        [ready.community],
      );
      expect(appHost.rows[0]?.count).toBe(1);
      const community = await ready.admin.query<{ bound: boolean }>(
        "SELECT canonical_route_binding_id IS NOT NULL AS bound FROM communities WHERE community_id=$1",
        [ready.community],
      );
      expect(community.rows[0]?.bound).toBe(true);
    } finally {
      await ready.cleanup();
    }
  },
  240_000,
);

pgTest(
  "a completed activation replays through its durable receipt while observation fails",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const ready = await prepareReadyImport({ connectionString: url });
    try {
      ready.hsd.setRecords(ready.planRecords);
      const enabled = makeProductionHnsActivationCurrentView(
        ready.layer,
        enabledConfiguration(ready.hsd.url),
      );
      const first = await activate(ready, enabled, "activate-replay");
      expect(first.status).toBe(201);
      const original = (await first.json()) as Readonly<Record<string, unknown>>;
      // Identical retries under observation failure still return the durable
      // receipt: a completed request is not resolved by another chain read.
      for (const [failure, currentView] of [
        [
          "transport",
          makeProductionHnsActivationCurrentView(ready.layer, enabledConfiguration(ready.hsd.url)),
        ],
        [
          "resource_absent",
          makeProductionHnsActivationCurrentView(ready.layer, enabledConfiguration(ready.hsd.url)),
        ],
        ["disabled", makeProductionHnsActivationCurrentView(ready.layer, { enabled: false })],
      ] as const) {
        if (failure !== "disabled") ready.hsd.setFailure(failure);
        const retry = await activate(ready, currentView, "activate-replay");
        expect(retry.status).toBe(200);
        expect(await retry.json()).toMatchObject({
          ...original,
          replayed: true,
          root_import_session_id: ready.sessionId,
        });
      }
      // A changed request identity keeps its conflict behavior.
      ready.hsd.setFailure("ok");
      expect((await activate(ready, enabled, "activate-replay-other")).status).toBe(409);
      const operations = await ready.admin.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM hns_root_import_activation_operations WHERE root_import_session_id=$1",
        [ready.sessionId],
      );
      expect(operations.rows[0]?.count).toBe(1);
      const history = await ready.admin.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM hns_root_import_lifecycle_history WHERE root_import_session_id=$1 AND event_id LIKE 'activation:%'",
        [ready.sessionId],
      );
      expect(history.rows[0]?.count).toBe(1);
      const session = await ready.admin.query<{ status: string; revision: string }>(
        "SELECT status, revision FROM hns_root_import_sessions WHERE root_import_session_id=$1",
        [ready.sessionId],
      );
      expect(session.rows[0]).toEqual({
        status: "activated",
        revision: String(ready.revision + 1),
      });
      const appHost = await ready.admin.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM hns_community_app_host_activation_current WHERE community_id=$1",
        [ready.community],
      );
      expect(appHost.rows[0]?.count).toBe(1);
    } finally {
      await ready.cleanup();
    }
  },
  240_000,
);

pgTest(
  "conflicting records refuse activation and preserve protected state",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const ready = await prepareReadyImport({ connectionString: url });
    try {
      ready.hsd.setRecords([{ type: "TXT", txt: ["someone-elses-resource"] }]);
      const response = await activate(
        ready,
        makeProductionHnsActivationCurrentView(ready.layer, enabledConfiguration(ready.hsd.url)),
        "activate-conflict",
      );
      expect(response.status).toBe(409);
      await expectUntouched(ready);
      const refreshJobs = await ready.admin.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM hns_root_import_lifecycle_jobs WHERE root_import_session_id=$1 AND job_kind='observe_readiness' AND state IN ('queued','leased')",
        [ready.sessionId],
      );
      expect(refreshJobs.rows[0]?.count).toBe(0);
    } finally {
      await ready.cleanup();
    }
  },
  240_000,
);

pgTest(
  "resource absence refuses activation as a conflict",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const ready = await prepareReadyImport({ connectionString: url });
    try {
      ready.hsd.setFailure("resource_absent");
      const response = await activate(
        ready,
        makeProductionHnsActivationCurrentView(ready.layer, enabledConfiguration(ready.hsd.url)),
        "activate-absence",
      );
      expect(response.status).toBe(409);
      await expectUntouched(ready);
    } finally {
      await ready.cleanup();
    }
  },
  240_000,
);

pgTest(
  "provider failure refuses activation as an unavailable provider",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const ready = await prepareReadyImport({ connectionString: url });
    try {
      ready.hsd.setFailure("transport");
      // The production gatherer over the real database classifies the outage
      // before the handler surfaces it as a provider failure.
      expect(
        await Effect.runPromise(
          makeProductionHnsActivationCurrentView(
            ready.layer,
            enabledConfiguration(ready.hsd.url),
          )({ root_import_session_id: ready.sessionId, root_label: "harbor" }),
        ),
      ).toEqual({ kind: "unavailable", classification: "transport_failure" });
      const response = await activate(
        ready,
        makeProductionHnsActivationCurrentView(ready.layer, enabledConfiguration(ready.hsd.url)),
        "activate-provider",
      );
      expect(response.status).toBe(502);
      expect((await response.json()) as unknown).toMatchObject({
        error: { code: "provider_unavailable" },
      });
      await expectUntouched(ready);

      ready.hsd.setFailure("malformed");
      expect(
        await Effect.runPromise(
          makeProductionHnsActivationCurrentView(
            ready.layer,
            enabledConfiguration(ready.hsd.url),
          )({ root_import_session_id: ready.sessionId, root_label: "harbor" }),
        ),
      ).toEqual({ kind: "unavailable", classification: "malformed_response" });
      const malformed = await activate(
        ready,
        makeProductionHnsActivationCurrentView(ready.layer, enabledConfiguration(ready.hsd.url)),
        "activate-malformed",
      );
      expect(malformed.status).toBe(502);
      expect((await malformed.json()) as unknown).toMatchObject({
        error: { code: "provider_unavailable" },
      });
      await expectUntouched(ready);
    } finally {
      await ready.cleanup();
    }
  },
  240_000,
);

pgTest(
  "intentionally disabled observation refuses as an unavailable capability",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const ready = await prepareReadyImport({ connectionString: url });
    try {
      const response = await activate(
        ready,
        makeProductionHnsActivationCurrentView(ready.layer, { enabled: false }),
        "activate-disabled",
      );
      expect(response.status).toBe(502);
      expect(ready.hsd.calls).toHaveLength(0);
      await expectUntouched(ready);
    } finally {
      await ready.cleanup();
    }
  },
  240_000,
);

pgTest(
  "generation-bound digest selection activates against the adopted generation's digest",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const ready = await prepareReadyImport({ connectionString: url });
    try {
      // This fixture selects the digest directly on the lifecycle row; the
      // adoption writer itself, with fresh current, safe and readiness
      // evidence, is exercised by the joint ceremony.
      const adoptedRecords: readonly HnsRootResourceRecordV1[] = [
        { type: "TXT", txt: ["owner-shaped-adopted-resource"] },
      ];
      const adoptedDigest = (await preflightEncodeHnsResourceV1(adoptedRecords)).sha256;
      const before = await lifecycle(ready);
      await ready.admin.query(
        `UPDATE hns_root_import_lifecycle
          SET generation=generation+1, plan_encoded_resource_sha256=$1,
              readiness_observed_at=clock_timestamp()
        WHERE root_import_session_id=$2`,
        [adoptedDigest, ready.sessionId],
      );
      ready.hsd.setRecords(adoptedRecords);
      const response = await activate(
        ready,
        makeProductionHnsActivationCurrentView(ready.layer, enabledConfiguration(ready.hsd.url)),
        "activate-adopted",
      );
      expect(response.status).toBe(201);
      const after = await lifecycle(ready);
      expect(after).toMatchObject({ phase: "activated", generation: "2" });
      expect(after?.generation).toBe(String(Number(before?.generation ?? 0) + 1));
      const history = await ready.admin.query<{ generation: string }>(
        "SELECT generation FROM hns_root_import_lifecycle_history WHERE root_import_session_id=$1 AND event_id LIKE 'activation:%'",
        [ready.sessionId],
      );
      expect(history.rows[0]?.generation).toBe("2");
    } finally {
      await ready.cleanup();
    }
  },
  240_000,
);

pgTest(
  "a generation race refuses activation and preserves protected state",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    let raceAction: (() => Promise<void>) | null = null;
    const ready = await prepareReadyImport({
      connectionString: url,
      onRequest: async () => {
        if (raceAction === null) return;
        const action = raceAction;
        raceAction = null;
        await action();
      },
    });
    try {
      ready.hsd.setRecords(ready.planRecords);
      raceAction = async () => {
        await ready.admin.query(
          "UPDATE hns_root_import_lifecycle SET generation=generation+1 WHERE root_import_session_id=$1",
          [ready.sessionId],
        );
      };
      const response = await activate(
        ready,
        makeProductionHnsActivationCurrentView(ready.layer, enabledConfiguration(ready.hsd.url)),
        "activate-race",
      );
      expect(response.status).toBe(409);
      await expectUntouched(ready);
      expect(await lifecycle(ready)).toMatchObject({ phase: "ready", generation: "2" });
    } finally {
      await ready.cleanup();
    }
  },
  240_000,
);
