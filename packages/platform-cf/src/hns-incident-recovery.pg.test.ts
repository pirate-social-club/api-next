import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * Recovery: recorded findings, explicit authorization, fenced application.
 *
 * These drive the three steps against PostgreSQL and concentrate on the ways
 * they must refuse. Recovery moves live authority, so the interesting cases are
 * not the happy path but the ones where something changed between reading the
 * evidence, authorizing an action, and applying it.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString ? describe : describe.skip;

/** Each case builds a schema and applies every migration. */
const BUDGET_MS = 180_000;

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const planDigest = "1".repeat(64);
const otherDigest = "2".repeat(64);
const txid = "3".repeat(64);

type Finding = Readonly<{
  evidence_ref: string;
  classification: string;
  reason: string;
  supported_action: string | null;
  inclusion?: boolean;
}>;

async function withSchema<A>(use: (admin: Client) => Promise<A>): Promise<A> {
  const schema = `hns_recovery_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    await admin.query(`SET search_path TO ${quote(schema)}`);
    for (const migration of await loadPostgresMigrations()) await admin.query(migration.sql);
    return await use(admin);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

const session = "recovery-session";

/** An operation parked in recovery, which is the only phase recovery applies from. */
async function seedRecovery(admin: Client, pendingReason = "publication_deadline_reached") {
  await admin.query(
    `INSERT INTO hns_root_import_lifecycle (
       root_import_session_id, root_label, phase, revision, generation,
       plan_exposed_at, publication_deadline_at, pending_reason,
       policy_name, policy_digest, plan_encoded_resource_sha256
     ) VALUES ($1,'recovered','recovery_required',1,1,
       clock_timestamp() - interval '20 days', clock_timestamp() - interval '6 days', $2,
       'hns_root_import_lifecycle_v1','recovery',$3)`,
    [session, pendingReason, planDigest],
  );
}

const recordFinding = (admin: Client, finding: Finding, generation = 1) =>
  admin.query<Record<string, unknown>>(
    `SELECT * FROM record_hns_root_import_recovery_finding_v1(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      session,
      generation,
      finding.evidence_ref,
      finding.classification,
      finding.reason,
      finding.supported_action,
      finding.inclusion === false ? null : txid,
      finding.inclusion === false ? null : 3_301,
      finding.inclusion === false ? null : planDigest,
      planDigest,
      "4".repeat(64),
      "5".repeat(64),
      true,
      true,
    ],
  );

const authorize = (admin: Client, evidenceRef: string, action: string, ttl = 3_600) =>
  admin.query<Record<string, unknown>>(
    "SELECT * FROM authorize_hns_root_import_recovery_v1($1,$2,$3,$4)",
    [session, evidenceRef, action, ttl],
  );

const apply = (
  admin: Client,
  evidenceRef: string,
  revision: number,
  phase = "checking_publication",
) =>
  admin.query<Record<string, unknown>>(
    "SELECT * FROM apply_hns_root_import_recovery_v1($1,$2,$3,$4,$5::jsonb)",
    [
      session,
      evidenceRef,
      revision,
      phase,
      JSON.stringify([
        { kind: "observe_current", due_at: new Date(Date.now() + 1_000).toISOString() },
      ]),
    ],
  );

const phaseOf = async (admin: Client) =>
  (
    await admin.query<Record<string, unknown>>(
      "SELECT phase, revision, generation FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
      [session],
    )
  ).rows[0];

const matching: Finding = {
  evidence_ref:
    "recovery:current:3301:aaaa:safe:3301:bbbb:inclusion:3333:0:3301:zone:present:keyed",
  classification: "matching_authority_available",
  reason: "published_resource_matches_plan",
  supported_action: "resume",
};

