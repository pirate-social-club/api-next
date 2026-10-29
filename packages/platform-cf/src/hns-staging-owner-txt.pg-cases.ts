import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { ControlPlaneDb } from "@pirate/application";
import {
  deriveHnsEvidenceLease,
  hnsControlIdentityDigest,
} from "@pirate/application/namespace-ownership";
import {
  pollHnsOwnerRecovery,
  startHnsOwnerRecovery,
} from "@pirate/application/route-revalidation";
import { canonicalJson } from "@pirate/domain";
import { Sha256Hex } from "@pirate/domain/verification";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import { makeControlPlaneCommunityRouteExpiryStore } from "./community-route-expiry-repository.ts";
import { finalizeImportedInventoryRenewal } from "./hns-imported-inventory-renewal.ts";
import { promoteImportedHnsInventorySuccessor } from "./hns-imported-inventory-successor.ts";
import { deferExpiredHnsRecoveryHosts } from "./hns-owner-recovery-expired-dns.ts";
import { makeControlPlaneHnsOwnerRecoveryPollStore } from "./hns-owner-recovery-poll-repository.ts";
import {
  makeControlPlaneHnsOwnerRecoveryAuthorityResolver,
  makeControlPlaneHnsOwnerRecoveryStartStore,
} from "./hns-owner-recovery-start-repository.ts";
import { verifyHnsOwnerTxtServingGenerationFences } from "./hns-staging-owner-txt-generation.pg-cases.ts";
import { verifyHnsOwnerTxtLockOrder } from "./hns-staging-owner-txt-locks.pg-cases.ts";
import { readHnsStagingOwnerTxtRecovery } from "./hns-staging-owner-txt-recovery.ts";
import {
  verifyHnsOwnerTxtExpiryDuringObservation,
  verifyHnsOwnerTxtLateRollback,
} from "./hns-staging-owner-txt-rollback.pg-cases.ts";
import { adoptHnsRootZone, readHnsRootZoneAdoptionState } from "./hns-zone-adoption.ts";
import { redateHnsZoneAdoptionFixture } from "./hns-zone-adoption-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

type Artifact = Readonly<{ result_bytes: Uint8Array; result_sha256: string }>;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Compose expiry, creator recovery, exact chain adoption and ordinary renewal.
 * Only the external chain/DNS observer is supplied; all database writers are real. */
