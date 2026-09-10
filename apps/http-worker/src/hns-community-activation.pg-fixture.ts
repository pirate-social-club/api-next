import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import type { HnsRootResourceRecordV1 } from "@pirate/application/namespace-ownership";
import {
  completeRouteAttachmentOwnership,
  continueHnsCommunityPublication,
  startRouteAttachmentOwnership,
} from "@pirate/application/namespace-ownership";
import { Effect, Redacted } from "effect";
import { Client } from "pg";
import { makeHnsCommunityPublicationQueue } from "../../../packages/platform-cf/src/hns-community-publication-queue.ts";
import { makeControlPlaneHnsCommunityRootImportStartStore } from "../../../packages/platform-cf/src/hns-community-root-import-repository.ts";
import { makeHnsOwnerServiceBindingTransport } from "../../../packages/platform-cf/src/namespace-ownership/hns-owner-service-binding.ts";
import { makePlatformNamespaceOwnershipProviderRegistry } from "../../../packages/platform-cf/src/namespace-ownership/provider-registry.ts";
import { makeDirectPostgresControlPlaneLayer } from "../../../packages/platform-cf/src/postgres.ts";
import { makeControlPlaneRouteAttachmentCompletionStore } from "../../../packages/platform-cf/src/route-attachment-completion-repository.ts";
import {
  makeControlPlaneRouteAttachmentOwnershipStartAuthorityResolver,
  makeControlPlaneRouteAttachmentOwnershipStartStore,
} from "../../../packages/platform-cf/src/route-attachment-start-repository.ts";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { runHnsAuthorityProvisionExecutorOnce } from "../../hns-authority-provisioner/src/executor.ts";
import { makePostgresHnsRootObservationQueue } from "../../hns-authority-provisioner/src/observation-queue.ts";
import type { HnsAuthorityZoneResult } from "../../hns-authority-provisioner/src/provision-root.ts";
import { makePostgresHnsAuthorityProvisionQueue } from "../../hns-authority-provisioner/src/queue.ts";
import { attachmentObserverFixture } from "../../hns-owner-verifier/src/attachment-observer.fixture.ts";
import { handleRequest } from "../../hns-owner-verifier/src/index.ts";
import { makeHnsCommunityRootImportHandlers } from "./hns-community-root-import-handlers.ts";
import {
  type HnsRootResourceRpcFixture,
  startHnsRootResourceRpcFixture,
} from "./hns-root-resource-rpc.fixture.ts";
import { createHttpWorker } from "./transport.ts";

/**
 * The connected activation fixture: real HTTP handlers, real PostgreSQL
 * repository and the real provisioning/legacy-readiness executables, with the
 * HSD RPC server and the database as the only fixtures. The lifecycle row is
 * brought to ready the way the repository suite's activation fixture already
 * documents, because the readiness handover that makes the lifecycle performer
 * live is a later deliverable.
 */

export type ReadyImport = Readonly<{
  readonly admin: Client;
  readonly connectionString: string;
  readonly layer: ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
  readonly hsd: HnsRootResourceRpcFixture;
  readonly actor: string;
  readonly community: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly publishPlanSha256: string;
  readonly readinessResultSha256: string;
  readonly planRecords: readonly HnsRootResourceRecordV1[];
  readonly services: Parameters<typeof makeHnsCommunityRootImportHandlers>[0];
  cleanup: () => Promise<void>;
}>;

export function enabledConfiguration(rpcUrl: string) {
  return {
    enabled: true,
    HNS_AUTHORITY_HSD_RPC_URL: rpcUrl,
    HNS_AUTHORITY_HSD_AUTHORIZATION: Redacted.make("Basic fixture"),
    HNS_AUTHORITY_CHAIN_NETWORK: "regtest",
    HNS_AUTHORITY_CHAIN_GENESIS_BLOCK_HASH: `${"0".repeat(63)}1`,
    HNS_AUTHORITY_TREE_INTERVAL_BLOCKS: 36,
    HNS_AUTHORITY_SAFE_CONFIRMATIONS: 12,
    HNS_AUTHORITY_MAXIMUM_TIP_AGE_SECONDS: 86_400,
    HNS_AUTHORITY_MAXIMUM_FUTURE_TIP_SECONDS: 3_600,
  } as const;
}

