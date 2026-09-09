import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { HnsRootResourceRecordV1 } from "@pirate/application/namespace-ownership";
import {
  completeRouteAttachmentOwnership,
  continueHnsCommunityPublication,
  startRouteAttachmentOwnership,
} from "@pirate/application/namespace-ownership";
import { Effect } from "effect";
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
import { createHttpWorker } from "./transport.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;
pgTest.each(["complete", "revoked", "expired", "limited"] as const)(
  "real handlers and durable publication continuation: %s",
  async (scenario) => {
    const schema = `hns_continuation_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const connection = `${url}${url?.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    try {
      await applyPostgresTestBaselineConnection({ connectionString: connection });
      await admin.query(`SET search_path TO "${schema}"`);
      const actor = "hns-owner",
        community = "community_123e4567-e89b-42d3-a456-426614174000";
      await admin.query("INSERT INTO users(user_id,status,account) VALUES($1,'active','{}')", [
        actor,
      ]);
      await admin.query(
        "INSERT INTO communities(community_id,display_name,status,created_by_user_id,route_authority_version,created_at,updated_at) VALUES($1,'HNS test','active',$2,'optional_route_v2',clock_timestamp(),clock_timestamp())",
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
              HNS_CHALLENGE_TTL_SECONDS: scenario === "expired" ? "60" : "3600",
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
      if (scenario === "limited") {
        for (let n = 0; n < 3; n++) {
          const target = `community_${randomUUID()}`;
          await admin.query(
            "INSERT INTO communities(community_id,display_name,status,created_by_user_id,route_authority_version,created_at,updated_at) VALUES($1,'Quota fixture','active',$2,'optional_route_v2',clock_timestamp(),clock_timestamp())",
            [target, actor],
          );
          await admin.query(
            "INSERT INTO community_route_authority_grants(grant_id,community_id,principal_user_id,authority,source_kind,status,granted_at,granted_by_user_id) VALUES($1,$2,$3,'manage_routes','creator_owner','active',clock_timestamp(),$3)",
            [`quota-grant-${n}`, target, actor],
          );
          expect(
            (
              await Effect.runPromise(
                store.prepare({
                  request: {
                    actor_id: actor,
                    community_id: target,
                    root_label: `quota${n}`,
                    idempotency_key: `quota-${n}`,
                  },
                  attachment_intent_id: `quota-attachment-${n}`,
                  ceremony_intent_id: `quota-ceremony-${n}`,
                  root_import_session_id: `quota-import-${n}`,
                  provision_job_id: `quota-provision-${n}`,
                  request_sha256: "a".repeat(64),
                }),
              )
            ).kind,
          ).toBe("created");
        }
        const body = { root_label: "harbor", idempotency_key: "retry-after-limit" };
        const limited = await call(base, body);
        expect(limited.status).toBe(429);
        const rejection = (await limited.json()) as {
          error: { code: string; details: { retry_after_seconds: number } };
        };
        expect(rejection.error.code).toBe("rate_limited");
        const retryAfter = rejection.error.details.retry_after_seconds;
        expect(retryAfter).toBeGreaterThan(86_390);
        expect(retryAfter).toBeLessThanOrEqual(86_400);
        expect(limited.headers.get("retry-after")).toBe(String(retryAfter));
        expect(observations).toEqual([]);
        await admin.query(
          "ALTER TABLE hns_community_root_import_preparations DISABLE TRIGGER hns_community_root_import_preparations_change_guard",
        );
        try {
          await admin.query(
            "UPDATE hns_community_root_import_preparations SET created_at=clock_timestamp()-interval '25 hours' WHERE root_import_session_id='quota-import-0'",
          );
        } finally {
          await admin.query(
            "ALTER TABLE hns_community_root_import_preparations ENABLE TRIGGER hns_community_root_import_preparations_change_guard",
          );
        }
        expect((await call(base, body)).status).toBe(202);
        expect((await call(base, body)).status).toBe(200);
        return;
      }
      const start = await call(base, { root_label: "harbor", idempotency_key: "start" });
      expect(start.status).toBe(202);
      const starting = (await start.json()) as {
        root_import_session_id: string;
        revision: number;
        status: string;
      };
      expect(starting.status).toBe("provisioning");
      const sessionUrl = `${base}/${starting.root_import_session_id}`;
      expect((await call(sessionUrl)).status).toBe(200);
      expect(await Effect.runPromise(queue.claim())).toBeNull();
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
      const prepared = await runHnsAuthorityProvisionExecutorOnce({
        executor_id: "test-executor",
        queue: makePostgresHnsAuthorityProvisionQueue(connection),
        provision: {
          inspect_current_resource: async () => [],
          ensure_zone: async () => zoneResult,
        },
      });
      expect(prepared.outcome).toBe("completed");
      const ready = (await (await call(sessionUrl)).json()) as {
        status: string;
        revision: number;
        publish_plan: { replacement_records: HnsRootResourceRecordV1[] };
      };
      expect(ready.status).toBe("awaiting_owner_update");
      expect(ready.revision).toBeGreaterThan(starting.revision);
      expect(ready.publish_plan).not.toBeNull();
      expect(observations).toHaveLength(0);
      expect(
        (
          await call(`${sessionUrl}/poll`, {
            expected_revision: starting.revision,
            idempotency_key: "stale",
          })
        ).status,
      ).toBe(409);
      expect(await Effect.runPromise(queue.claim())).toBeNull();
      const acknowledgement = { expected_revision: ready.revision, idempotency_key: "published" };
      expect((await call(`${sessionUrl}/poll`, acknowledgement)).status).toBe(202);
      expect((await call(`${sessionUrl}/poll`, acknowledgement)).status).toBe(202);
      expect(observations).toHaveLength(0);
      expect(
        ((await (await call(sessionUrl)).json()) as { publication_check_pending: boolean })
          .publication_check_pending,
      ).toBe(true);
      if (scenario === "expired") {
        // Exercise database time without bypassing immutable session guards.
        await new Promise((resolve) => setTimeout(resolve, 61_000));
        expect(await Effect.runPromise(continueHnsCommunityPublication(services, queue))).toBe(
          true,
        );
        expect(
          (await admin.query("SELECT state,failure_code FROM hns_community_publication_jobs"))
            .rows[0],
        ).toEqual({ state: "failed", failure_code: "authority_or_expiry" });
        expect(observations).toHaveLength(0);
        expect(((await (await call(sessionUrl)).json()) as { status: string }).status).toBe(
          "expired",
        );
        const restartBody = { root_label: "harbor", idempotency_key: "restart" };
        // Expiry alone cannot free a provisioned zone or its admission slot.
        expect((await call(base, restartBody)).status).toBe(409);
        await admin.query(`UPDATE hns_authority_provision_jobs
          SET created_at=clock_timestamp()-interval '4 minutes',
              updated_at=clock_timestamp()-interval '3 minutes'`);
        const cleanup = (
          await admin.query(
            "SELECT * FROM claim_hns_root_import_observation_job_v1('expiry-cleanup',60)",
          )
        ).rows[0];
        expect(cleanup.operation_kind).toBe("teardown_provisional_root_v1");
        expect(
          (
            await admin.query(
              "SELECT * FROM finalize_hns_root_import_observation_job_v1($1,'expiry-cleanup',$2,$3,'failed',NULL,NULL,'session_expired')",
              [cleanup.observation_job_id, cleanup.lease_fence, cleanup.request_sha256],
            )
          ).rows[0].outcome,
        ).toBe("failed");
        expect(
          (
            await admin.query(
              "SELECT status,expires_at>clock_timestamp() AS unexpired FROM community_route_attachment_intents",
            )
          ).rows,
        ).toEqual([{ status: "verification_required", unexpired: true }]);
        // Production failure: the released child leaves a seven-day open parent.
        const restarted = await call(base, restartBody);
        expect(restarted.status).toBe(202);
        const replacement = (await restarted.json()) as { root_import_session_id: string };
        expect(replacement.root_import_session_id).not.toBe(starting.root_import_session_id);
        const replay = await call(base, restartBody);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({
          root_import_session_id: replacement.root_import_session_id,
        });
        expect(
          (await call(base, { ...restartBody, idempotency_key: "competing-restart" })).status,
        ).toBe(409);
        expect(
          (
            await admin.query(
              "SELECT status,count(*)::integer AS count FROM community_route_attachment_intents GROUP BY status ORDER BY status",
            )
          ).rows,
        ).toEqual([
          { status: "expired", count: 1 },
          { status: "verification_required", count: 1 },
        ]);
        expect(
          (
            await runHnsAuthorityProvisionExecutorOnce({
              executor_id: "replacement-executor",
              queue: makePostgresHnsAuthorityProvisionQueue(connection),
              provision: {
                inspect_current_resource: async () => [],
                ensure_zone: async () => zoneResult,
              },
            })
          ).outcome,
        ).toBe("completed");
        expect(
          await (await call(`${base}/${replacement.root_import_session_id}`)).json(),
        ).toMatchObject({
          status: "awaiting_owner_update",
          publish_plan: { replacement_records: expect.any(Array) },
        });
        return;
      }
      if (scenario === "revoked") {
        await admin.query(
          "UPDATE community_route_authority_grants SET status='revoked',revoked_at=clock_timestamp(),revoked_by_user_id=principal_user_id WHERE grant_id='grant'",
        );
        expect(await Effect.runPromise(continueHnsCommunityPublication(services, queue))).toBe(
          true,
        );
        expect(
          (await admin.query("SELECT state,failure_code FROM hns_community_publication_jobs"))
            .rows[0],
        ).toEqual({ state: "failed", failure_code: "authority_or_expiry" });
        expect(observations).toHaveLength(0);
        return;
      }
      for (let pending = 0; pending < 5; pending++) {
        expect(await Effect.runPromise(continueHnsCommunityPublication(services, queue))).toBe(
          true,
        );
        expect(((await (await call(sessionUrl)).json()) as { status: string }).status).toBe(
          "awaiting_owner_update",
        );
        await admin.query(
          "UPDATE hns_community_publication_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'",
        );
      }
      expect(observations).toHaveLength(5);
      expect(new Set(observations).size).toBe(5);
      expect(
        (
          await admin.query(
            "SELECT count(*)::integer AS count,max(fence_token)::integer AS fence FROM community_route_attachment_completion_attempts",
          )
        ).rows,
      ).toEqual([{ count: 1, fence: 5 }]);
      // A crashed scheduler lease resumes with a new fence; an old settlement cannot win.
      const old = await Effect.runPromise(queue.claim());
      expect(old).not.toBeNull();
      await admin.query(
        "UPDATE hns_community_publication_jobs SET lease_expires_at=clock_timestamp()-interval '1 second'",
      );
      const resumed = await Effect.runPromise(queue.claim());
      expect(resumed?.fence).toBe((old?.fence ?? 0) + 1);
      if (!old || !resumed) throw new Error("Missing lease");
      await Effect.runPromise(queue.settle(old, "failed", "stale_worker"));
      expect(
        (await admin.query("SELECT state FROM hns_community_publication_jobs")).rows[0].state,
      ).toBe("leased");
      await Effect.runPromise(queue.settle(resumed, "pending", null));
      await admin.query(
        "UPDATE hns_community_publication_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'",
      );
      chain = "verified";
      expect(await Effect.runPromise(continueHnsCommunityPublication(services, queue))).toBe(true);
      expect(((await (await call(sessionUrl)).json()) as { status: string }).status).toBe(
        "observing",
      );
      expect(
        (await admin.query("SELECT state FROM hns_community_publication_jobs")).rows[0].state,
      ).toBe("completed");
      expect(
        (
          await admin.query(
            "SELECT count(*)::integer AS count FROM hns_root_import_observation_jobs",
          )
        ).rows[0].count,
      ).toBe(1);
      expect(await Effect.runPromise(continueHnsCommunityPublication(services, queue))).toBe(false);
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
      const readiness = await runHnsAuthorityProvisionExecutorOnce({
        executor_id: "readiness-executor",
        queue: makePostgresHnsAuthorityProvisionQueue(connection),
        provision: {
          inspect_current_resource: async () => ready.publish_plan.replacement_records,
          ensure_zone: async () => zoneResult,
        },
        observation: {
          queue: makePostgresHnsRootObservationQueue(connection),
          observe: {
            inspect_current_resource: async () => ready.publish_plan.replacement_records,
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
      expect(readiness.outcome).toBe("ready");
      const activatable = (await (await call(sessionUrl)).json()) as {
        status: string;
        revision: number;
        publish_plan_sha256: string;
        readiness_result_sha256: string;
      };
      expect(activatable.status).toBe("ready");
      const activated = await call(`${sessionUrl}/activate`, {
        expected_revision: activatable.revision,
        idempotency_key: "activate",
        publish_plan_sha256: activatable.publish_plan_sha256,
        readiness_result_sha256: activatable.readiness_result_sha256,
        acknowledged_complete_resource_replacement: true,
      });
      expect(activated.status).toBe(201);
      expect(((await (await call(sessionUrl)).json()) as { status: string }).status).toBe(
        "activated",
      );
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
  120_000,
);
