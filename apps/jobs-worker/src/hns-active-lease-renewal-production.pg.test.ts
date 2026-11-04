import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { AlertCollector } from "@pirate/application";
import {
  decodeHnsActiveLeaseRenewalRequestBytes,
  encodeHnsActiveLeaseRenewalResponse,
  encodeHnsControlObservationRequest,
  encodeHnsControlObserverConfiguration,
  type HnsControlObservationRequestV1,
  mapHnsActiveLeaseRenewalObservationForRequest,
} from "@pirate/application/namespace-ownership";
import {
  makeControlPlaneHnsActiveLeaseRenewalStore,
  readHnsActiveLeaseRenewalCandidates,
} from "@pirate/platform-cf/hns-active-lease-renewal-repository";
import { makeControlPlaneHnsHandlePersonaHostAuthoritySource } from "@pirate/platform-cf/hns-handle-host-authority-repository";
import { makeControlPlaneHnsCommunityAppHostAuthoritySource } from "@pirate/platform-cf/hns-host-persistence-repository";
import { Effect } from "effect";
import { attachmentObserverFixture } from "../../hns-owner-verifier/src/attachment-observer.fixture.ts";
import { handleRequest } from "../../hns-owner-verifier/src/index.ts";
import { makeProductionHnsActivationCurrentView } from "../../http-worker/src/hns-activation-current-view-composition.ts";
import {
  activate,
  enabledConfiguration,
  prepareReadyImport,
} from "../../http-worker/src/hns-community-activation.pg-fixture.ts";
import { claimImportedHnsHandle } from "../../http-worker/src/hns-community-claim.pg-fixture.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeHnsActiveLeaseRenewalJob } = await import(
  "../../jobs-worker/src/hns-active-lease-renewal.ts"
);
const { JobContext } = await import("../../jobs-worker/src/registry.ts");
const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;

