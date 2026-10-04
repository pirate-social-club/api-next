import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { AlertCollector, ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import {
  encodeHnsControlObserverConfiguration,
  HnsActiveLeaseRenewalProviderFailed,
  runHnsActiveLeaseRenewal,
} from "@pirate/application/namespace-ownership";
import { makeControlPlaneHnsActiveLeaseRenewalStore } from "@pirate/platform-cf/hns-active-lease-renewal-repository";
import { makeControlPlaneHnsHandlePersonaHostAuthoritySource } from "@pirate/platform-cf/hns-handle-host-authority-repository";
import { makeControlPlaneHnsCommunityAppHostAuthoritySource } from "@pirate/platform-cf/hns-host-persistence-repository";
import { Effect, Layer, Redacted } from "effect";
import { Client } from "pg";
import {
  hsdRegtestAuthorization,
  hsdRegtestConnectionString,
  hsdRegtestGenesis,
  hsdRegtestNode,
  hsdRegtestNodeUrl,
  hsdRegtestReachable,
  hsdRegtestWallet,
  markHnsRegtestSuiteComplete,
} from "../../../packages/platform-cf/src/hns-regtest-node.pg-fixture.ts";
import { makeHnsObserverDriverHsdHttpCapability } from "../../hns-observer-driver/src/hsd-http.ts";
import { makeHnsObserverDriverService } from "../../hns-observer-driver/src/service.ts";
import { type Env, app as verifier } from "../../hns-owner-verifier/src/index.ts";
import { makeProductionHnsActivationCurrentView } from "../../http-worker/src/hns-activation-current-view-composition.ts";
import {
  activate,
  enabledConfiguration,
  prepareReadyImport,
} from "../../http-worker/src/hns-community-activation.pg-fixture.ts";
import { claimImportedHnsHandle } from "../../http-worker/src/hns-community-claim.pg-fixture.ts";
import { makeProductionHnsOwnerRecoveryHandlers } from "../../http-worker/src/hns-owner-recovery-production-composition.ts";
import { createHttpWorker } from "../../http-worker/src/transport.ts";
import { checkOwnerRecoveryUi } from "./hns-owner-recovery-ui.pg-fixture.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeHnsActiveLeaseRenewalJob } = await import("./hns-active-lease-renewal.ts");
const { JobContext } = await import("./registry.ts");
const suite = (await hsdRegtestReachable()) ? describe : describe.skip;

suite("claimed import renewal and ordinary recovery on the live regtest chain", () => {
  test("the configured tick obtains fresh proof, refuses expiry and preserves the claim through owner recovery", async () => {
    const connectionString = hsdRegtestConnectionString;
    if (!connectionString) throw new Error("PostgreSQL required");
    // This suite owns a disposable database and HSD node. The production
    // verifier composition pins api_next, so its fixture uses that schema.
    // Rapid mining otherwise advances block time past the application clock.
    // The node is disposable; keep its real proof inside the one-hour lease.
    await hsdRegtestNode("setmocktime", [Math.floor(Date.now() / 1_000) - 600]);
    const address = (await hsdRegtestWallet("getnewaddress")) as string;
    const mine = async (blocks: number) => {
      await hsdRegtestNode("generatetoaddress", [blocks, address]);
      // CI's preceding DNS fixture may already have mined future timestamps.
      // Wait for that real chain clock; never relax the verifier's time check.
      const info = (await hsdRegtestNode("getblockchaininfo")) as { mediantime: number };
      const wait = Math.max(0, info.mediantime * 1_000 - Date.now() + 1);
      if (!Number.isFinite(wait) || wait > 120_000)
        throw new Error("Regtest chain clock is outside the test budget");
      if (wait > 0) await Bun.sleep(wait);
    };
    await mine(110);
    await hsdRegtestWallet("sendopen", ["harbor"]);
    await mine(8);
    await hsdRegtestWallet("sendbid", ["harbor", 5, 10]);
    await mine(6);
    await hsdRegtestWallet("sendreveal", ["harbor"]);
    await mine(12);
    await hsdRegtestWallet("sendupdate", ["harbor", { records: [] }]);
    await mine(30);

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
    let chainUnavailable = false;
    let chainReads = 0;
    const driver = makeHnsObserverDriverService({
      hsd_driver_reference: configuration.chain.driver_reference,
      hsd: makeHnsObserverDriverHsdHttpCapability({
        endpoint: hsdRegtestNodeUrl,
        authorization: hsdRegtestAuthorization,
        fetcher: async (input, init) => {
          chainReads++;
          if (chainUnavailable) return new Response("Unavailable", { status: 503 });
          return fetch(input, init);
        },
      }),
      dns_views: [],
    });
    const env: Env = {
      CONTROL_PLANE: { connectionString },
      HNS_OBSERVER_DRIVER: {
        fetch: (input, init) =>
          driver.fetch(
            input instanceof Request ? new Request(input, init) : new Request(String(input), init),
          ),
      },
      HNS_OWNERSHIP_SOURCE: "hns_parent_chain_txt",
      HNS_CHALLENGE_TTL_SECONDS: "3600",
      HNS_EVIDENCE_TTL_SECONDS: "3600",
      HNS_PROVIDER_ENVIRONMENT: "staging",
      HNS_PROVIDER_CONFIGURATION_REFERENCE: configuration.provider_configuration_reference,
      HNS_PROVIDER_CONFIGURATION_VERSION: configuration.provider_configuration_version,
      HNS_PROVIDER_CONFIGURATION_DIGEST: digest,
      HNS_CHAIN_DRIVER_REFERENCE: configuration.chain.driver_reference,
      HNS_SNAPSHOT_STORE_REFERENCE: configuration.snapshot_store_reference,
      HNS_OBSERVER_DEADLINE_MS: "12000",
      HNS_PROVIDER_CAPABILITIES: "hns-txt-import-v1",
    };
    let configured = false;
    let importPolls = 0;
    let records: readonly unknown[] = [];
    const ready = await prepareReadyImport({
      connectionString,
      schema: "api_next",
      beforeAcknowledge: async (admin, session) => {
        const row = (
          await admin.query(
            "SELECT publish_plan_bytes FROM hns_root_import_sessions WHERE root_import_session_id=$1",
            [session],
          )
        ).rows[0];
        records = JSON.parse(Buffer.from(row.publish_plan_bytes).toString()).replacement_records;
      },
      verifier: () => async (request) => {
        if (!configured) {
          const admin = new Client({ connectionString });
          await admin.connect();
          try {
            await admin.query(
              "INSERT INTO api_next.hns_control_observer_configurations(provider_configuration_reference,provider_configuration_version,provider_configuration_digest,configuration_bytes) VALUES($1,$2,$3,$4)",
              [
                configuration.provider_configuration_reference,
                configuration.provider_configuration_version,
                digest,
                configurationBytes,
              ],
            );
            configured = true;
          } finally {
            await admin.end();
          }
        }
        // Retain the fixture's five pending ticks, then publish once. Every
        // ownership response comes from the actual private verifier and HSD.
        if (new URL(request.url).pathname.endsWith("/import-poll") && ++importPolls === 6) {
          await hsdRegtestWallet("sendupdate", ["harbor", { records }]);
          await mine(30);
        }
        return verifier.fetch(request, env);
      },
    });
    try {
      ready.hsd.setRecords(ready.planRecords);
      expect(
        (
          await activate(
            ready,
            makeProductionHnsActivationCurrentView(ready.layer, {
              ...enabledConfiguration(hsdRegtestNodeUrl),
              HNS_AUTHORITY_HSD_AUTHORIZATION: Redacted.make(hsdRegtestAuthorization),
              HNS_AUTHORITY_CHAIN_GENESIS_BLOCK_HASH: hsdRegtestGenesis,
              HNS_AUTHORITY_TREE_INTERVAL_BLOCKS: 5,
            }),
            "live-renewal-activate",
          )
        ).status,
      ).toBe(201);
      const { persona, claim } = await claimImportedHnsHandle(ready);
      const grant = claim.claim.grant;
      if (grant === null) throw new Error("Expected issued claim grant");
      const readBinding = async () =>
        (
          await ready.admin.query(
            "SELECT b.*,e.expires_at,e.origin FROM community_canonical_route_bindings b LEFT JOIN community_route_ownership_evidence e ON e.evidence_ref=b.verified_evidence_ref WHERE b.community_id=$1",
            [ready.community],
          )
        ).rows[0];
      const initial = await readBinding();
      const appAuthority = makeControlPlaneHnsCommunityAppHostAuthoritySource(ready.layer);
      const memberAuthority = makeControlPlaneHnsHandlePersonaHostAuthoritySource(ready.layer);
      const assertServingAuthority = async (effective: boolean) => {
        expect(await Effect.runPromise(appAuthority.resolve("app.harbor"))).toMatchObject({
          route_authority_effective: effective,
        });
        expect(
          await Effect.runPromise(memberAuthority.resolve("journeytest.harbor")),
        ).toMatchObject({ namespace_authority_effective: effective, owner_persona_id: persona });
        const retained = (
          await ready.admin.query(
            "SELECT grant_id,owner_persona_id,status FROM handle_grants WHERE grant_id=$1",
            [grant.grant_id],
          )
        ).rows[0];
        expect(retained).toMatchObject({
          grant_id: grant.grant_id,
          owner_persona_id: persona,
          status: "active",
        });
      };
      await assertServingAuthority(true);
      // Only the disposable PostgreSQL fixture clock is accelerated. Lease
      // policy stays one hour and the product must obtain a new observation.
      const moveExpiry = async (interval: "5 minutes" | "-1 second") => {
        await ready.admin.query(
          "ALTER TABLE community_route_ownership_evidence DISABLE TRIGGER community_route_ownership_evidence_append_only",
        );
        try {
          await ready.admin.query(
            `UPDATE community_route_ownership_evidence SET verified_at=clock_timestamp()-interval '1 hour', expires_at=clock_timestamp()+interval '${interval}' WHERE evidence_ref=(SELECT verified_evidence_ref FROM community_canonical_route_bindings WHERE community_id=$1)`,
            [ready.community],
          );
        } finally {
          await ready.admin.query(
            "ALTER TABLE community_route_ownership_evidence ENABLE TRIGGER community_route_ownership_evidence_append_only",
          );
        }
      };
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
            fetch: (input, init) => {
              providerCalls++;
              return verifier.fetch(new Request(String(input), init), env);
            },
          },
        },
        "staging",
        {},
      );
      if (!job) throw new Error("Configured renewal job missing");
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
              attemptId: "live-regtest",
              owner: "test-owner",
              lease: () => ({ expiresAt: Date.now() + 60_000, generation: 1, owner: "test-owner" }),
            }),
          ),
        );
      await mine(5);
      await moveExpiry("5 minutes");
      chainUnavailable = true;
      const readsBeforeFailure = chainReads;
      await expect(tick()).rejects.toMatchObject({ reason: "unavailable" });
      expect(chainReads).toBeGreaterThan(readsBeforeFailure);
      expect(await readBinding()).toMatchObject({
        binding_generation: "1",
        ownership_status: "verified",
      });
      const failedObservation = (
        await ready.admin.query(
          "SELECT observation_id,result_status FROM hns_control_observer_snapshots WHERE result_status='unavailable'",
        )
      ).rows;
      expect(failedObservation).toHaveLength(1);
      chainUnavailable = false;
      const readsBeforeRetry = chainReads;
      await tick();
      expect(chainReads).toBeGreaterThan(readsBeforeRetry);
      const renewed = await readBinding();
      expect(renewed).toMatchObject({
        binding_generation: "2",
        ownership_status: "verified",
        origin: "active_lease_renewal",
      });
      expect(renewed.verified_evidence_ref).not.toBe(initial.verified_evidence_ref);
      expect(new Date(renewed.expires_at).getTime()).toBeGreaterThan(
        new Date(initial.expires_at).getTime(),
      );
      expect(new Date(renewed.expires_at).getTime()).toBeGreaterThan(Date.now() + 900_000);
      expect(providerCalls).toBe(2);
      expect(alerts).toEqual([]);
      await assertServingAuthority(true);
      await tick();
      expect(providerCalls).toBe(2);
      const renewalProof = (
        await ready.admin.query(
          `SELECT proof.chain_anchor_height,proof.provider_evidence_ref,snapshot.observation_id,snapshot.result_status,attempt.fence_token
         FROM community_route_active_lease_renewal_evidence_snapshots proof
         JOIN hns_control_observer_snapshots snapshot ON proof.provider_evidence_ref=('hns-observer-v1:sha256:' || snapshot.result_sha256 || ':' || snapshot.snapshot_reference)
         JOIN community_route_active_lease_renewal_attempts attempt USING(active_lease_renewal_attempt_id)
         WHERE proof.evidence_ref=$1`,
          [renewed.verified_evidence_ref],
        )
      ).rows;
      expect(renewalProof).toHaveLength(1);
      expect(renewalProof[0]).toMatchObject({ result_status: "verified", fence_token: "2" });
      expect(renewalProof[0].observation_id).not.toBe(failedObservation[0].observation_id);
      expect(Number(renewalProof[0].chain_anchor_height)).toBeGreaterThan(0);
      await moveExpiry("-1 second");
      await expect(
        Effect.runPromise(
          runHnsActiveLeaseRenewal(
            {
              route_binding_id: initial.route_binding_id,
              idempotency_key: "explicit-expired-renewal",
            },
            {
              store: makeControlPlaneHnsActiveLeaseRenewalStore(ready.layer),
              policy: { ...configuration.chain, evidence_lease_seconds: 3600 },
              provider: {
                renew: () => {
                  providerCalls++;
                  return Effect.fail(
                    new HnsActiveLeaseRenewalProviderFailed({ reason: "unavailable" }),
                  );
                },
              },
            },
          ),
        ),
      ).rejects.toMatchObject({ reason: "not_found" });
      expect(providerCalls).toBe(2);
      await tick();
      expect(providerCalls).toBe(2);
      expect(await readBinding()).toMatchObject({
        binding_generation: "3",
        route_lifecycle_status: "suspended",
        verified_evidence_ref: null,
      });
      expect(
        await Effect.runPromise(
          makeControlPlaneHnsActiveLeaseRenewalStore(ready.layer).resolve({
            route_binding_id: initial.route_binding_id,
          }),
        ),
      ).toBeNull();
      await assertServingAuthority(false);

      let expireAfterCleanup = false;
      let expiryBarriers = 0;
      const recoveryDatabase = Layer.effect(
        ControlPlaneDb,
        Effect.map(
          ControlPlaneDb,
          (db) =>
            ({
              ...db,
              withTransaction: (use) =>
                db.withTransaction((transaction) =>
                  use({
                    ...transaction,
                    execute: <Row>(statement: ControlPlaneStatement) =>
                      transaction.execute<Row>(statement).pipe(
                        Effect.tap(() =>
                          Effect.gen(function* () {
                            if (
                              !expireAfterCleanup ||
                              statement.label !== "hns-owner-recovery.poll-release-expired-lease"
                            )
                              return;
                            expireAfterCleanup = false;
                            const lease = yield* transaction.execute<{
                              live: boolean;
                              wait_ms: number;
                            }>({
                              label: "regtest.recovery-lease-before-expiry",
                              text: "SELECT lease_expires_at > clock_timestamp() AS live, (EXTRACT(EPOCH FROM lease_expires_at-clock_timestamp())*1000)::double precision AS wait_ms FROM community_route_revalidation_completion_attempts WHERE route_revalidation_id=$1 AND state='leased'",
                              values: statement.values,
                              readonly: true,
                            });
                            expect(lease.rows).toMatchObject([{ live: true }]);
                            const wait = lease.rows[0]?.wait_ms;
                            if (wait === undefined || wait <= 0 || wait > 16_000)
                              throw new Error("Recovery expiry barrier is outside its lease");
                            // Keep the canonical 16-second lease and statement
                            // bounds; pause this client between SQL statements.
                            yield* Effect.promise(() => Bun.sleep(wait + 10));
                            const expired = yield* transaction.execute<{ expired: boolean }>({
                              label: "regtest.recovery-lease-after-expiry",
                              text: "SELECT lease_expires_at <= clock_timestamp() AS expired FROM community_route_revalidation_completion_attempts WHERE route_revalidation_id=$1 AND state='leased'",
                              values: statement.values,
                              readonly: true,
                            });
                            expect(expired.rows).toEqual([{ expired: true }]);
                            expiryBarriers++;
                          }),
                        ),
                      ),
                  }),
                ),
            }) satisfies ControlPlaneDb["Service"],
        ),
      ).pipe(Layer.provide(ready.layer));
      const recovery = createHttpWorker({
        config: { corsOrigin: "https://worker.test" },
        handlers: makeProductionHnsOwnerRecoveryHandlers({
          enabled: true,
          environment: "staging",
          database: recoveryDatabase,
          verifier: {
            fetch: (input, init) => verifier.fetch(new Request(String(input), init), env),
          },
        }),
        authenticate: () => ({ kind: "user", subject: ready.actor }),
        authorize: () => {},
      });
      const request = (command: "start" | "poll", body: unknown) =>
        recovery.request(
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
      const start = await request("start", {
        expected_generation: 3,
        idempotency_key: "live-recover-start",
      });
      expect(start.status).toBe(201);
      const started = (await start.json()) as { route_recovery_id: string; session_id: string };
      const poll = {
        route_recovery_id: started.route_recovery_id,
        session_id: started.session_id,
        expected_generation: 3,
        idempotency_key: "live-recover-poll",
        channel: "poll_result",
      };
      const pending = await request("poll", poll);
      expect(pending.status).toBe(202);
      expect(await pending.json()).toMatchObject({ status: "pending" });
      const leasePendingAttempt = async (key: string) => {
        const leased = await ready.admin.query(
          "UPDATE community_route_revalidation_completion_attempts SET state='leased',fence_token=fence_token+1,lease_expires_at=clock_timestamp()+interval '2 seconds' WHERE route_revalidation_id=$1 AND idempotency_key=$2 AND state='released' RETURNING route_revalidation_attempt_id",
          [started.route_recovery_id, key],
        );
        expect(leased.rowCount).toBe(1);
        expireAfterCleanup = true;
      };
      await leasePendingAttempt(poll.idempotency_key);
      const expiredBeforeAdmission = await request("poll", {
        ...poll,
        idempotency_key: "live-recover-poll-2",
      });
      expect(expiredBeforeAdmission.status).toBe(409);
      const pendingAgain = await request("poll", {
        ...poll,
        idempotency_key: "live-recover-poll-2",
      });
      expect(pendingAgain.status).toBe(202);
      expect(await pendingAgain.json()).toMatchObject({ status: "pending" });
      await leasePendingAttempt("live-recover-poll-2");
      const expiredBeforeReacquire = await request("poll", poll);
      expect(expiredBeforeReacquire.status).toBe(409);
      expect(expiryBarriers).toBe(2);
      const challenge = (
        await ready.admin.query(
          "SELECT upstream_session_ref FROM community_route_revalidation_sessions WHERE revalidation_session_id=$1",
          [started.session_id],
        )
      ).rows[0];
      const replacement = records.map((record) => {
        const value = record as { type: string };
        return value.type === "TXT"
          ? { type: "TXT", txt: [`pirate-verification=${challenge.upstream_session_ref}`] }
          : record;
      });
      await hsdRegtestWallet("sendupdate", ["harbor", { records: replacement }]);
      await mine(30);
      // Retry the original key after the resource changes. It must reacquire
      // that attempt's fence and obtain new proof, rather than replay pending.
      const recovered = await request("poll", poll);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ status: "verified", generation: 4 });
      expect(await readBinding()).toMatchObject({
        binding_generation: "4",
        ownership_status: "verified",
        route_lifecycle_status: "active",
        origin: "route_revalidation",
      });
      await assertServingAuthority(true);
      expect(
        (
          await ready.admin.query(
            "SELECT attempt_number,state,fence_token FROM community_route_revalidation_completion_attempts WHERE route_revalidation_id=$1 ORDER BY created_at",
            [started.route_recovery_id],
          )
        ).rows,
      ).toEqual([
        { attempt_number: 1, state: "consumed", fence_token: "3" },
        { attempt_number: 1, state: "released", fence_token: "2" },
      ]);

      if (process.env.HNS_REGTEST_SOLID_ROOT) {
        await moveExpiry("-1 second");
        await tick();
        await checkOwnerRecoveryUi({ ready, request, records, mine });
        await assertServingAuthority(true);
      }
      const beforeNegative = await readBinding();
      // A genuine chain rejection must fail closed, while retaining the claim.
      await hsdRegtestWallet("sendupdate", [
        "harbor",
        { records: replacement.filter((record) => (record as { type: string }).type !== "TXT") },
      ]);
      await mine(30);
      await moveExpiry("5 minutes");
      await tick();
      expect(providerCalls).toBe(3);
      expect(await readBinding()).toMatchObject({
        ownership_status: "disputed",
        route_lifecycle_status: "suspended",
      });
      expect(alerts).toEqual(["hns-active-lease-renewal:unresolved"]);
      const rejection = (
        await ready.admin.query(
          "SELECT status FROM community_route_active_lease_renewals WHERE expected_binding_generation=$1",
          [beforeNegative.binding_generation],
        )
      ).rows;
      expect(rejection).toEqual([{ status: "failed" }]);
      await assertServingAuthority(false);
    } finally {
      await ready.cleanup();
      await hsdRegtestNode("setmocktime", [Math.floor(Date.now() / 1_000)]);
    }
    await markHnsRegtestSuiteComplete(
      "HNS_REGTEST_RENEWAL_RECOVERY_SENTINEL",
      "api-next-hns-regtest-renewal-recovery-suite-complete",
    );
  }, 180_000);
});
