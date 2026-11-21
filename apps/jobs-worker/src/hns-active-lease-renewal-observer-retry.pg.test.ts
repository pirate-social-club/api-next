import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { AlertCollector } from "@pirate/application";
import {
  encodeHnsControlObserverConfiguration,
  HnsControlObserverHsdTransportError,
} from "@pirate/application/namespace-ownership";
import { makeControlPlaneCommunityRouteExpiryStore } from "@pirate/platform-cf/community-route-expiry-repository";
import {
  makeControlPlaneHnsControlObserverConfigurationResolver,
  makeControlPlaneHnsControlObserverSnapshotReader,
  makeControlPlaneHnsControlObserverSnapshotStore,
} from "@pirate/platform-cf/namespace-ownership-hns-control-observer-postgres";
import { Effect, Exit } from "effect";
import { handleRequest } from "../../hns-owner-verifier/src/index.ts";
import { makeHnsParentChainTargetObserverRuntime } from "../../hns-owner-verifier/src/target-observer-runtime.ts";
import { makeProductionHnsActivationCurrentView } from "../../http-worker/src/hns-activation-current-view-composition.ts";
import {
  activate,
  enabledConfiguration,
  prepareReadyImport,
} from "../../http-worker/src/hns-community-activation.pg-fixture.ts";
import { makeProductionHnsOwnerRecoveryHandlers } from "../../http-worker/src/hns-owner-recovery-production-composition.ts";
import { createHttpWorker } from "../../http-worker/src/transport.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeHnsActiveLeaseRenewalJob } = await import("./hns-active-lease-renewal.ts");
const { JobContext } = await import("./registry.ts");

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;

const genesis = "2".repeat(64);
const anchor = "3".repeat(64);
const configurationReference = "hns-owner-staging";
const configurationVersion = "hns-owner-config-v1";
const snapshotStoreReference = "postgres:hns-control-observer-v1";

function modelledHsd() {
  const state = {
    records: [] as unknown[],
    exchanges: 0,
    failNext: false,
    height: 123_456,
  };
  const encoder = new TextEncoder();
  const transport = {
    exchange: async (input: { method: string; request_bytes: Uint8Array }) => {
      state.exchanges += 1;
      if (state.failNext) {
        state.failNext = false;
        throw new HnsControlObserverHsdTransportError("timeout");
      }
      const now = Math.floor(Date.now() / 1_000);
      let result: unknown;
      if (input.method === "getblockchaininfo") {
        result = {
          chain: "regtest",
          blocks: state.height,
          headers: state.height,
          bestblockhash: anchor,
          mediantime: now - 60,
          verificationprogress: 1,
        };
      } else if (input.method === "getblockheader") {
        const body = JSON.parse(new TextDecoder().decode(input.request_bytes)) as {
          params: [string, boolean];
        };
        result =
          body.params[0] === genesis
            ? { hash: genesis, height: 0 }
            : {
                hash: body.params[0],
                height: state.height,
                time: now - 30,
                mediantime: now - 60,
                confirmations: 1,
              };
      } else if (input.method === "getnameinfo") {
        result = {
          info: {
            state: "CLOSED",
            registered: true,
            expired: false,
            stats: { renewalPeriodEnd: 200_000, blocksUntilExpire: 200_000 - state.height },
          },
        };
      } else if (input.method === "getnameresource") {
        result = { records: state.records };
      }
      return {
        status: 200,
        content_type: "application/json",
        response_bytes: encoder.encode(JSON.stringify({ result, error: null, id: null })),
      };
    },
  };
  return { state, transport };
}