suite("HNS incident recovery on PostgreSQL 17", () => {
  test(
    "a publication mined after the terminal decision is recorded, authorized, and resumed once",
    async () => {
      await withSchema(async (admin) => {
        // The operation gave up on the publication window and the owner's
        // wallet broadcast afterwards. The chain now carries exactly the
        // planned resource, and the evidence says so.
        await seedRecovery(admin);
        const recorded = await recordFinding(admin, matching);
        expect(recorded.rows[0]?.outcome).toBe("recorded");

        const authorized = await authorize(admin, matching.evidence_ref, "resume");
        expect(authorized.rows[0]?.outcome).toBe("recorded");

        const applied = await apply(admin, matching.evidence_ref, 1);
        expect(applied.rows[0]?.outcome).toBe("applied");
        expect(await phaseOf(admin)).toMatchObject({
          phase: "checking_publication",
          revision: "2",
        });

        // The successor observation was requested in the same transaction, so
        // a resumed operation is actually being driven again.
        const jobs = await admin.query<Record<string, unknown>>(
          "SELECT job_kind, state FROM hns_root_import_lifecycle_jobs WHERE root_import_session_id=$1",
          [session],
        );
        expect(jobs.rows).toEqual([{ job_kind: "observe_current", state: "queued" }]);

        // Duplicate recovery: the same authorization cannot be spent twice,
        // and the operation is no longer in a phase recovery applies from.
        const second = await apply(admin, matching.evidence_ref, 2);
        expect(second.rows[0]?.outcome).toBe("phase_conflict");
      });
    },
    BUDGET_MS,
  );

  test(
    "an expired authorization is refused, and the operation stays parked",
    async () => {
      await withSchema(async (admin) => {
        await seedRecovery(admin);
        await recordFinding(admin, matching);
        await authorize(admin, matching.evidence_ref, "resume", 60);
        // Authorizations are append-only apart from being consumed, so the
        // window is closed by moving the authorization out of it rather than
        // by rewriting the row.
        await expect(
          admin.query(
            `UPDATE hns_root_import_recovery_authorizations
                SET expires_at = clock_timestamp() - interval '1 second'
              WHERE root_import_session_id = $1`,
            [session],
          ),
        ).rejects.toThrow(/append-only/u);

        await admin.query("BEGIN");
        await admin.query("SET LOCAL session_replication_role = replica");
        await admin.query(
          `ALTER TABLE hns_root_import_recovery_authorizations DISABLE TRIGGER
             hns_root_import_recovery_authorizations_change_guard`,
        );
        await admin.query(
          `UPDATE hns_root_import_recovery_authorizations
              SET authorized_at = clock_timestamp() - interval '2 hours',
                  expires_at = clock_timestamp() - interval '1 hour'
            WHERE root_import_session_id = $1`,
          [session],
        );
        await admin.query(
          `ALTER TABLE hns_root_import_recovery_authorizations ENABLE TRIGGER
             hns_root_import_recovery_authorizations_change_guard`,
        );
        await admin.query("COMMIT");

        const applied = await apply(admin, matching.evidence_ref, 1);
        expect(applied.rows[0]?.outcome).toBe("authorization_expired");
        expect(await phaseOf(admin)).toMatchObject({ phase: "recovery_required", revision: "1" });
      });
    },
    BUDGET_MS,
  );

  test(
    "missing keys support restoring the authority, and never resuming it",
    async () => {
      await withSchema(async (admin) => {
        await seedRecovery(admin);
        const missing: Finding = {
          evidence_ref: "recovery:keys-missing",
          classification: "recoverable_authority_missing",
          reason: "signing_keys_missing",
          supported_action: "restore_authority",
        };
        await recordFinding(admin, missing);
        // An operator cannot authorize an action this evidence does not
        // support, however plausible it looks.
        expect((await authorize(admin, missing.evidence_ref, "resume")).rows[0]?.outcome).toBe(
          "action_unsupported",
        );
        expect(
          (await authorize(admin, missing.evidence_ref, "restore_authority")).rows[0]?.outcome,
        ).toBe("recorded");
        expect(await phaseOf(admin)).toMatchObject({ phase: "recovery_required" });
      });
    },
    BUDGET_MS,
  );

  test(
    "a conflicting publication supports nothing, and cannot be authorized at all",
    async () => {
      await withSchema(async (admin) => {
        await seedRecovery(admin);
        const conflicting: Finding = {
          evidence_ref: "recovery:conflicting",
          classification: "conflicting_publication",
          reason: "published_resource_replaces_authority",
          supported_action: null,
        };
        expect((await recordFinding(admin, conflicting)).rows[0]?.outcome).toBe("recorded");
        for (const action of ["resume", "adopt", "restore_authority"]) {
          expect((await authorize(admin, conflicting.evidence_ref, action)).rows[0]?.outcome).toBe(
            "action_unsupported",
          );
        }
        // And the table refuses to hold a finding that claims otherwise.
        await expect(
          admin.query(
            `INSERT INTO hns_root_import_recovery_findings (
               root_import_session_id, authority_generation, evidence_ref,
               classification, reason, supported_action
             ) VALUES ($1,1,'forged','conflicting_publication','forced','resume')`,
            [session],
          ),
        ).rejects.toThrow(/hns_recovery_finding_action_shape/u);
        expect(await phaseOf(admin)).toMatchObject({ phase: "recovery_required", revision: "1" });
      });
    },
    BUDGET_MS,
  );

  test(
    "a finding replays instead of accumulating, and one finding grants one authorization",
    async () => {
      await withSchema(async (admin) => {
        await seedRecovery(admin);
        const first = await recordFinding(admin, matching);
        const again = await recordFinding(admin, matching);
        expect(again.rows[0]?.outcome).toBe("replayed");
        expect(again.rows[0]?.recovery_finding_id).toBe(first.rows[0]?.recovery_finding_id);
        expect((await authorize(admin, matching.evidence_ref, "resume")).rows[0]?.outcome).toBe(
          "recorded",
        );
        expect((await authorize(admin, matching.evidence_ref, "resume")).rows[0]?.outcome).toBe(
          "replayed",
        );
        const count = await admin.query<{ readonly count: string }>(
          `SELECT count(*)::text AS count FROM hns_root_import_recovery_authorizations
            WHERE root_import_session_id = $1`,
          [session],
        );
        expect(count.rows[0]?.count).toBe("1");
      });
    },
    BUDGET_MS,
  );

  test(
    "a supersession between authorizing and applying stops the authorization",
    async () => {
      await withSchema(async (admin) => {
        await seedRecovery(admin);
        await recordFinding(admin, matching);
        await authorize(admin, matching.evidence_ref, "resume");

        // The operation is superseded and now holds different infrastructure.
        // Nobody inspected that, so the authorization no longer applies.
        await admin.query(
          "UPDATE hns_root_import_lifecycle SET generation = 2 WHERE root_import_session_id=$1",
          [session],
        );
        const applied = await apply(admin, matching.evidence_ref, 1);
        expect(applied.rows[0]?.outcome).toBe("generation_conflict");
        expect(await phaseOf(admin)).toMatchObject({ phase: "recovery_required", revision: "1" });

        // A fresh reading against the new generation is required, and the old
        // one cannot be re-recorded against it.
        expect((await recordFinding(admin, matching, 1)).rows[0]?.outcome).toBe(
          "generation_conflict",
        );
      });
    },
    BUDGET_MS,
  );

  test(
    "a worker holding a stale lease cannot commit across an applied recovery",
    async () => {
      await withSchema(async (admin) => {
        await seedRecovery(admin);
        await recordFinding(admin, matching);
        await authorize(admin, matching.evidence_ref, "resume");
        // A worker read the operation at revision 1 and is about to commit.
        const staleRevision = 1;
        expect((await apply(admin, matching.evidence_ref, staleRevision)).rows[0]?.outcome).toBe(
          "applied",
        );
        // Its commit now carries a revision the operation has moved past, and
        // is refused as a serialization conflict rather than applied on top of
        // the recovery that just ran.
        await expect(
          admin.query(
            `SELECT * FROM commit_hns_root_import_lifecycle_decision_v1(
               $1,$2,'stale-worker-event','current_observation','transition','stale',
               'waiting_safe_commitment','{}'::jsonb,'[]'::jsonb)`,
            [session, staleRevision],
          ),
        ).rejects.toThrow(/revision conflict/u);
        // Nothing the stale worker carried reached history either.
        const history = await admin.query<{ readonly count: string }>(
          `SELECT count(*)::text AS count FROM hns_root_import_lifecycle_history
            WHERE event_id = 'stale-worker-event'`,
        );
        expect(history.rows[0]?.count).toBe("0");
        expect(await phaseOf(admin)).toMatchObject({
          phase: "checking_publication",
          revision: "2",
        });
      });
    },
    BUDGET_MS,
  );
});
