import { expect, test } from "bun:test";
import type { HnsRootResourceRecordV1 } from "@pirate/application/namespace-ownership";
import {
  continueHnsCommunityPublication,
  preflightEncodeHnsResourceV1,
} from "@pirate/application/namespace-ownership";
import { makeHsdRootResourceObserver } from "@pirate/platform-cf/namespace-ownership-hns-root-resource-observer";
import { Effect } from "effect";
import { makeHnsLifecycleObservePort } from "../../hns-authority-provisioner/src/lifecycle-evidence.ts";
import { runHnsRootImportLifecycleJobOnce } from "../../hns-authority-provisioner/src/lifecycle-executor.ts";
import {
  makePostgresHnsLifecycleReadinessPorts,
  makePostgresHnsRootImportLifecycleQueue,
} from "../../hns-authority-provisioner/src/lifecycle-queue.ts";
import { runHnsRootImportReadinessOnce } from "../../hns-authority-provisioner/src/lifecycle-readiness.ts";
import { makeProductionHnsActivationCurrentView } from "./hns-activation-current-view-composition.ts";
import {
  type AcknowledgedImport,
  activate,
  enabledConfiguration,
  prepareAcknowledgedImport,
} from "./hns-community-activation.pg-fixture.ts";

/**
 * The joint ceremony: the production components from Start through
 * preparation, acknowledgement, current observation, safe commitment,
 * readiness and HTTP activation, with readiness ownership enabled by the
 * handover function. Every phase advances through its performer; the HSD RPC
 * server, the database seed and the live-probe doubles are the fixtures.
 */

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;

function lifecyclePortsFor(base: AcknowledgedImport) {
  const observer = makeHsdRootResourceObserver({
    rpc_url: base.hsd.url,
    authorization: "Basic fixture",
    chain_network: "regtest",
    genesis_block_hash: `${"0".repeat(63)}1`,
    tree_interval_blocks: 36,
    safe_minimum_confirmations: 12,
    maximum_tip_age_seconds: 86_400,
    maximum_future_tip_seconds: 3_600,
  });
  const queue = makePostgresHnsRootImportLifecycleQueue(
    base.scopedConnectionString,
    makeHnsLifecycleObservePort({
      observe_chain: (rootLabel, view) => observer(rootLabel, view),
    }),
  );
  const authorityView = (ordinal: 1 | 2) => ({
    authority_nameserver: `ns${ordinal}.pirate`,
    authority_address_family: "GLUE4" as const,
    authority_address: `192.0.2.${52 + ordinal}`,
    dnssec_validation: "secure" as const,
    challenge_present: true as const,
    validated_dnskey_response_sha256: String(ordinal).repeat(64),
    validated_control_response_sha256: String(ordinal + 2).repeat(64),
    validated_chain_authority_digest: "5".repeat(64),
    observed_zone_bytes: base.zoneResult.managed_zone_bytes,
    observed_zone_sha256: base.zoneResult.managed_rrset_sha256,
  });
  const readiness = makePostgresHnsLifecycleReadinessPorts(
    base.scopedConnectionString,
    {
      observe_current_resource: (rootLabel: string) => observer(rootLabel, "current"),
      reconcile_zone: async () => {},
      inspect_zone: async () => ({ ...base.zoneResult, created: false }),
      observe_live: async () => ({
        authority_views: [authorityView(1), authorityView(2)],
        gateway: {
          normalized_host: "app.harbor",
          gateway_address: base.zoneResult.gateway_ipv4,
          certificate_spki_sha256: base.zoneResult.gateway_certificate_spki_sha256,
          http_status: 421 as const,
        },
      }),
    },
    { environment: "staging", valid_for_seconds: 3600 },
    queue.finalize,
  );
  return {
    ports: {
      ...queue,
      readiness: (job: Parameters<typeof runHnsRootImportReadinessOnce>[0], executorId: string) =>
        runHnsRootImportReadinessOnce(job, executorId, readiness),
    },
  };
}

async function phaseOf(base: AcknowledgedImport) {
  const result = await base.admin.query<{
    phase: string;
    generation: string;
    revision: string;
    readiness_observed_at: Date | null;
  }>(
    `SELECT phase, generation, revision, readiness_observed_at
       FROM hns_root_import_lifecycle WHERE root_import_session_id=$1`,
    [base.sessionId],
  );
  return result.rows[0];
}

async function ensureJob(base: AcknowledgedImport, kind: "observe_current" | "observe_readiness") {
  await base.admin.query(
    `INSERT INTO hns_root_import_lifecycle_jobs (root_import_session_id, job_kind, due_at)
     SELECT $1,$2,clock_timestamp() - interval '1 second'
      WHERE NOT EXISTS (
        SELECT 1 FROM hns_root_import_lifecycle_jobs AS pending
         WHERE pending.root_import_session_id=$1 AND pending.job_kind=$2
           AND pending.state='queued'
           AND pending.generation = (
             SELECT generation FROM hns_root_import_lifecycle WHERE root_import_session_id=$1
           )
      )`,
    [base.sessionId, kind],
  );
}

