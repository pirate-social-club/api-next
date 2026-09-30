import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { continueHnsCommunityPublication } from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
import { Effect } from "effect";
import { runHnsRootImportLifecycleJobOnce } from "../../hns-authority-provisioner/src/lifecycle-executor.ts";
import {
  HnsLifecycleReadinessContextError,
  runHnsRootImportReadinessOnce,
} from "../../hns-authority-provisioner/src/lifecycle-readiness.ts";
import { observeProvisionalSafeOwnership } from "../../hns-authority-provisioner/src/provisional-safe-ownership.ts";
import {
  type AcknowledgedImport,
  lifecyclePortsFor,
  prepareAcknowledgedImport,
} from "./hns-community-activation.pg-fixture.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;

pgTest(
  "safe ownership writer fences bad bindings and records invalid context on the real lease",
  async () => {
    if (!url) throw new Error("Postgres required");
    const base = await prepareAcknowledgedImport({ connectionString: url, acknowledge: false });
    try {
      base.hsd.setRecords(base.planRecords);
      const { ports, observeSafe } = lifecyclePortsFor(base);
      for (const kind of ["observe_current", "observe_safe"]) {
        await due(base, kind);
        expect(await runHnsRootImportLifecycleJobOnce("fence-executor", 60, ports)).toMatchObject({
          outcome: "completed",
        });
      }
      await due(base, "observe_readiness");
      const job = await ports.claim("fence-executor", 60);
      if (!job) throw new Error("expected readiness lease");
      const state = (
        await base.admin.query(
          `SELECT s.namespace_session_id,s.root_label,s.challenge_txt_value,
      l.revision,l.generation,l.plan_encoded_resource_sha256
      FROM hns_root_import_sessions s JOIN hns_root_import_lifecycle l USING(root_import_session_id)
      WHERE s.root_import_session_id=$1`,
          [base.sessionId],
        )
      ).rows[0];
      const artifact = await observeProvisionalSafeOwnership(
        {
          root_import_session_id: base.sessionId,
          namespace_session_id: state.namespace_session_id,
          root_label: state.root_label,
          challenge_txt_value: state.challenge_txt_value,
          publish_plan_sha256: base.publishPlanSha256,
          plan_encoded_resource_sha256: state.plan_encoded_resource_sha256,
          lifecycle_revision: Number(state.revision),
          generation: Number(state.generation),
        },
        observeSafe,
      );
      const proof = JSON.parse(new TextDecoder().decode(artifact.proof_bytes));
      const enqueue = async (changed: typeof proof, fence = job.lease_fence) => {
        const bytes = Buffer.from(canonicalJson(changed));
        return (
          await base.admin.query(
            "SELECT * FROM enqueue_hns_safe_ownership_completion_v1($1,$2,$3,$4,$5,$6)",
            [
              base.sessionId,
              job.lifecycle_job_id,
              "fence-executor",
              fence,
              bytes,
              createHash("sha256").update(bytes).digest("hex"),
            ],
          )
        ).rows[0]?.outcome;
      };
      expect(await enqueue(proof, job.lease_fence + 1)).toBe("lease_conflict");
      await base.admin.query(
        "UPDATE hns_root_import_lifecycle_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE lifecycle_job_id=$1",
        [job.lifecycle_job_id],
      );
      expect(await enqueue(proof)).toBe("lease_conflict");
      await base.admin.query(
        "UPDATE hns_root_import_lifecycle_jobs SET lease_expires_at=clock_timestamp()+interval '60 seconds',generation=generation+1 WHERE lifecycle_job_id=$1",
        [job.lifecycle_job_id],
      );
      expect(await enqueue(proof)).toBe("lease_conflict");
      await base.admin.query(
        "UPDATE hns_root_import_lifecycle_jobs SET generation=generation-1 WHERE lifecycle_job_id=$1",
        [job.lifecycle_job_id],
      );
      for (const change of [
        { root_label: "foreignroot" },
        { namespace_session_id: "foreign-session" },
        { publish_plan_sha256: "f".repeat(64) },
        { generation: Number(state.generation) + 1 },
        { lifecycle_revision: Number(state.revision) + 1 },
        { observation: { ...proof.observation, view: "current" } },
        { observation: { ...proof.observation, observed_at_epoch_ms: Date.now() - 900_001 } },
        {
          observation: {
            ...proof.observation,
            records: [{ type: "TXT", txt: ["pirate-verification=other"] }],
          },
        },
      ])
        expect(await enqueue({ ...proof, ...change })).toBe("invalid_proof");
      expect(
        (await base.admin.query("SELECT * FROM hns_root_import_safe_ownership_proofs")).rows,
      ).toHaveLength(0);
      expect(
        (await base.admin.query("SELECT * FROM hns_community_publication_jobs")).rows,
      ).toHaveLength(0);
      expect(
        await runHnsRootImportReadinessOnce(job, "fence-executor", {
          context: async () => {
            throw new HnsLifecycleReadinessContextError();
          },
          config: { environment: "staging", valid_for_seconds: 3600 },
          observe: {} as never,
          record: async () => {
            throw new Error("invalid context must not record readiness");
          },
          finalize: ports.finalize,
          now_epoch_ms: Date.now,
        }),
      ).toEqual({ outcome: "failed", reason: "readiness_context_invalid" });
      expect(
        (
          await base.admin.query(
            `SELECT state,failure_code,leased_by,lease_expires_at
      FROM hns_root_import_lifecycle_jobs WHERE lifecycle_job_id=$1`,
            [job.lifecycle_job_id],
          )
        ).rows[0],
      ).toEqual({
        state: "failed",
        failure_code: "readiness_context_invalid",
        leased_by: null,
        lease_expires_at: null,
      });
      expect(await ports.claim("fence-executor", 60)).toBeNull();
    } finally {
      await base.cleanup();
    }
  },
  180_000,
);

