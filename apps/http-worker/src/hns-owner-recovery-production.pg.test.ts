import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { encodeHnsControlObserverConfiguration } from "@pirate/application/namespace-ownership";
import {
  HandleRecipientTokenVault,
  IdGen,
  makeHandleSalesService,
} from "@pirate/application/use-cases/handles/sales";
import { makeControlPlaneCommunityRouteExpiryStore } from "@pirate/platform-cf/community-route-expiry-repository";
import { makeHandleRecipientTokenVault } from "@pirate/platform-cf/handle-recipient-token-vault";
import { makeControlPlaneHandleSalesStore } from "@pirate/platform-cf/handle-sales-repository";
import { makeControlPlaneHnsHandlePersonaHostAuthoritySource } from "@pirate/platform-cf/hns-handle-host-authority-repository";
import { makeControlPlaneHnsCommunityAppHostAuthoritySource } from "@pirate/platform-cf/hns-host-persistence-repository";
import { Effect } from "effect";
import {
  bindPersonaToCommunity,
  seedAccount,
  terms,
} from "../../../packages/platform-cf/src/handle-sales.pg-fixture.ts";
import { attachmentObserverFixture } from "../../hns-owner-verifier/src/attachment-observer.fixture.ts";
import { handleRequest } from "../../hns-owner-verifier/src/index.ts";
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

