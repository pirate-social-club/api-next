import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  encodeHnsControlObserverConfiguration,
  HnsControlObserverHsdTransportError,
} from "@pirate/application/namespace-ownership";
import { makeControlPlaneCommunityRouteExpiryStore } from "@pirate/platform-cf/community-route-expiry-repository";
import {
  makeControlPlaneHnsControlObserverConfigurationResolver,
  makeControlPlaneHnsControlObserverSnapshotStore,
} from "@pirate/platform-cf/namespace-ownership-hns-control-observer-postgres";
import { Effect } from "effect";
import { handleRequest } from "../../hns-owner-verifier/src/index.ts";
import { makeHnsParentChainTargetObserverRuntime } from "../../hns-owner-verifier/src/target-observer-runtime.ts";
import { makeProductionHnsActivationCurrentView } from "./hns-activation-current-view-composition.ts";
import {
  activate,
  enabledConfiguration,
  prepareReadyImport,
} from "./hns-community-activation.pg-fixture.ts";
import { makeProductionHnsOwnerRecoveryHandlers } from "./hns-owner-recovery-production-composition.ts";
import { createHttpWorker } from "./transport.ts";

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

const scenarios = [
  { name: "a pending first read", firstStatus: 202, firstBody: "pending", failFirstRead: false },
  {
    name: "an unavailable first read",
    firstStatus: 503,
    firstBody: "unavailable",
    failFirstRead: true,
  },
] as const;

for (const scenario of scenarios)
  pgTest(
    `a same-key retry observes the chain again after ${scenario.name}`,
    async () => {
      if (url === undefined) throw new Error("Postgres required");
      const ready = await prepareReadyImport({ connectionString: url });
      try {
        ready.hsd.setRecords(ready.planRecords);
        const activated = await activate(
          ready,
          makeProductionHnsActivationCurrentView(ready.layer, enabledConfiguration(ready.hsd.url)),
          "recovery-activate",
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
        await ready.admin.query(
          "ALTER TABLE community_route_ownership_evidence DISABLE TRIGGER community_route_ownership_evidence_append_only",
        );
        await ready.admin.query(
          `UPDATE community_route_ownership_evidence
              SET verified_at = clock_timestamp() - interval '1 hour',
                  expires_at = clock_timestamp() - interval '1 second'
            WHERE evidence_ref = (
              SELECT binding.verified_evidence_ref
                FROM community_canonical_route_bindings binding
                JOIN communities community
                  ON community.canonical_route_binding_id = binding.route_binding_id
               WHERE community.community_id = $1
            )`,
          [ready.community],
        );
        await ready.admin.query(
          "ALTER TABLE community_route_ownership_evidence ENABLE TRIGGER community_route_ownership_evidence_append_only",
        );
        const expired = await Effect.runPromise(
          makeControlPlaneCommunityRouteExpiryStore(ready.layer).expire({
            family: "hns",
            limit: 1,
            principal_id: "test-expiry",
          }),
        );
        expect(expired).toMatchObject({ transitioned: 1 });

        const hsd = modelledHsd();
        const targetObserver = await makeHnsParentChainTargetObserverRuntime(
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
        const verifierEnvironment = {
          HNS_OWNERSHIP_SOURCE: "hns_parent_chain_txt",
          HNS_CHALLENGE_TTL_SECONDS: "3600",
          HNS_EVIDENCE_TTL_SECONDS: "3600",
          HNS_PROVIDER_ENVIRONMENT: "staging",
          HNS_PROVIDER_CONFIGURATION_REFERENCE: configurationReference,
          HNS_PROVIDER_CONFIGURATION_VERSION: configurationVersion,
        };
        const app = createHttpWorker({
          config: { corsOrigin: "https://worker.test" },
          handlers: makeProductionHnsOwnerRecoveryHandlers({
            enabled: true,
            environment: "staging",
            database: ready.layer,
            verifier: {
              fetch: (input, init) =>
                handleRequest(new Request(String(input), init), verifierEnvironment as never, {
                  targetObserver,
                }),
            },
          }),
          authenticate: () => ({ kind: "user", subject: ready.actor }),
          authorize: () => {},
        });
        const request = (command: "start" | "poll", body: unknown) =>
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

        const started = await request("start", {
          expected_generation: 2,
          idempotency_key: "recover-start",
        });
        expect(started.status).toBe(201);
        const session = (await started.json()) as {
          route_recovery_id: string;
          session_id: string;
          challenge: { challenge_value: string };
        };
        const pollBody = {
          route_recovery_id: session.route_recovery_id,
          session_id: session.session_id,
          expected_generation: 2,
          idempotency_key: "same-key-after-a-retryable-answer",
          channel: "poll_result",
        };
        const poll = async () => {
          const before = hsd.state.exchanges;
          const response = await request("poll", pollBody);
          const body = (await response.json()) as { status?: string };
          return {
            http: response.status,
            status: body.status,
            chainCalls: hsd.state.exchanges - before,
          };
        };
        const attemptRows = async () =>
          (
            await ready.admin.query(
              `SELECT attempt_number, state, fence_token::text AS fence_token, observation_id
                 FROM community_route_revalidation_completion_attempts
                WHERE route_revalidation_id = $1`,
              [session.route_recovery_id],
            )
          ).rows;

        hsd.state.records = [{ type: "TXT", txt: ["pirate-verification=previous-value"] }];
        hsd.state.failNext = scenario.failFirstRead;
        const first = await poll();
        expect(first).toMatchObject({ http: scenario.firstStatus, status: scenario.firstBody });
        expect(first.chainCalls).toBeGreaterThan(0);
        const [released] = await attemptRows();
        expect(released).toMatchObject({ attempt_number: 1, state: "released", fence_token: "1" });

        hsd.state.records = [{ type: "TXT", txt: [session.challenge.challenge_value] }];
        hsd.state.height += 1;
        const second = await poll();
        expect(second).toMatchObject({ http: 200, status: "verified" });
        expect(second.chainCalls).toBeGreaterThan(0);
        const attempts = await attemptRows();
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          attempt_number: 1,
          state: "consumed",
          fence_token: "2",
          observation_id: released?.observation_id,
        });

        const replay = await poll();
        expect(replay).toEqual({ http: 200, status: "verified", chainCalls: 0 });
      } finally {
        await ready.cleanup();
      }
    },
    120_000,
  );