for (const capabilityStatus of ["active", "suspended"] as const)
  pgTest(
    `the configured renewal tick renews an ordinary claimed import with ${capabilityStatus} capabilities`,
    async () => {
      if (!url) throw new Error("Postgres required");
      const configuration = {
        ...JSON.parse(
          await Bun.file(
            new URL(
              "../../hns-owner-verifier/ops/staging/observer-configuration-regtest.json",
              import.meta.url,
            ),
          ).text(),
        ),
        provider_configuration_reference: "hns-owner-staging",
      };
      const configurationBytes = await encodeHnsControlObserverConfiguration(configuration);
      const digest = createHash("sha256").update(configurationBytes).digest("hex");
      const observer = attachmentObserverFixture("verified");
      const policy = { ...observer.configuration.lease_policy, evidence_lease_seconds: 3600 };
      const ready = await prepareReadyImport({
        connectionString: url,
        verifier: () => (request, env, ports) => {
          if (ports?.targetObserver === undefined) throw new Error("Expected import observer");
          return handleRequest(
            request,
            { ...env, HNS_EVIDENCE_TTL_SECONDS: "3600" },
            {
              ...ports,
              targetObserver: {
                ...ports.targetObserver,
                configuration: {
                  ...ports.targetObserver.configuration,
                  provider_configuration_digest: digest,
                  lease_policy: policy,
                },
              },
            },
          );
        },
      });
      try {
        ready.hsd.setRecords(ready.planRecords);
        expect(
          (
            await activate(
              ready,
              makeProductionHnsActivationCurrentView(
                ready.layer,
                enabledConfiguration(ready.hsd.url),
              ),
              "renewal-activate",
            )
          ).status,
        ).toBe(201);
        const { buyer, persona, sales, run, claim } = await claimImportedHnsHandle(ready);
        await ready.admin.query(
          `INSERT INTO hns_control_observer_configurations (
        provider_configuration_reference,provider_configuration_version,provider_configuration_digest,configuration_bytes)
        VALUES ($1,$2,$3,$4)`,
          [
            configuration.provider_configuration_reference,
            configuration.provider_configuration_version,
            digest,
            configurationBytes,
          ],
        );
        const binding = (
          await ready.admin.query(
            `SELECT b.*, e.origin,
        (SELECT count(*)::int FROM community_route_hns_control_identities ci WHERE ci.evidence_ref=e.evidence_ref) AS control_identities
        FROM community_canonical_route_bindings b JOIN communities c ON c.canonical_route_binding_id=b.route_binding_id
        JOIN community_route_ownership_evidence e ON e.evidence_ref=b.verified_evidence_ref WHERE c.community_id=$1`,
            [ready.community],
          )
        ).rows[0];
        expect(binding).toMatchObject({
          ownership_status: "verified",
          route_lifecycle_status: "active",
          origin: "route_attachment",
          control_identities: 1,
        });
        if (capabilityStatus === "active") {
          await expect(
            ready.admin.query(
              `INSERT INTO community_route_hns_control_identities
            SELECT evidence_ref,ownership_source,root_label,txt_name,expected_txt_value_sha256,
                   repeat('9',64),chain_authority_digest,provider_evidence_ref
              FROM community_route_hns_control_identities WHERE evidence_ref=$1`,
              [binding.verified_evidence_ref],
            ),
          ).rejects.toMatchObject({
            code: "P0001",
            message: "HNS control identity does not match attachment evidence",
          });
          // Model an already activated pre-upgrade import that retained its
          // immutable observation but never copied the control identity.
          await ready.admin.query(
            "ALTER TABLE community_route_hns_control_identities DISABLE TRIGGER community_route_hns_control_identities_immutable",
          );
          try {
            await ready.admin.query(
              "DELETE FROM community_route_hns_control_identities WHERE evidence_ref=$1",
              [binding.verified_evidence_ref],
            );
          } finally {
            await ready.admin.query(
              "ALTER TABLE community_route_hns_control_identities ENABLE TRIGGER community_route_hns_control_identities_immutable",
            );
          }
          await ready.admin.query(
            await Bun.file(
              new URL(
                "../../../db/postgres/migrations/0238_hns_attachment_control_identity.sql",
                import.meta.url,
              ),
            ).text(),
          );
          expect(
            (
              await ready.admin.query(
                "SELECT count(*)::int AS identities FROM community_route_hns_control_identities WHERE evidence_ref=$1",
                [binding.verified_evidence_ref],
              )
            ).rows[0]?.identities,
          ).toBe(1);
        }
        const store = makeControlPlaneHnsActiveLeaseRenewalStore(ready.layer);
        expect(
          await Effect.runPromise(store.resolve({ route_binding_id: binding.route_binding_id })),
        ).not.toBeNull();
        const appAuthority = makeControlPlaneHnsCommunityAppHostAuthoritySource(ready.layer);
        const memberAuthority = makeControlPlaneHnsHandlePersonaHostAuthoritySource(ready.layer);
        const app = await Effect.runPromise(appAuthority.resolve("app.harbor"));
        if (app === null || app.variant !== "community_app_v1")
          throw new Error("Expected activated app host");
        if (capabilityStatus === "suspended") {
          await ready.admin.query(
            "SELECT * FROM change_hns_community_app_host_status_v1($1,$2,$3,$4,$5,'suspended','owner_pause')",
            [
              "pause-app",
              "pause-app",
              "4".repeat(64),
              app.app_host_activation_id,
              app.app_host_activation_generation,
            ],
          );
          const sale = (
            await ready.admin.query(
              `SELECT revision.* FROM community_handle_sale_namespace_activation_revisions revision
          JOIN community_handle_sale_namespace_activation_current current USING (sale_namespace_activation_id)
          WHERE current.community_id=$1 AND revision.sale_namespace_activation_generation=current.current_generation`,
              [ready.community],
            )
          ).rows[0];
          await run(
            sales.reviseSaleNamespace({
              accountId: ready.actor,
              communityId: ready.community,
              activationId: sale.sale_namespace_activation_id,
              expectedActivationHash: sale.sale_namespace_activation_hash,
              requestedStatus: "suspended",
              namespaceAuthorityReference: sale.namespace_authority_reference,
              expectedNamespaceAuthorityGeneration: Number(sale.namespace_authority_generation),
              dnsZoneActivationId: sale.dns_zone_activation_id,
              expectedDnsZoneActivationGeneration: Number(sale.dns_zone_activation_generation),
              dedicatedRootReplacementConfirmed: true,
              idempotencyKey: "pause-sale",
            }),
          );
        }
        // Advance this disposable fixture into the renewal lead window. The
        // product operation must acquire fresh proof, rather than extend a timestamp.
        await ready.admin.query(
          "ALTER TABLE community_route_ownership_evidence DISABLE TRIGGER community_route_ownership_evidence_append_only",
        );
        try {
          await ready.admin.query(
            "UPDATE community_route_ownership_evidence SET expires_at=clock_timestamp()+interval '5 minutes' WHERE evidence_ref=$1",
            [binding.verified_evidence_ref],
          );
        } finally {
          await ready.admin.query(
            "ALTER TABLE community_route_ownership_evidence ENABLE TRIGGER community_route_ownership_evidence_append_only",
          );
        }
        const candidates = await Effect.runPromise(
          readHnsActiveLeaseRenewalCandidates({
            reference: configuration.provider_configuration_reference,
            version: configuration.provider_configuration_version,
            environment: "staging",
            leadSeconds: 900,
            limit: 1,
          }).pipe(Effect.provide(ready.layer)),
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.route_binding_id).toBe(binding.route_binding_id);
        const txt = ready.planRecords.find(
          (record) =>
            record.type === "TXT" &&
            Array.isArray(record.txt) &&
            record.txt.some(
              (value: unknown) =>
                typeof value === "string" && value.startsWith("pirate-verification="),
            ),
        );
        if (txt?.type !== "TXT" || !Array.isArray(txt.txt))
          throw new Error("Expected imported verification TXT");
        const expectedValue = txt.txt.join("");
        let providerCalls = 0;
        const alerts: string[] = [];
        const job = makeHnsActiveLeaseRenewalJob(
          {
            HNS_ACTIVE_LEASE_RENEWAL_ENABLED: "true",
            HNS_OWNERSHIP_ENABLED: "false",
            HNS_OWNERSHIP_CONFIGURATION_REFERENCE: configuration.provider_configuration_reference,
            HNS_OWNERSHIP_CONFIGURATION_VERSION: configuration.provider_configuration_version,
            HNS_ROUTE_RENEWAL_LEAD_SECONDS: "900",
            HNS_OWNER_VERIFIER: {
              fetch: async (input, init) => {
                providerCalls++;
                const request = new Request(String(input), init);
                expect(new URL(request.url).pathname).toBe(
                  "/internal/hns-owner/v1/active-lease-renewal",
                );
                const decoded = await decodeHnsActiveLeaseRenewalRequestBytes(
                  new Uint8Array(await request.arrayBuffer()),
                );
                expect(decoded.request).toMatchObject({
                  community_id: ready.community,
                  route_binding_id: binding.route_binding_id,
                  expected_binding_generation: 1,
                  expected_verified_evidence_ref: binding.verified_evidence_ref,
                });
                const identity = (
                  await ready.admin.query(
                    `SELECT ownership_source,txt_name,expected_txt_value_sha256,control_identity_digest,chain_authority_digest
            FROM community_route_hns_control_identities WHERE evidence_ref=$1`,
                    [decoded.request.expected_verified_evidence_ref],
                  )
                ).rows[0];
                const observationId = request.headers.get("Pirate-HNS-Observation-Id");
                if (observationId === null) throw new Error("Expected observation identifier");
                const observationRequest: HnsControlObservationRequestV1 = {
                  version: "pirate-hns-control-observation-request-v1",
                  observation_id: observationId,
                  provider_id: decoded.request.provider_id,
                  provider_configuration_reference:
                    decoded.request.provider_configuration.reference,
                  provider_configuration_version: decoded.request.provider_configuration.version,
                  provider_configuration_digest: digest,
                  environment: "staging",
                  ownership_source: identity.ownership_source,
                  root_label: "harbor",
                  txt_name: identity.txt_name,
                  expected_txt_value: expectedValue,
                };
                const result = await observer.observer.observe(
                  {
                    request: observationRequest,
                    request_bytes: await encodeHnsControlObservationRequest(observationRequest),
                    lease_policy: policy,
                  },
                  { deadline_ms: 12_000, signal: request.signal },
                );
                const response = await mapHnsActiveLeaseRenewalObservationForRequest({
                  request: decoded.request,
                  control_identity: { ...identity, expected_txt_value: expectedValue },
                  observer_request: observationRequest,
                  observer_result_bytes: result,
                  upstream_session_ref: expectedValue.slice("pirate-verification=".length),
                  policy,
                });
                const bytes = await encodeHnsActiveLeaseRenewalResponse(response);
                return new Response(
                  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                  { headers: { "content-type": "application/octet-stream" } },
                );
              },
            },
          },
          "staging",
          {},
        );
        if (!job) throw new Error("Expected configured renewal job");
        const tick = () =>
          Effect.runPromise(
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
                attemptId: "renewal-fixture",
                owner: "test-owner",
                lease: () => ({
                  expiresAt: Date.now() + 60_000,
                  generation: 1,
                  owner: "test-owner",
                }),
              }),
            ),
          );
        if (capabilityStatus === "active") {
          await ready.admin.query(`CREATE FUNCTION fail_renewal_sale() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'test renewal sale failure'; END $$`);
          await ready.admin.query(`CREATE TRIGGER fail_renewal_sale BEFORE INSERT ON community_handle_sale_namespace_activation_revisions
          FOR EACH ROW EXECUTE FUNCTION fail_renewal_sale()`);
          try {
            await expect(tick()).rejects.toMatchObject({
              _tag: "HnsActiveLeaseRenewalStorageFailed",
            });
            const rollback = (
              await ready.admin.query(
                `SELECT b.binding_generation,b.verified_evidence_ref,
            (SELECT current_generation FROM hns_community_app_host_activation_current WHERE community_id=$1) AS app_generation,
            (SELECT count(*)::int FROM community_route_ownership_evidence WHERE origin='active_lease_renewal') AS renewed_evidence
            FROM community_canonical_route_bindings b WHERE b.community_id=$1`,
                [ready.community],
              )
            ).rows[0];
            expect(rollback).toEqual({
              binding_generation: "1",
              verified_evidence_ref: binding.verified_evidence_ref,
              app_generation: "1",
              renewed_evidence: 0,
            });
          } finally {
            await ready.admin.query(
              "DROP TRIGGER fail_renewal_sale ON community_handle_sale_namespace_activation_revisions",
            );
            await ready.admin.query("DROP FUNCTION fail_renewal_sale()");
          }
          // Leave the fence untouched and wait for the maintained 16-second
          // attempt lease to expire before the next permitted tick.
          await Bun.sleep(16_100);
        }
        await tick();
        expect(alerts).toEqual([]);
        const after = (
          await ready.admin.query(
            `SELECT b.*,e.expires_at,e.origin FROM community_canonical_route_bindings b
        JOIN community_route_ownership_evidence e ON e.evidence_ref=b.verified_evidence_ref WHERE b.community_id=$1`,
            [ready.community],
          )
        ).rows[0];
        expect(after).toMatchObject({
          route_binding_id: binding.route_binding_id,
          binding_generation: "2",
          ownership_status: "verified",
          route_lifecycle_status: "active",
          origin: "active_lease_renewal",
        });
        expect(after.verified_evidence_ref).not.toBe(binding.verified_evidence_ref);
        expect(new Date(after.expires_at).getTime()).toBeGreaterThan(Date.now() + 900_000);
        expect(await Effect.runPromise(appAuthority.resolve("app.harbor"))).toMatchObject({
          route_authority_effective: true,
          app_host_activation_status: capabilityStatus,
          route_binding_current: capabilityStatus === "active",
        });
        expect(
          await Effect.runPromise(memberAuthority.resolve("journeytest.harbor")),
        ).toMatchObject({
          namespace_authority_effective: true,
          handle_grant_active: capabilityStatus === "active",
          sale_namespace_activation_status: capabilityStatus,
          owner_persona_id: persona,
        });
        expect(
          await run(sales.getClaim({ accountId: buyer, claimId: claim.claim.claim_id })),
        ).toEqual(claim.claim);
        const calls = providerCalls;
        await tick();
        expect(providerCalls).toBe(calls);
        expect(calls).toBe(capabilityStatus === "active" ? 2 : 1);
      } finally {
        await ready.cleanup();
      }
    },
    240_000,
  );