export async function verifyHnsStagingOwnerTxt(
  admin: Client,
  connection: string,
  previousRecords: readonly { readonly type: string; readonly [key: string]: unknown }[],
  artifact: (chainHash: string) => Promise<Artifact>,
  dnsExpired: boolean,
  expireDuringObservation: boolean,
) {
  const layer = makeDirectPostgresControlPlaneLayer(connection);
  const pointers = async () =>
    (
      await admin.query(`SELECT
    (SELECT current_generation FROM hns_dns_zone_activation_current) AS dns,
    (SELECT current_generation FROM hns_community_app_host_activation_current) AS app,
    (SELECT current_generation FROM community_handle_sale_namespace_activation_current) AS sale,
    (SELECT count(*)::int FROM hns_authority_inventories) AS inventories,
    (SELECT count(*)::int FROM hns_dns_zone_activation_revisions) AS dns_revisions,
    (SELECT count(*)::int FROM hns_community_app_host_activation_revisions) AS app_revisions,
    (SELECT count(*)::int FROM hns_dns_zone_health_observations) AS health_observations,
    (SELECT count(*)::int FROM community_handle_sale_namespace_activation_revisions) AS sale_revisions,
    (SELECT binding_generation FROM community_canonical_route_bindings) AS route`)
    ).rows[0];
  const expiry = (
    await admin.query<{ remaining: number }>(`SELECT
    ceil(extract(epoch FROM expires_at-clock_timestamp())*1000)::int AS remaining
    FROM community_route_ownership_evidence WHERE evidence_ref='evidence-root-import'`)
  ).rows[0]?.remaining;
  if (expiry === undefined || expiry <= 0 || expiry > 15_000)
    throw new Error("owner TXT fixture did not activate before its ownership expiry");
  await Bun.sleep(expiry + 50);
  expect(
    await Effect.runPromise(
      makeControlPlaneCommunityRouteExpiryStore(layer).expire({
        family: "hns",
        limit: 1,
        principal_id: "owner-txt-expiry-fixture",
      }),
    ),
  ).toEqual({ selected: 1, transitioned: 1, stale: 0 });
  const upstream = "nvs_owner_txt_fixture";
  const challenge = `pirate-verification=${upstream}`;
  const started = await Effect.runPromise(
    Effect.scoped(
      startHnsOwnerRecovery(
        {
          actor_id: "actor-root-import",
          community_id: "community-root-import",
          expected_generation: 2,
          idempotency_key: "owner-txt-start",
        },
        {
          authority: makeControlPlaneHnsOwnerRecoveryAuthorityResolver(layer),
          store: makeControlPlaneHnsOwnerRecoveryStartStore(layer),
          provider: {
            start: (request) =>
              Effect.succeed({
                upstream_session_ref: upstream,
                expires_at: request.challenge_expires_at,
                presentation: {
                  kind: "embedded_sdk",
                  session_id: upstream,
                  protocol: "hns-txt-challenge",
                  version: "1",
                  payload: {
                    ownership_source: "hns_parent_chain_txt",
                    challenge_name: "newroot",
                    challenge_value: challenge,
                    expires_at: request.challenge_expires_at,
                  },
                },
              }),
          },
          ids: {
            reservation: () => "owner-txt-start-reservation",
            recovery: () => "owner-txt-recovery",
            session: () => "owner-txt-session",
          },
        },
      ),
    ),
  );
  expect(started).toMatchObject({ status: "pending", generation: 2 });
  const chainAuthority = Schema.decodeUnknownSync(Sha256Hex)("c".repeat(64));
  const chain = {
    chain_anchor_median_time: Math.floor(Date.now() / 1000) - 1,
    chain_anchor_height: 123550,
    expiry_height: 200000,
  };
  const policy = {
    expected_block_interval_seconds: 600,
    minimum_safe_remaining_blocks: 1,
    expiry_safety_blocks: 100,
    evidence_lease_seconds: expireDuringObservation ? 5 : 2592000,
  };
  const lease = deriveHnsEvidenceLease(chain, policy);
  const response = {
    status: "verified",
    observation_contract_version: "pirate-hns-target-observation-v2",
    provider_evidence_ref: `hns-observer-v1:sha256:${"d".repeat(64)}:owner-txt-fixture`,
    upstream_session_ref: upstream,
    ownership_source: "hns_parent_chain_txt",
    challenge_name: "newroot",
    challenge_value: challenge,
    expected_txt_value_sha256: createHash("sha256").update(challenge).digest("hex"),
    control_identity_digest: await hnsControlIdentityDigest({
      ownership_source: "hns_parent_chain_txt",
      txt_name: "newroot",
      expected_txt_value: challenge,
      root_label: "newroot",
      chain_authority_digest: chainAuthority,
    }),
    chain_authority_digest: chainAuthority,
    observer_result_sha256: "d".repeat(64),
    root_exists: true,
    root_control_verified: true,
    expiry_horizon_sufficient: true,
    chain_network: "hns-main",
    chain_anchor_height: chain.chain_anchor_height,
    chain_anchor_block_hash: "e".repeat(64),
    chain_anchor_median_time: chain.chain_anchor_median_time,
    expiry_height: chain.expiry_height,
    observed_at: lease.observed_at,
    expires_at: lease.expires_at,
  };
  const poll = () =>
    Effect.runPromise(
      Effect.scoped(
        pollHnsOwnerRecovery(
          {
            actor_id: "actor-root-import",
            community_id: "community-root-import",
            route_recovery_id: started.route_recovery_id,
            session_id: started.session_id,
            expected_generation: 2,
            idempotency_key: "owner-txt-poll",
            channel: "poll_result",
          },
          {
            store: makeControlPlaneHnsOwnerRecoveryPollStore(layer),
            provider: { poll: () => Effect.succeed(Buffer.from(JSON.stringify(response))) },
            policy,
            ids: {
              attempt: () => "owner-txt-attempt",
              evidence: () => "owner-txt-evidence",
              observation: () => "owner-txt-observation",
            },
          },
        ),
      ),
    );
  const afterExpiry = await pointers();
  expect(await poll()).toMatchObject({ status: "verified", generation: 3 });
  if (dnsExpired) {
    // Ownership is real, but no host, DNS, inventory or health pointer may
    // advance before the separately observed and reviewed authority adoption.
    expect(await pointers()).toEqual({ ...afterExpiry, route: "3" });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM community_route_ownership_evidence WHERE evidence_ref='owner-txt-evidence'",
        )
      ).rows[0]?.count,
    ).toBe(1);
    const unavailable = await admin.query(`SELECT dns_delegation_current
      FROM current_hns_sale_namespace_dependency_v1(
        'community-root-import','owner-txt-evidence',3,'dns-root-import',1,clock_timestamp())`);
    expect(unavailable.rows[0]?.dns_delegation_current).toBe(false);
  }
  const operator = new Client({ connectionString: connection });
  await operator.connect();
  try {
    const state = await readHnsRootZoneAdoptionState(operator, "newroot");
    const next = previousRecords.map((record) =>
      record.type === "TXT" &&
      Array.isArray(record.txt) &&
      record.txt.join("") === "pirate-verification=challenge"
        ? { type: "TXT", txt: [challenge] }
        : record,
    );
    const recoveryPointers = await pointers();
    const review = {
      version: "hns-reviewed-staging-owner-txt-v1",
      root_label: "newroot",
      community_id: "community-root-import",
      route_binding_id: "route-binding-root-import",
      binding_generation: 3,
      evidence_ref: "owner-txt-evidence",
      recovery_attempt_id: "owner-txt-attempt",
      dns_zone_activation_id: state.dns_zone_activation_id,
      app_host_activation_id: "app-root-import",
      app_generation: Number(recoveryPointers.app),
      sale_namespace_activation_id: "sale-root-import",
      sale_generation: Number(recoveryPointers.sale),
      previous_generation: state.current_generation,
      previous_health_generation: state.current_health_generation,
      previous_chain_records: previousRecords,
      chain_records: next,
    };
    const observed = await artifact(hash(next));
    const request = (mode: "dry-run" | "rehearse" | "commit", proof: unknown = review) => ({
      ...observed,
      expected_result_sha256: observed.result_sha256,
      expected_delta: "staging_owner_txt_refreshed" as const,
      mode,
      reviewed_owner_txt: proof,
      observe_current: async (current: { database_time: string }) =>
        (
          await redateHnsZoneAdoptionFixture(
            (
              await artifact(hash(next))
            ).result_bytes,
            current.database_time,
          )
        ).result_bytes,
    });
    if (dnsExpired) {
      for (const mismatch of [{ recovery_id: "unrelated" }, { expected_binding_generation: 1 }]) {
        expect(
          await Effect.runPromise(
            Effect.gen(function* () {
              const db = yield* ControlPlaneDb;
              return yield* db.withTransaction((transaction) =>
                deferExpiredHnsRecoveryHosts(transaction, {
                  community_id: "community-root-import",
                  route_binding_id: "route-binding-root-import",
                  expected_binding_generation: 2,
                  evidence_ref: "owner-txt-evidence",
                  recovery_id: "owner-txt-recovery",
                  ...mismatch,
                }),
              );
            }).pipe(Effect.provide(layer)),
          ),
        ).toBe(false);
      }
      const beforeMixed = await pointers();
      await admin.query("BEGIN");
      try {
        await admin.query(
          `SELECT * FROM change_hns_community_app_host_status_v1(
          'txt-mixed-app','txt-mixed-app',repeat('f',64),'app-root-import',$1,'active',NULL)`,
          [review.app_generation],
        );
        // Even a review updated to the real new app generation cannot mix
        // current app ownership with a sale on the expired predecessor.
        await expect(
          readHnsStagingOwnerTxtRecovery(admin, {
            review: { ...review, app_generation: review.app_generation + 1 },
            root_import_session_id: state.root_import_session_id,
            lock: false,
          }),
        ).rejects.toThrow("recovery lineage is unavailable");
      } finally {
        await admin.query("ROLLBACK");
      }
      expect(await pointers()).toEqual(beforeMixed);
    }
    if (expireDuringObservation) {
      await verifyHnsOwnerTxtExpiryDuringObservation(admin, operator, request("commit"), pointers);
      return;
    }
    if (!dnsExpired) {
      const generations = await verifyHnsOwnerTxtServingGenerationFences({
        admin,
        connection,
        dns_id: state.dns_zone_activation_id,
        dns_generation: state.current_generation,
        app_generation: review.app_generation,
        sale_generation: review.sale_generation,
        refuse_stale: () => adoptHnsRootZone(operator, request("commit")),
      });
      review.app_generation = generations.app_generation;
      await generations.change_sale();
      await expect(adoptHnsRootZone(operator, request("commit"))).rejects.toThrow("fence changed");
      review.sale_generation = generations.sale_generation;
    }
    const before = await pointers();
    await verifyHnsOwnerTxtLockOrder(admin, operator, request("rehearse"));
    expect(await pointers()).toEqual(before);
    // The original renewal still refuses the changed chain. No equality control is weakened.
    await admin.query("SELECT * FROM schedule_hns_root_health_renewals_v1(25,259200,7200)");
    const job = (
      await admin.query("SELECT * FROM claim_hns_root_health_renewal_job_v1('txt-executor',60)")
    ).rows[0];
    if (job === undefined) throw new Error("expected an owner TXT renewal claim");
    await admin.query("BEGIN");
    try {
      expect(
        (
          await admin.query(
            `SELECT outcome FROM prepare_hns_root_inventory_renewal_v1($1,$2,$3,$4,'ready',$5,$6,NULL)`,
            [
              job.observation_job_id,
              "txt-executor",
              Number(job.lease_fence),
              job.request_sha256,
              observed.result_bytes,
              observed.result_sha256,
            ],
          )
        ).rows[0]?.outcome,
      ).toBe("failed");
      expect(
        (
          await admin.query(
            "SELECT failure_code FROM hns_root_health_renewal_jobs WHERE renewal_job_id=$1",
            [job.observation_job_id],
          )
        ).rows[0]?.failure_code,
      ).toBe("evidence_mismatch");
    } finally {
      await admin.query("ROLLBACK");
    }
    for (const mode of ["dry-run", "rehearse"] as const) {
      expect(await adoptHnsRootZone(operator, request(mode))).toMatchObject({
        committed: false,
        delta: "staging_owner_txt_refreshed",
      });
      expect(await pointers()).toEqual(before);
    }
    await expect(
      adoptHnsRootZone(
        operator,
        request("commit", { ...review, recovery_attempt_id: "unrelated" }),
      ),
    ).rejects.toThrow();
    expect(await pointers()).toEqual(before);
    // The shared promotion must independently refuse a forged review too.
    await operator.query("BEGIN");
    try {
      await expect(
        promoteImportedHnsInventorySuccessor(
          operator,
          observed.result_bytes,
          observed.result_sha256,
          "hns-zone-adoption",
          undefined,
          { ...review, previous_generation: state.current_generation - 1 },
        ),
      ).rejects.toThrow();
    } finally {
      await operator.query("ROLLBACK");
    }
    expect(await pointers()).toEqual(before);
    await verifyHnsOwnerTxtLateRollback(admin, pointers, () =>
      adoptHnsRootZone(operator, request("commit")),
    );
    expect(await adoptHnsRootZone(operator, request("commit"))).toMatchObject({ committed: true });
    const adopted = await readHnsRootZoneAdoptionState(operator, "newroot");
    expect(adopted.current_generation).toBe(state.current_generation + 1);
    expect(adopted.retained_zone_bytes_sha256).toBe(state.retained_zone_bytes_sha256);
    expect(adopted.stable_chain_delegation_snapshot_reference).toBe(`hns-root-chain:${hash(next)}`);
    expect(
      (
        await admin.query(
          `SELECT dns_delegation_current
        FROM current_hns_sale_namespace_dependency_v1(
          'community-root-import','owner-txt-evidence',3,'dns-root-import',$1,clock_timestamp())`,
          [adopted.current_generation],
        )
      ).rows[0]?.dns_delegation_current,
    ).toBe(true);
    // A captured old generation cannot be replayed after pointer advancement.
    await expect(adoptHnsRootZone(operator, request("commit"))).rejects.toThrow();
    const renewed = await artifact(hash(next));
    await admin.query("SELECT * FROM schedule_hns_root_health_renewals_v1(25,259200,7200)");
    const successorJob = (
      await admin.query("SELECT * FROM claim_hns_root_health_renewal_job_v1('txt-renewal',60)")
    ).rows[0];
    if (successorJob === undefined) throw new Error("expected post-adoption renewal claim");
    expect(
      (
        await finalizeImportedInventoryRenewal(operator, {
          observation_job_id: String(successorJob.observation_job_id),
          executor_id: "txt-renewal",
          lease_fence: Number(successorJob.lease_fence),
          request_sha256: String(successorJob.request_sha256),
          ...renewed,
        })
      ).outcome,
    ).toBe("ready");
    expect((await readHnsRootZoneAdoptionState(operator, "newroot")).current_generation).toBe(
      state.current_generation + 2,
    );
  } finally {
    await operator.end();
  }
}