for (const capabilityStatus of ["active", "suspended"] as const)
  pgTest(
    `recovers an expired frontend import with ${capabilityStatus} capabilities through HTTP and the private verifier`,
    async () => {
      if (url === undefined) throw new Error("Postgres required");
      const ready = await prepareReadyImport({ connectionString: url });
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
              "recovery-activate",
            )
          ).status,
        ).toBe(201);
        const buyer = "member-account";
        const persona = await seedAccount(ready.admin, buyer, { humanEvidence: false });
        await bindPersonaToCommunity(ready.admin, {
          accountId: buyer,
          communityId: ready.community,
          personaId: persona,
        });
        const sales = makeHandleSalesService(makeControlPlaneHandleSalesStore(ready.layer));
        let sequence = 0;
        const vault = makeHandleRecipientTokenVault({
          hmacKeys: `h1:${Buffer.alloc(32, 21).toString("base64")}`,
          envelopeKeys: `e1:${Buffer.alloc(32, 22).toString("base64")}`,
        });
        const run = <A, E>(effect: Effect.Effect<A, E, IdGen | HandleRecipientTokenVault>) =>
          Effect.runPromise(
            effect.pipe(
              Effect.provideService(IdGen, {
                next: Effect.sync(() => `recovery-claim-${++sequence}`),
              }),
              Effect.provideService(HandleRecipientTokenVault, vault),
            ),
          );
        const activation = (
          await ready.admin.query(
            `SELECT sale_namespace_activation_id
      FROM community_handle_sale_namespace_activation_current WHERE community_id=$1`,
            [ready.community],
          )
        ).rows[0];
        const offering = await run(
          sales.createOffering({
            accountId: ready.actor,
            communityId: ready.community,
            idempotencyKey: "recovery-offering",
            terms: terms(activation.sale_namespace_activation_id),
          }),
        );
        await run(
          sales.confirmPersonaReuse({
            accountId: buyer,
            personaId: persona,
            offeringId: offering.offering.offering_id,
            idempotencyKey: "recovery-link",
          }),
        );
        const quote = await run(
          sales.createQuote({
            accountId: buyer,
            personaId: persona,
            offeringId: offering.offering.offering_id,
            desiredLabel: "journeytest",
            idempotencyKey: "recovery-quote",
          }),
        );
        if (quote.kind !== "quoted") throw new Error("claim must be quoted");
        const reservation = await run(
          sales.createReservation({
            accountId: buyer,
            personaId: persona,
            quoteId: quote.quote.quote_id,
            expectedQuoteHash: quote.quote.quote_hash,
            idempotencyKey: "recovery-reservation",
          }),
        );
        const claim = await run(
          sales.submitFreeClaim({
            accountId: buyer,
            personaId: persona,
            reservationId: reservation.reservation.reservation_id,
            expectedReservationHash: reservation.reservation.reservation_hash,
            idempotencyKey: "recovery-claim",
          }),
        );
        expect(claim.claim).toMatchObject({
          state: "issued",
          display_identifier: "journeytest.harbor",
          grant: { status: "active", owner_persona_id: persona },
        });
        const hostAuthority = makeControlPlaneHnsHandlePersonaHostAuthoritySource(ready.layer);
        const appAuthority = makeControlPlaneHnsCommunityAppHostAuthoritySource(ready.layer);
        const originalApp = await Effect.runPromise(appAuthority.resolve("app.harbor"));
        expect(originalApp).toMatchObject({
          route_binding_current: true,
          route_authority_effective: true,
          app_host_activation_status: "active",
        });
        expect(await Effect.runPromise(hostAuthority.resolve("journeytest.harbor"))).toMatchObject({
          namespace_authority_effective: true,
          handle_grant_active: true,
        });
        if (capabilityStatus === "suspended") {
          if (originalApp === null || originalApp.variant !== "community_app_v1")
            throw new Error("app authority missing");
          await ready.admin.query(
            "SELECT * FROM change_hns_community_app_host_status_v1($1,$2,$3,$4,$5,'suspended','owner_pause')",
            [
              "owner-pause",
              "owner-pause",
              "4".repeat(64),
              originalApp.app_host_activation_id,
              originalApp.app_host_activation_generation,
            ],
          );
          const current = (
            await ready.admin.query(
              `SELECT revision.* FROM community_handle_sale_namespace_activation_revisions revision
          JOIN community_handle_sale_namespace_activation_current current ON current.sale_namespace_activation_id=revision.sale_namespace_activation_id
          AND current.current_generation=revision.sale_namespace_activation_generation WHERE current.community_id=$1`,
              [ready.community],
            )
          ).rows[0];
          await run(
            sales.reviseSaleNamespace({
              accountId: ready.actor,
              communityId: ready.community,
              activationId: current.sale_namespace_activation_id,
              expectedActivationHash: current.sale_namespace_activation_hash,
              requestedStatus: "suspended",
              namespaceAuthorityReference: current.namespace_authority_reference,
              expectedNamespaceAuthorityGeneration: Number(current.namespace_authority_generation),
              dnsZoneActivationId: current.dns_zone_activation_id,
              expectedDnsZoneActivationGeneration: Number(current.dns_zone_activation_generation),
              dedicatedRootReplacementConfirmed: true,
              idempotencyKey: "owner-pause-sale",
            }),
          );
        }
        const configuration = {
          version: "pirate-hns-control-observer-configuration-v1",
          provider_id: "hns.owner.v1",
          provider_configuration_reference: "hns-owner-staging",
          provider_configuration_version: "hns-owner-config-v1",
          environment: "staging",
          ownership_sources: ["hns_parent_chain_txt"],
          chain: {
            driver_reference: "hsd-json-rpc:regtest-primary",
            network: "regtest",
            genesis_block_hash: "2".repeat(64),
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
          snapshot_store_reference: "postgres:hns-control-observer-v1",
        } as const;
        const bytes = await encodeHnsControlObserverConfiguration(configuration);
        const digest = createHash("sha256").update(bytes).digest("hex");
        await ready.admin.query(
          `INSERT INTO hns_control_observer_configurations (
      provider_configuration_reference,provider_configuration_version,
      provider_configuration_digest,configuration_bytes) VALUES ($1,$2,$3,$4)`,
          [
            configuration.provider_configuration_reference,
            configuration.provider_configuration_version,
            digest,
            bytes,
          ],
        );
        // Only the fixture clock is accelerated. The maintained database-time
        // expiry operation must record the suspension and its recovery authority.
        await ready.admin.query(
          "ALTER TABLE community_route_ownership_evidence DISABLE TRIGGER community_route_ownership_evidence_append_only",
        );
        try {
          await ready.admin.query(
            `UPDATE community_route_ownership_evidence
      SET verified_at=clock_timestamp()-interval '1 hour', expires_at=clock_timestamp()-interval '1 second'
      WHERE evidence_ref=(SELECT b.verified_evidence_ref FROM community_canonical_route_bindings b
        JOIN communities c ON c.canonical_route_binding_id=b.route_binding_id WHERE c.community_id=$1)`,
            [ready.community],
          );
        } finally {
          await ready.admin.query(
            "ALTER TABLE community_route_ownership_evidence ENABLE TRIGGER community_route_ownership_evidence_append_only",
          );
        }
        expect(
          await Effect.runPromise(
            makeControlPlaneCommunityRouteExpiryStore(ready.layer).expire({
              family: "hns",
              limit: 1,
              principal_id: "test-expiry",
            }),
          ),
        ).toMatchObject({ transitioned: 1 });
        const before = (
          await ready.admin.query(
            `SELECT b.* FROM community_canonical_route_bindings b
      JOIN communities c ON c.canonical_route_binding_id=b.route_binding_id WHERE c.community_id=$1`,
            [ready.community],
          )
        ).rows[0];
        expect(before).toMatchObject({
          route_lifecycle_status: "suspended",
          verified_evidence_ref: null,
          binding_generation: "2",
        });
        const discovery = await ready.call(`/communities/${ready.community}/hns-root-imports`);
        expect(discovery.status).toBe(200);
        expect(await discovery.json()).toMatchObject({
          attachment: { status: "suspended", binding_generation: 2 },
        });
        expect(await Effect.runPromise(hostAuthority.resolve("journeytest.harbor"))).toMatchObject({
          namespace_authority_effective: false,
          handle_grant_active: capabilityStatus === "active",
        });
        let actor = ready.actor;
        let calls = 0;
        let observations = 0;
        let unavailable = false;
        const observer = attachmentObserverFixture("verified", () => observations++);
        const targetObserver = {
          ...observer,
          configuration: {
            ...observer.configuration,
            provider_configuration_digest: digest,
            lease_policy: { ...observer.configuration.lease_policy, evidence_lease_seconds: 3_600 },
          },
        };
        const app = createHttpWorker({
          config: { corsOrigin: "https://worker.test" },
          handlers: makeProductionHnsOwnerRecoveryHandlers({
            enabled: true,
            environment: "staging",
            database: ready.layer,
            verifier: {
              fetch: async (input, init) => {
                calls++;
                if (unavailable) throw new Error("test verifier unavailable");
                return handleRequest(
                  new Request(String(input), init),
                  {
                    HNS_OWNERSHIP_SOURCE: "hns_parent_chain_txt",
                    HNS_CHALLENGE_TTL_SECONDS: "3600",
                    HNS_EVIDENCE_TTL_SECONDS: "3600",
                    HNS_PROVIDER_ENVIRONMENT: "staging",
                    HNS_PROVIDER_CONFIGURATION_REFERENCE: "hns-owner-staging",
                    HNS_PROVIDER_CONFIGURATION_VERSION: "hns-owner-config-v1",
                  },
                  { targetObserver },
                );
              },
            },
          }),
          authenticate: () => ({ kind: "user", subject: actor }),
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
        const start = { expected_generation: 2, idempotency_key: "recover-start" };
        actor = "another-owner";
        expect((await request("start", start)).status).toBe(404);
        expect(calls).toBe(0);
        actor = ready.actor;
        expect((await request("start", { ...start, expected_generation: 1 })).status).toBe(404);
        expect(calls).toBe(0);
        const first = await request("start", start);
        expect(first.status).toBe(201);
        const started = (await first.json()) as { route_recovery_id: string; session_id: string };
        const retry = await request("start", start);
        expect(retry.status).toBe(200);
        expect(await retry.json()).toMatchObject({ ...started, replayed: true });
        expect(calls).toBe(1);
        const poll = {
          route_recovery_id: started.route_recovery_id,
          session_id: started.session_id,
          expected_generation: 2,
          idempotency_key: "recover-poll",
          channel: "poll_result",
        };
        unavailable = true;
        const failedPoll = await request("poll", poll);
        expect(failedPoll.status).toBe(502);
        expect(await failedPoll.json()).toMatchObject({ error: { code: "provider_unavailable" } });
        expect(observations).toBe(0);
        unavailable = false;
        if (capabilityStatus === "active") {
          // Fail after evidence insertion and app refresh, at the sale writer.
          // Recovery must roll all three changes back, then allow a retry.
          await ready.admin.query(`CREATE FUNCTION fail_recovery_sale() RETURNS trigger LANGUAGE plpgsql AS
            $$ BEGIN RAISE EXCEPTION 'test recovery sale failure'; END $$`);
          await ready.admin.query(`CREATE TRIGGER fail_recovery_sale BEFORE INSERT ON
            community_handle_sale_namespace_activation_revisions FOR EACH ROW EXECUTE FUNCTION fail_recovery_sale()`);
          try {
            expect((await request("poll", poll)).status).toBe(500);
            const rolledBack = (
              await ready.admin.query(
                `SELECT b.binding_generation, b.verified_evidence_ref,
              (SELECT current_generation FROM hns_community_app_host_activation_current WHERE community_id=$1) AS app_generation,
              (SELECT current_generation FROM community_handle_sale_namespace_activation_current WHERE community_id=$1) AS sale_generation,
              (SELECT count(*)::int FROM community_route_ownership_evidence WHERE origin='owner_recovery') AS recovery_evidence
              FROM community_canonical_route_bindings b WHERE b.community_id=$1`,
                [ready.community],
              )
            ).rows[0];
            expect(rolledBack).toEqual({
              binding_generation: "2",
              verified_evidence_ref: null,
              app_generation: "1",
              sale_generation: "1",
              recovery_evidence: 0,
            });
          } finally {
            await ready.admin.query(
              "DROP TRIGGER fail_recovery_sale ON community_handle_sale_namespace_activation_revisions",
            );
            await ready.admin.query("DROP FUNCTION fail_recovery_sale()");
          }
        }
        const completed = await request("poll", poll);
        expect(completed.status).toBe(200);
        expect(await completed.json()).toMatchObject({ status: "verified", generation: 3 });
        expect((await request("poll", poll)).status).toBe(200);
        expect(observations).toBe(capabilityStatus === "active" ? 2 : 1);
        const after = (
          await ready.admin.query(
            `SELECT b.* FROM community_canonical_route_bindings b
      JOIN communities c ON c.canonical_route_binding_id=b.route_binding_id WHERE c.community_id=$1`,
            [ready.community],
          )
        ).rows[0];
        expect(after).toMatchObject({
          route_binding_id: before.route_binding_id,
          root_label: "harbor",
          binding_generation: "3",
          route_lifecycle_status: "active",
          ownership_status: "verified",
        });
        expect(after.verified_evidence_ref).not.toBeNull();
        expect(
          await (await ready.call(`/communities/${ready.community}/hns-root-imports`)).json(),
        ).toMatchObject({
          attachment: { status: "active", binding_generation: 3 },
        });
        expect(await Effect.runPromise(appAuthority.resolve("app.harbor"))).toMatchObject({
          app_host_activation_status: capabilityStatus,
          route_binding_current: capabilityStatus === "active",
          route_authority_effective: true,
        });
        expect(await Effect.runPromise(hostAuthority.resolve("journeytest.harbor"))).toMatchObject({
          namespace_authority_effective: capabilityStatus === "active",
          handle_grant_active: capabilityStatus === "active",
          owner_persona_id: persona,
        });
        expect(
          await run(sales.getClaim({ accountId: buyer, claimId: claim.claim.claim_id })),
        ).toEqual(claim.claim);
        const lease = (
          await ready.admin.query(
            `SELECT extract(epoch FROM expires_at-verified_at)::int AS seconds
      FROM community_route_ownership_evidence WHERE evidence_ref=$1`,
            [after.verified_evidence_ref],
          )
        ).rows[0];
        expect(lease.seconds).toBeGreaterThan(2_900);
        expect(lease.seconds).toBeLessThanOrEqual(3_600);
      } finally {
        await ready.cleanup();
      }
    },
    240_000,
  );