async function activateNow(
  base: AcknowledgedImport,
  idempotencyKey: string,
  currentView: unknown,
  explicit?: Readonly<{
    revision: number;
    publish_plan_sha256: string;
    readiness_result_sha256: string;
  }>,
) {
  const session =
    explicit ??
    ((await (await base.call(base.sessionUrl)).json()) as {
      revision: number;
      publish_plan_sha256: string;
      readiness_result_sha256: string;
    });
  return activate(
    {
      ...base,
      revision: session.revision,
      readinessResultSha256: session.readiness_result_sha256,
    } as never,
    currentView,
    idempotencyKey,
  );
}

pgTest(
  "the joint ceremony advances every phase through its performer",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const base = await prepareAcknowledgedImport({ connectionString: url });
    try {
      const { ports } = lifecyclePortsFor(base);
      const runOne = async () => {
        // A superseded-generation job can be disposed by the claim before a
        // current-generation job is reached; give the performer a bounded
        // number of attempts so the disposal is exercised, not bypassed.
        for (let attempt = 0; attempt < 3; attempt++) {
          await base.admin.query(
            `UPDATE hns_root_import_lifecycle_jobs
                SET due_at=clock_timestamp() - interval '1 second'
              WHERE root_import_session_id=$1 AND state='queued'`,
            [base.sessionId],
          );
          const result = await runHnsRootImportLifecycleJobOnce("lifecycle-executor", 60, ports);
          if (result.claimed) return result;
        }
        return { claimed: false, outcome: "idle", reason: "no_due_job" } as const;
      };
      base.hsd.setRecords(base.planRecords);
      base.hsd.setSafeRecords(base.planRecords);
      const gatherer = makeProductionHnsActivationCurrentView(
        base.layer,
        enabledConfiguration(base.hsd.url),
      );

      // The owner publishes: the completion verifies ownership and records
      // the result hash the readiness performer binds to.
      base.verifyOwnerPublication();
      for (let step = 0; step < 3; step++) {
        if (
          !(await Effect.runPromise(
            continueHnsCommunityPublication(base.services, base.services.publicationQueue),
          ))
        )
          break;
      }
      expect(
        (
          await base.admin.query<{ ownership_result_sha256: string | null }>(
            "SELECT ownership_result_sha256 FROM hns_root_import_sessions WHERE root_import_session_id=$1",
            [base.sessionId],
          )
        ).rows[0]?.ownership_result_sha256,
      ).toMatch(/^[0-9a-f]{64}$/u);

      // Current observation advances to the safe-commitment wait.
      await ensureJob(base, "observe_current");
      expect(await runOne()).toMatchObject({ claimed: true, outcome: "completed" });
      expect(await phaseOf(base)).toMatchObject({ phase: "waiting_safe_commitment" });

      // Safe observation establishes the commitment and moves to authority
      // checking, scheduling the readiness observation.
      expect(await runOne()).toMatchObject({ claimed: true, outcome: "completed" });
      expect(await phaseOf(base)).toMatchObject({ phase: "checking_authority" });

      // The handover enables readiness ownership; the phase's own transition
      // already queued the readiness work, so the handover adds none.
      const handover = await base.admin.query<{ outcome: string; queued_jobs: string }>(
        "SELECT * FROM begin_hns_root_import_readiness_ownership_v1('joint-ceremony')",
      );
      expect(handover.rows[0]).toMatchObject({ outcome: "enabled", queued_jobs: "0" });

      // Readiness through the atomic writer takes the operation to ready.
      expect(await runOne()).toMatchObject({ claimed: true, outcome: "completed" });
      expect(await phaseOf(base)).toMatchObject({ phase: "ready" });

      // Stale readiness refuses activation and records one refresh hold.
      await base.admin.query(
        `UPDATE hns_root_import_lifecycle
            SET readiness_observed_at=clock_timestamp() - interval '1 hour'
          WHERE root_import_session_id=$1`,
        [base.sessionId],
      );
      expect((await activateNow(base, "ceremony-stale", gatherer)).status).toBe(409);
      expect(
        (
          await base.admin.query<{ count: number }>(
            `SELECT count(*)::integer AS count FROM hns_root_import_lifecycle_jobs
              WHERE root_import_session_id=$1 AND job_kind='observe_readiness' AND state='queued'`,
            [base.sessionId],
          )
        ).rows[0]?.count,
      ).toBe(1);
      // The refresh is the same performer, and the phase stays ready.
      expect(await runOne()).toMatchObject({ claimed: true, outcome: "completed" });
      expect(await phaseOf(base)).toMatchObject({ phase: "ready" });

      // A confirmed conflicting current control clears readiness and returns
      // the operation to publication checking; activation is refused.
      base.hsd.setRecords([{ type: "TXT", txt: ["someone-elses-resource"] }]);
      await ensureJob(base, "observe_current");
      expect(await runOne()).toMatchObject({ claimed: true, outcome: "completed" });
      expect(await phaseOf(base)).toMatchObject({ phase: "checking_publication" });
      expect((await phaseOf(base))?.readiness_observed_at).toBeNull();
      expect((await activateNow(base, "ceremony-conflict", gatherer)).status).toBe(409);

      // The publication window elapses and the performer retains authority in
      // recovery rather than tearing anything down.
      await base.admin.query(
        `UPDATE hns_root_import_lifecycle
            SET publication_deadline_at=clock_timestamp() - interval '1 second'
          WHERE root_import_session_id=$1`,
        [base.sessionId],
      );
      await ensureJob(base, "observe_current");
      expect(await runOne()).toMatchObject({ claimed: true, outcome: "completed" });
      const recovery = await phaseOf(base);
      expect(recovery).toMatchObject({ phase: "recovery_required" });
      expect(
        (
          await base.admin.query<{ count: number }>(
            `SELECT count(*)::integer AS count FROM hns_root_import_teardown_jobs
              WHERE root_import_session_id=$1 AND state <> 'waiting'`,
            [base.sessionId],
          )
        ).rows[0]?.count,
      ).toBe(0);

      // Actual adoption: the owner's replacement resource is recorded as a
      // finding, authorized, and applied, which increments the generation and
      // discards the old current, safe and readiness evidence.
      // The owner's replacement still delegates to the authority: it keeps
      // the plan's NS and DS records and changes only an unrelated TXT, which
      // is exactly the shape adoption exists for.
      const adoptedRecords: readonly HnsRootResourceRecordV1[] = [
        ...base.planRecords.filter((record) => record.type !== "TXT"),
        { type: "TXT", txt: ["owner-published-replacement"] },
      ];
      const adoptedDigest = (await preflightEncodeHnsResourceV1(adoptedRecords)).sha256;
      const finding = await base.admin.query<{ outcome: string }>(
        `SELECT * FROM record_hns_root_import_recovery_finding_v1(
           $1,$2,'ceremony-adoption','matching_authority_available','owner_published_replacement',
           'adopt',$3,812340,$4,$5,$4,$4,true,true)`,
        [
          base.sessionId,
          Number(recovery?.generation ?? 0),
          "ab".repeat(32),
          adoptedDigest,
          (
            await base.admin.query<{ plan_encoded_resource_sha256: string }>(
              `SELECT plan_encoded_resource_sha256 FROM hns_root_import_lifecycle
                WHERE root_import_session_id=$1`,
              [base.sessionId],
            )
          ).rows[0]?.plan_encoded_resource_sha256,
        ],
      );
      expect(finding.rows[0]?.outcome).toBe("recorded");
      expect(
        (
          await base.admin.query<{ outcome: string }>(
            "SELECT * FROM authorize_hns_root_import_recovery_v1($1,'ceremony-adoption','adopt',3600,86400)",
            [base.sessionId],
          )
        ).rows[0]?.outcome,
      ).toBe("recorded");
      const applied = await base.admin.query<{ outcome: string; generation: string }>(
        "SELECT * FROM apply_hns_root_import_recovery_v1($1,'ceremony-adoption',$2,'checking_publication','[]'::jsonb,86400)",
        [base.sessionId, Number(recovery?.revision ?? 0)],
      );
      expect(applied.rows[0]).toMatchObject({ outcome: "applied", generation: "2" });
      expect(await phaseOf(base)).toMatchObject({
        phase: "checking_publication",
        generation: "2",
      });
      expect((await phaseOf(base))?.readiness_observed_at).toBeNull();

      // Fresh evidence is required: the adopted resource is observed now, but
      // activation is still refused until the readiness cycle repeats.
      base.hsd.setRecords(adoptedRecords);
      base.hsd.setSafeRecords(adoptedRecords);
      expect((await activateNow(base, "ceremony-adoption-unready", gatherer)).status).toBe(409);

      await ensureJob(base, "observe_current");
      expect(await runOne()).toMatchObject({ claimed: true, outcome: "completed" });
      expect(await phaseOf(base)).toMatchObject({ phase: "waiting_safe_commitment" });
      expect(await runOne()).toMatchObject({ claimed: true, outcome: "completed" });
      expect(await phaseOf(base)).toMatchObject({ phase: "checking_authority" });
      expect(await runOne()).toMatchObject({ claimed: true, outcome: "completed" });
      expect(await phaseOf(base)).toMatchObject({ phase: "ready" });

      // HTTP activation commits against the adopted generation and replays
      // identically afterwards.
      const readySession = (await (await base.call(base.sessionUrl)).json()) as {
        revision: number;
        publish_plan_sha256: string;
        readiness_result_sha256: string;
      };
      const activated = await activateNow(base, "ceremony-activate", gatherer, readySession);
      expect(activated.status).toBe(201);
      const receipt = (await activated.json()) as Readonly<Record<string, unknown>>;
      expect(receipt).toMatchObject({ status: "activated", replayed: false });
      expect(await phaseOf(base)).toMatchObject({ phase: "activated", generation: "2" });
      const replay = await activateNow(base, "ceremony-activate", gatherer, readySession);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ ...receipt, replayed: true });
      expect(
        (
          await base.admin.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM hns_root_import_activation_operations WHERE root_import_session_id=$1",
            [base.sessionId],
          )
        ).rows[0]?.count,
      ).toBe(1);
    } finally {
      await base.cleanup();
    }
  },
  600_000,
);