pgTest(
  "a renewal tick after a finalized unavailable observation reads the chain again",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const ready = await prepareReadyImport({ connectionString: url });
    try {
      ready.hsd.setRecords(ready.planRecords);
      const activated = await activate(
        ready,
        makeProductionHnsActivationCurrentView(ready.layer, enabledConfiguration(ready.hsd.url)),
        "renewal-retry-activate",
      );
      expect(activated.status).toBe(201);
      const configuration = {
        version: "pirate-hns-control-observer-configuration-v1",
        provider_id: "hns.owner.v1",
        provider_configuration_reference: configurationReference,
        provider_configuration_version: configurationVersion,
        environment: "staging",
        ownership_sources: ["hns_parent_chain_txt"],
        chain: {
          driver_reference: "hsd-json-rpc:regtest-primary",
          network: "regtest",
          genesis_block_hash: genesis,
          minimum_verification_progress_millionths: 999_000,
          maximum_tip_age_seconds: 3_600,
          maximum_future_tip_seconds: 7_200,
          expected_block_interval_seconds: 600,
          minimum_safe_remaining_blocks: 144,
          expiry_safety_blocks: 144,
          response_max_bytes: 1_048_576,
        },
        authoritative_dns: null,
        evidence_lease_seconds: 3_600,
        observer_deadline_ms: 12_000,
        observer_reservation_lease_seconds: 15,
        snapshot_store_reference: snapshotStoreReference,
      } as const;
      const bytes = await encodeHnsControlObserverConfiguration(configuration);
      const digest = createHash("sha256").update(bytes).digest("hex");
      await ready.admin.query(
        `INSERT INTO hns_control_observer_configurations (
           provider_configuration_reference, provider_configuration_version,
           provider_configuration_digest, configuration_bytes
         ) VALUES ($1,$2,$3,$4)`,
        [configurationReference, configurationVersion, digest, bytes],
      );
      const setEvidenceExpiry = async (sql: string) => {
        await ready.admin.query(
          "ALTER TABLE community_route_ownership_evidence DISABLE TRIGGER community_route_ownership_evidence_append_only",
        );
        try {
          await ready.admin.query(
            `UPDATE community_route_ownership_evidence SET ${sql}
              WHERE evidence_ref = (
                SELECT binding.verified_evidence_ref
                  FROM community_canonical_route_bindings binding
                  JOIN communities community
                    ON community.canonical_route_binding_id = binding.route_binding_id
                 WHERE community.community_id = $1
              )`,
            [ready.community],
          );
        } finally {
          await ready.admin.query(
            "ALTER TABLE community_route_ownership_evidence ENABLE TRIGGER community_route_ownership_evidence_append_only",
          );
        }
      };
      await setEvidenceExpiry(
        "verified_at = clock_timestamp() - interval '1 hour', expires_at = clock_timestamp() - interval '1 second'",
      );
      expect(
        await Effect.runPromise(
          makeControlPlaneCommunityRouteExpiryStore(ready.layer).expire({
            family: "hns",
            limit: 1,
            principal_id: "test-expiry",
          }),
        ),
      ).toMatchObject({ transitioned: 1 });

      // One real observer runtime serves both recovery and renewal: the
      // Postgres snapshot store finalizes and replays observations by id,
      // and renewal reads its prior snapshot back through the reader.
      const hsd = modelledHsd();
      const runtime = await makeHnsParentChainTargetObserverRuntime(
        {
          authority: {
            provider_id: "hns.owner.v1",
            provider_configuration_reference: configurationReference,
            provider_configuration_version: configurationVersion,
            provider_configuration_digest: digest,
            environment: "staging",
            ownership_source: "hns_parent_chain_txt",
          } as never,
          capabilities: {
            provider_id: "hns.owner.v1",
            environment: "staging",
            chain_driver_reference: "hsd-json-rpc:regtest-primary",
            authoritative_dns_driver_reference: null,
            snapshot_store_reference: snapshotStoreReference,
          },
          configuration_resolver: makeControlPlaneHnsControlObserverConfigurationResolver(
            ready.layer,
          ),
          snapshot_store: makeControlPlaneHnsControlObserverSnapshotStore(ready.layer),
          hsd_transport: hsd.transport as never,
        },
        { deadline_ms: 12_000, signal: new AbortController().signal },
      );
      const targetObserver = {
        ...runtime,
        snapshot_reader: makeControlPlaneHnsControlObserverSnapshotReader(ready.layer),
      };
      const verifierEnvironment = {
        HNS_OWNERSHIP_SOURCE: "hns_parent_chain_txt",
        HNS_CHALLENGE_TTL_SECONDS: "3600",
        HNS_EVIDENCE_TTL_SECONDS: "3600",
        HNS_PROVIDER_ENVIRONMENT: "staging",
        HNS_PROVIDER_CONFIGURATION_REFERENCE: configurationReference,
        HNS_PROVIDER_CONFIGURATION_VERSION: configurationVersion,
      };
      const verifier = {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          handleRequest(new Request(String(input), init), verifierEnvironment as never, {
            targetObserver,
          }),
      };

      // Recover the route through the real observer, so its verified
      // evidence names a snapshot the renewal verifier can read back.
      const app = createHttpWorker({
        config: { corsOrigin: "https://worker.test" },
        handlers: makeProductionHnsOwnerRecoveryHandlers({
          enabled: true,
          environment: "staging",
          database: ready.layer,
          verifier,
        }),
        authenticate: () => ({ kind: "user", subject: ready.actor }),
        authorize: () => {},
      });
      const recovery = (command: "start" | "poll", body: unknown) =>
        app.request(
          `https://worker.test/communities/${ready.community}/canonical-route/ownership-recovery/${command}`,
          {
            method: "POST",
            headers: {
              cookie: "__Host-pirate_session=test-account; __Host-pirate_csrf=test-csrf",
              origin: "https://worker.test",
              "x-csrf-token": "test-csrf",
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          },
        );
      const started = await recovery("start", {
        expected_generation: 2,
        idempotency_key: "renewal-retry-recover-start",
      });
      expect(started.status).toBe(201);
      const session = (await started.json()) as {
        route_recovery_id: string;
        session_id: string;
        challenge: { challenge_value: string };
      };
      hsd.state.records = [{ type: "TXT", txt: [session.challenge.challenge_value] }];
      const recovered = await recovery("poll", {
        route_recovery_id: session.route_recovery_id,
        session_id: session.session_id,
        expected_generation: 2,
        idempotency_key: "renewal-retry-recover-poll",
        channel: "poll_result",
      });
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ status: "verified", generation: 3 });

      // Bring the recovered evidence into the renewal lead window.
      await setEvidenceExpiry("expires_at = clock_timestamp() + interval '5 minutes'");
      const recoveredBinding = (
        await ready.admin.query(
          `SELECT b.route_binding_id, b.binding_generation::text AS binding_generation,
                  b.verified_evidence_ref
             FROM community_canonical_route_bindings b
             JOIN communities c ON c.canonical_route_binding_id = b.route_binding_id
            WHERE c.community_id = $1`,
          [ready.community],
        )
      ).rows[0];
      expect(recoveredBinding).toMatchObject({ binding_generation: "3" });

      const alerts: string[] = [];
      const job = makeHnsActiveLeaseRenewalJob(
        {
          HNS_ACTIVE_LEASE_RENEWAL_ENABLED: "true",
          HNS_OWNERSHIP_ENABLED: "false",
          HNS_OWNERSHIP_CONFIGURATION_REFERENCE: configurationReference,
          HNS_OWNERSHIP_CONFIGURATION_VERSION: configurationVersion,
          HNS_ROUTE_RENEWAL_LEAD_SECONDS: "900",
          HNS_OWNER_VERIFIER: verifier,
        },
        "staging",
        {},
      );
      if (!job) throw new Error("Expected configured renewal job");
      const tick = async () => {
        const before = hsd.state.exchanges;
        const exit = await Effect.runPromiseExit(
          job.run.pipe(
            Effect.provide(ready.layer),
            Effect.provideService(AlertCollector, {
              emit: (alert) =>
                Effect.sync(() => {
                  alerts.push(alert.key);
                }),
            }),
            Effect.provideService(JobContext, {
              adapterSafety: { isProven: () => false, markAbortedOrFenced: () => undefined },
              attemptId: "renewal-retry-fixture",
              owner: "test-owner",
              lease: () => ({ expiresAt: Date.now() + 60_000, generation: 1, owner: "test-owner" }),
            }),
          ),
        );
        return { exit, chainCalls: hsd.state.exchanges - before };
      };
      const attemptRows = async () =>
        (
          await ready.admin.query(
            `SELECT attempt_number, state, fence_token::text AS fence_token, observation_id
               FROM community_route_active_lease_renewal_attempts
              WHERE route_binding_id = $1 AND expected_binding_generation = 3`,
            [recoveredBinding.route_binding_id],
          )
        ).rows;

      // Tick 1: one hsd RPC fails, the observer finalizes an unavailable
      // observation, and the operation releases its attempt at fence 1.
      hsd.state.failNext = true;
      const first = await tick();
      expect(first.chainCalls).toBeGreaterThan(0);
      expect(Exit.isFailure(first.exit)).toBe(true);
      expect(JSON.stringify(first.exit)).toContain("HnsActiveLeaseRenewalProviderFailed");
      const [released] = await attemptRows();
      expect(released).toMatchObject({ attempt_number: 1, state: "released", fence_token: "1" });

      // Tick 2: the chain is healthy. The same key reacquires the same
      // durable attempt at fence 2, and it must read the chain again rather
      // than replay the observation finalized for fence 1.
      hsd.state.height += 1;
      const second = await tick();
      expect(second.chainCalls).toBeGreaterThan(0);
      expect(Exit.isSuccess(second.exit)).toBe(true);
      const attempts = await attemptRows();
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        attempt_number: 1,
        state: "consumed",
        fence_token: "2",
        observation_id: released?.observation_id,
      });
      const renewed = (
        await ready.admin.query(
          `SELECT b.binding_generation::text AS binding_generation, b.ownership_status,
                  b.route_lifecycle_status, e.origin
             FROM community_canonical_route_bindings b
             JOIN community_route_ownership_evidence e ON e.evidence_ref = b.verified_evidence_ref
            WHERE b.route_binding_id = $1`,
          [recoveredBinding.route_binding_id],
        )
      ).rows[0];
      expect(renewed).toEqual({
        binding_generation: "4",
        ownership_status: "verified",
        route_lifecycle_status: "active",
        origin: "active_lease_renewal",
      });

      // Tick 3: the renewed evidence is outside the lead window, so nothing
      // is reacquired and the chain is not read.
      const third = await tick();
      expect(Exit.isSuccess(third.exit)).toBe(true);
      expect(third.chainCalls).toBe(0);
      expect(alerts).toEqual([]);
    } finally {
      await ready.cleanup();
    }
  },
  120_000,
);