export async function prepareReadyImport(input: {
  readonly connectionString: string;
  readonly schema?: string;
  readonly onRequest?: () => Promise<void>;
}): Promise<ReadyImport> {
  const schema = input.schema ?? `hns_activation_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: input.connectionString });
  await admin.connect();
  const hsd = startHnsRootResourceRpcFixture(
    input.onRequest === undefined ? {} : { onRequest: input.onRequest },
  );
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    hsd.stop();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const connection = `${input.connectionString}${input.connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    await applyPostgresTestBaselineConnection({ connectionString: connection });
    await admin.query(`SET search_path TO "${schema}"`);
    const actor = "hns-owner";
    const community = `community_${randomUUID()}`;
    await admin.query("INSERT INTO users(user_id,status,account) VALUES($1,'active','{}')", [
      actor,
    ]);
    await admin.query(
      "INSERT INTO communities(community_id,display_name,status,created_by_user_id,route_authority_version,created_at,updated_at) VALUES($1,'HNS activation test','active',$2,'optional_route_v2',clock_timestamp(),clock_timestamp())",
      [community, actor],
    );
    await admin.query(
      "INSERT INTO community_route_authority_grants(grant_id,community_id,principal_user_id,authority,source_kind,status,granted_at,granted_by_user_id) VALUES('grant',$1,$2,'manage_routes','creator_owner','active',clock_timestamp(),$2)",
      [community, actor],
    );
    const layer = makeDirectPostgresControlPlaneLayer(connection);
    const configuration = {
      kind: "managed" as const,
      reference: "hns-owner-staging",
      version: "hns-owner-config-v1",
    };
    let chain: "pending" | "verified" = "pending";
    const observations: string[] = [];
    const transport = makeHnsOwnerServiceBindingTransport({
      fetch: async (input, init) => {
        const request = new Request(String(input), init);
        const observation = request.headers.get("Pirate-HNS-Observation-Id");
        if (observation) observations.push(observation);
        return handleRequest(
          request,
          {
            HNS_OWNERSHIP_SOURCE: "hns_parent_chain_txt",
            HNS_CHALLENGE_TTL_SECONDS: "3600",
            HNS_EVIDENCE_TTL_SECONDS: "2592000",
            HNS_PROVIDER_ENVIRONMENT: "staging",
            HNS_PROVIDER_CONFIGURATION_REFERENCE: configuration.reference,
            HNS_PROVIDER_CONFIGURATION_VERSION: configuration.version,
          },
          { targetObserver: attachmentObserverFixture(chain) },
        );
      },
    });
    const registry = await Effect.runPromise(
      makePlatformNamespaceOwnershipProviderRegistry({
        hns: {
          enabled: true,
          transport,
          provider_configuration: configuration,
          environments: ["staging"],
          target_observation_contract: "v2",
        },
      }),
    );
    const store = makeControlPlaneHnsCommunityRootImportStartStore(layer, {
      session_ttl_seconds: 604_800,
      environment: "staging",
      provider_binding: {
        requirement: "namespace_ownership",
        family: "hns",
        provider_id: "hns.owner.v1",
        provider_configuration: configuration,
        protocol_version: "hns-txt-v1",
      },
    });
    const queue = makeHnsCommunityPublicationQueue(layer);
    const services = {
      store,
      publicationQueue: queue,
      ownership: {
        start: (input: Parameters<typeof startRouteAttachmentOwnership>[0]) =>
          startRouteAttachmentOwnership(input, {
            intents: makeControlPlaneRouteAttachmentOwnershipStartAuthorityResolver(layer),
            registry,
            store: makeControlPlaneRouteAttachmentOwnershipStartStore(layer),
            environment: "staging",
          }),
      },
      completion: {
        complete: (input: Parameters<typeof completeRouteAttachmentOwnership>[0]) =>
          completeRouteAttachmentOwnership(input, {
            registry,
            store: makeControlPlaneRouteAttachmentCompletionStore(layer),
          }),
      },
      nameProof: { verify: () => Effect.die("No browser wallet proof expected") },
    };
    const app = createHttpWorker({
      handlers: makeHnsCommunityRootImportHandlers(services),
      authenticate: () => ({ kind: "user", subject: actor }),
      authorize: () => {},
    });
    const base = `https://worker.test/communities/${community}/hns-root-imports`;
    const call = (path: string, body?: unknown) =>
      app.request(path, {
        headers: { authorization: "test-account", "content-type": "application/json" },
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      });
    const start = await call(base, { root_label: "harbor", idempotency_key: "start" });
    expect(start.status).toBe(202);
    const starting = (await start.json()) as { readonly root_import_session_id: string };
    const sessionUrl = `${base}/${starting.root_import_session_id}`;
    const zone = new TextEncoder().encode("managed-zone");
    const hash = await crypto.subtle.digest("SHA-256", zone);
    const digest = Buffer.from(hash).toString("hex");
    const zoneResult: HnsAuthorityZoneResult = {
      created: true,
      dnssec: true,
      serial: 1,
      ds_records: [
        { key_tag: 1, algorithm: 13, digest_type: 2, digest: "a".repeat(64) },
        { key_tag: 1, algorithm: 13, digest_type: 4, digest: "b".repeat(96) },
      ],
      managed_rrset_sha256: digest,
      managed_zone_bytes: zone,
      shared_tlsa_profile_sha256: "d".repeat(64),
      gateway_ipv4: "192.0.2.10",
      gateway_deployment_reference: "gateway-v1",
      gateway_certificate_spki_sha256: "e".repeat(64),
      ttl_seconds: 300,
    };
    const observedCurrent = (records: readonly unknown[] = []) => ({
      kind: "observed" as const,
      observation: {
        view: "current" as const,
        network: "main",
        genesis_block_hash: `${"0".repeat(63)}1`,
        anchor: {
          network: "main",
          genesis_block_hash: `${"0".repeat(63)}1`,
          height: 812_345,
          best_block_hash: "aa".repeat(32),
          median_time_past_epoch_seconds: 1_770_000_000,
          header_time_epoch_seconds: 1_770_000_030,
          confirmations: 1,
        },
        tip_height: 812_345,
        update_inclusion_height: 800_000,
        commitment: null,
        observed_at_epoch_ms: 1_770_000_060_000,
        records: structuredClone(records) as never,
        resource_sha256: "1".repeat(64),
      },
    });
    const prepared = await runHnsAuthorityProvisionExecutorOnce({
      executor_id: "test-executor",
      queue: makePostgresHnsAuthorityProvisionQueue(connection),
      provision: {
        observe_current_resource: async () => observedCurrent(),
        ensure_zone: async () => zoneResult,
      },
    });
    expect(prepared.outcome).toBe("completed");
    const readyPlan = (await (await call(sessionUrl)).json()) as {
      status: string;
      revision: number;
      publish_plan: { replacement_records: HnsRootResourceRecordV1[] };
    };
    expect(readyPlan.status).toBe("awaiting_owner_update");
    const acknowledgement = {
      expected_revision: readyPlan.revision,
      idempotency_key: "published",
    };
    expect((await call(`${sessionUrl}/poll`, acknowledgement)).status).toBe(202);
    for (let pending = 0; pending < 5; pending++) {
      expect(await Effect.runPromise(continueHnsCommunityPublication(services, queue))).toBe(true);
      expect(((await (await call(sessionUrl)).json()) as { status: string }).status).toBe(
        "awaiting_owner_update",
      );
      await admin.query(
        "UPDATE hns_community_publication_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'",
      );
    }
    chain = "verified";
    expect(await Effect.runPromise(continueHnsCommunityPublication(services, queue))).toBe(true);
    const authorityView = (ordinal: 1 | 2) => ({
      authority_nameserver: `ns${ordinal}.pirate`,
      authority_address_family: "GLUE4" as const,
      authority_address: `192.0.2.${52 + ordinal}`,
      dnssec_validation: "secure" as const,
      challenge_present: true as const,
      validated_dnskey_response_sha256: String(ordinal).repeat(64),
      validated_control_response_sha256: String(ordinal + 2).repeat(64),
      validated_chain_authority_digest: "5".repeat(64),
      observed_zone_bytes: zone,
      observed_zone_sha256: digest,
    });
    const readinessExecutor = await runHnsAuthorityProvisionExecutorOnce({
      executor_id: "readiness-executor",
      queue: makePostgresHnsAuthorityProvisionQueue(connection),
      provision: {
        observe_current_resource: async () =>
          observedCurrent(readyPlan.publish_plan.replacement_records),
        ensure_zone: async () => zoneResult,
      },
      observation: {
        queue: makePostgresHnsRootObservationQueue(connection),
        observe: {
          observe_current_resource: async () =>
            observedCurrent(readyPlan.publish_plan.replacement_records),
          reconcile_zone: async () => {},
          inspect_zone: async () => ({ ...zoneResult, created: false }),
          observe_live: async () => ({
            authority_views: [authorityView(1), authorityView(2)],
            gateway: {
              normalized_host: "app.harbor",
              gateway_address: zoneResult.gateway_ipv4,
              certificate_spki_sha256: zoneResult.gateway_certificate_spki_sha256,
              http_status: 421 as const,
            },
          }),
        },
        teardown_zone: async () => {
          throw new Error("No teardown expected");
        },
        config: { environment: "staging", valid_for_seconds: 3600 },
      },
    });
    expect(readinessExecutor.outcome).toBe("ready");
    // The harness drives the legacy readiness writer, which persists the
    // session result; the lifecycle row is brought to the state the
    // production readiness performer would have produced. The handover that
    // makes that performer live is a later deliverable.
    await admin.query(
      `UPDATE hns_root_import_lifecycle
          SET phase='ready', readiness_observed_at=clock_timestamp()
        WHERE root_import_session_id=$1`,
      [starting.root_import_session_id],
    );
    const activatable = (await (await call(sessionUrl)).json()) as {
      status: string;
      revision: number;
      publish_plan_sha256: string;
      readiness_result_sha256: string;
    };
    expect(activatable.status).toBe("ready");
    return {
      admin,
      connectionString: input.connectionString,
      layer,
      hsd,
      actor,
      community,
      sessionId: starting.root_import_session_id,
      revision: activatable.revision,
      publishPlanSha256: activatable.publish_plan_sha256,
      readinessResultSha256: activatable.readiness_result_sha256,
      planRecords: readyPlan.publish_plan.replacement_records,
      services,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function activate(ready: ReadyImport, currentView: unknown, idempotencyKey: string) {
  const app = createHttpWorker({
    handlers: makeHnsCommunityRootImportHandlers({
      ...ready.services,
      currentView: currentView as never,
    }),
    authenticate: () => ({ kind: "user", subject: ready.actor }),
    authorize: () => {},
  });
  return app.request(
    `https://worker.test/communities/${ready.community}/hns-root-imports/${ready.sessionId}/activate`,
    {
      method: "POST",
      headers: { authorization: "test-account", "content-type": "application/json" },
      body: JSON.stringify({
        expected_revision: ready.revision,
        idempotency_key: idempotencyKey,
        publish_plan_sha256: ready.publishPlanSha256,
        readiness_result_sha256: ready.readinessResultSha256,
        acknowledged_complete_resource_replacement: true,
      }),
    },
  );
}

export async function lifecycle(ready: ReadyImport) {
  const result = await ready.admin.query<{
    phase: string;
    revision: string;
    generation: string;
    plan_encoded_resource_sha256: string | null;
  }>(
    "SELECT phase, revision, generation, plan_encoded_resource_sha256 FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
    [ready.sessionId],
  );
  return result.rows[0];
}

export async function expectUntouched(ready: ReadyImport) {
  expect(await lifecycle(ready)).toMatchObject({ phase: "ready" });
  const session = await ready.admin.query<{ status: string; revision: string }>(
    "SELECT status, revision FROM hns_root_import_sessions WHERE root_import_session_id=$1",
    [ready.sessionId],
  );
  expect(session.rows[0]).toEqual({
    status: "ready",
    revision: String(ready.revision),
  });
  const operations = await ready.admin.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM hns_root_import_activation_operations WHERE root_import_session_id=$1",
    [ready.sessionId],
  );
  expect(operations.rows[0]?.count).toBe(0);
  const activationHistory = await ready.admin.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM hns_root_import_lifecycle_history WHERE root_import_session_id=$1 AND event_id LIKE 'activation:%'",
    [ready.sessionId],
  );
  expect(activationHistory.rows[0]?.count).toBe(0);
}