async function due(base: AcknowledgedImport, kind: string) {
  const changed = await base.admin.query(
    `UPDATE hns_root_import_lifecycle_jobs
    SET due_at=clock_timestamp()-interval '1 second'
    WHERE root_import_session_id=$1 AND job_kind=$2 AND state='queued' RETURNING lifecycle_job_id`,
    [base.sessionId, kind],
  );
  expect(changed.rows).toHaveLength(1);
}

pgTest(
  "no-signature import retains safe control and real namespace ownership before readiness",
  async () => {
    if (!url) throw new Error("Postgres required");
    const base = await prepareAcknowledgedImport({ connectionString: url, acknowledge: false });
    try {
      const initial = await base.admin.query(
        `SELECT provision_authorization_kind,ownership_result_sha256
      FROM hns_root_import_sessions WHERE root_import_session_id=$1`,
        [base.sessionId],
      );
      expect(initial.rows[0]).toEqual({
        provision_authorization_kind: "community_provisional",
        ownership_result_sha256: null,
      });
      expect(
        (await base.admin.query("SELECT * FROM hns_community_publication_jobs")).rows,
      ).toHaveLength(0);
      base.hsd.setRecords(base.planRecords);
      const { ports } = lifecyclePortsFor(base);
      for (const kind of ["observe_current", "observe_safe"]) {
        await due(base, kind);
        expect(await runHnsRootImportLifecycleJobOnce("proof-executor", 60, ports)).toMatchObject({
          outcome: "completed",
        });
      }
      expect(
        (
          await base.admin.query(
            "SELECT phase FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
            [base.sessionId],
          )
        ).rows[0]?.phase,
      ).toBe("checking_authority");
      await due(base, "observe_readiness");
      expect(await runHnsRootImportLifecycleJobOnce("proof-executor", 60, ports)).toMatchObject({
        outcome: "retry",
        reason: "readiness_ownership_pending",
      });
      expect(
        (
          await base.admin.query(
            "SELECT * FROM hns_root_import_safe_ownership_proofs WHERE root_import_session_id=$1",
            [base.sessionId],
          )
        ).rows,
      ).toHaveLength(1);
      const retainedQueue = (
        await base.admin.query("SELECT idempotency_key FROM hns_community_publication_jobs")
      ).rows;
      expect(retainedQueue).toHaveLength(1);
      await due(base, "observe_readiness");
      expect(await runHnsRootImportLifecycleJobOnce("proof-executor", 60, ports)).toMatchObject({
        outcome: "retry",
        reason: "readiness_ownership_pending",
      });
      expect(
        (await base.admin.query("SELECT idempotency_key FROM hns_community_publication_jobs")).rows,
      ).toEqual(retainedQueue);
      expect(
        (await base.admin.query("SELECT * FROM hns_root_import_safe_ownership_proofs")).rows,
      ).toHaveLength(1);
      base.verifyOwnerPublication();
      expect(
        await Effect.runPromise(
          continueHnsCommunityPublication(base.services, base.services.publicationQueue),
        ),
      ).toBe(true);
      const owned = await base.admin.query(
        "SELECT status,ownership_result_sha256 FROM hns_root_import_sessions WHERE root_import_session_id=$1",
        [base.sessionId],
      );
      expect(owned.rows[0]?.status).toBe("observing");
      expect(owned.rows[0]?.ownership_result_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(
        (
          await base.admin.query(
            "SELECT evidence_ref FROM community_route_ownership_evidence WHERE root_label='harbor'",
          )
        ).rows,
      ).toHaveLength(1);
      await due(base, "observe_readiness");
      expect(await runHnsRootImportLifecycleJobOnce("proof-executor", 60, ports)).toMatchObject({
        outcome: "completed",
        reason: "readiness_ready",
      });
      expect(
        (
          await base.admin.query(
            "SELECT status FROM hns_root_import_sessions WHERE root_import_session_id=$1",
            [base.sessionId],
          )
        ).rows[0]?.status,
      ).toBe("ready");
      expect(
        (
          await base.admin.query(
            "SELECT count(*)::int AS count FROM hns_root_import_activation_operations",
          )
        ).rows[0]?.count,
      ).toBe(0);
    } finally {
      await base.cleanup();
    }
  },
  180_000,
);
