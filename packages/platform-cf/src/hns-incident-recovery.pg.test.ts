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

const FRESHNESS_SECONDS = 3_600;

const authorize = (
  admin: Client,
  evidenceRef: string,
  action: string,
  ttl = 3_600,
  freshness = FRESHNESS_SECONDS,
) =>
  admin.query<Record<string, unknown>>(
    "SELECT * FROM authorize_hns_root_import_recovery_v1($1,$2,$3,$4,$5)",
    [session, evidenceRef, action, ttl, freshness],
  );

const apply = (
  admin: Client,
  evidenceRef: string,
  revision: number,
  phase = "checking_publication",
  freshness = FRESHNESS_SECONDS,
) =>
  admin.query<Record<string, unknown>>(
    "SELECT * FROM apply_hns_root_import_recovery_v1($1,$2,$3,$4,$5::jsonb,$6)",
    [
      session,
      evidenceRef,
      revision,
      phase,
      JSON.stringify([
        { kind: "observe_current", due_at: new Date(Date.now() + 1_000).toISOString() },
      ]),
      freshness,
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
    "stale evidence is refused when authorizing and again when applying",
    async () => {
      await withSchema(async (admin) => {
        await seedRecovery(admin);
        await recordFinding(admin, matching);
        // The generation only moves on supersession, so it says nothing about
        // what the owner did to their own name since the reading. A one-minute
        // bound and a reading older than that is refused outright.
        await admin.query("SELECT pg_sleep(1.2)");
        expect(
          (await authorize(admin, matching.evidence_ref, "resume", 3_600, 60)).rows[0]?.outcome,
        ).toBe("recorded");
        // Authorized inside the bound, applied outside it: permission was
        // granted at one moment and is being used at another, so the reading's
        // age is checked again here.
        const applied = await apply(admin, matching.evidence_ref, 1, "checking_publication", 60);
        expect(applied.rows[0]?.outcome).toBe("applied");
        const stale = await withSchema(async (second) => {
          await seedRecovery(second);
          await recordFinding(second, matching);
          await authorize(second, matching.evidence_ref, "resume", 3_600, 3_600);
          await second.query("SELECT pg_sleep(1.2)");
          return apply(second, matching.evidence_ref, 1, "checking_publication", 1);
        });
        expect(stale.rows[0]?.outcome).toBe("evidence_stale");
      });
    },
    BUDGET_MS,
  );

  test(
    "a refused transition leaves the operator's single-use authorization unspent",
    async () => {
      await withSchema(async (admin) => {
        await seedRecovery(admin);
        await recordFinding(admin, matching);
        await authorize(admin, matching.evidence_ref, "resume");
        // `activated` is not a permitted successor of recovery. The commit
        // function raises, so the statement rolls back; nothing moves and the
        // operator's single-use authorization is not spent.
        await expect(apply(admin, matching.evidence_ref, 1, "activated")).rejects.toThrow(
          /transition not permitted: recovery_required -> activated/u,
        );
        expect(await phaseOf(admin)).toMatchObject({ phase: "recovery_required", revision: "1" });
        const unspent = await admin.query<Record<string, unknown>>(
          `SELECT consumed_at FROM hns_root_import_recovery_authorizations
            WHERE root_import_session_id = $1`,
          [session],
        );
        expect(unspent.rows[0]?.consumed_at).toBeNull();
        // And the same authorization still works for a phase that is permitted.
        expect((await apply(admin, matching.evidence_ref, 1)).rows[0]?.outcome).toBe("applied");
      });
    },
    BUDGET_MS,
  );

  test(
    "adoption binds the operation to the published resource and demands fresh evidence",
    async () => {
      await withSchema(async (admin) => {
        await seedRecovery(admin);
        // The operation has already anchored finality and been made ready
        // against the plan it was created with.
        await admin.query(
          `UPDATE hns_root_import_lifecycle
              SET first_current_observation_at = clock_timestamp() - interval '3 days',
                  finality_deadline_at = clock_timestamp() - interval '2 days',
                  readiness_observed_at = clock_timestamp() - interval '2 days'
            WHERE root_import_session_id = $1`,
          [session],
        );
        // Within the generation the plan digest cannot be rewritten at all.
        await expect(
          admin.query(
            `UPDATE hns_root_import_lifecycle SET plan_encoded_resource_sha256 = $2
              WHERE root_import_session_id = $1`,
            [session, otherDigest],
          ),
        ).rejects.toThrow(/plan digest is immutable/u);

        const adopted: Finding = {
          evidence_ref: "recovery:adopt-published",
          classification: "matching_authority_available",
          reason: "published_resource_references_authority",
          supported_action: "adopt",
        };
        // The finding attributes the published bytes to a transaction; those
        // bytes, and nothing the caller supplies, are what adoption binds to.
        await admin.query<Record<string, unknown>>(
          `SELECT * FROM record_hns_root_import_recovery_finding_v1(
             $1,1,$2,'matching_authority_available','published_resource_references_authority',
             'adopt',$3,3301,$4,$5,NULL,NULL,true,true)`,
          [session, adopted.evidence_ref, txid, otherDigest, planDigest],
        );
        await authorize(admin, adopted.evidence_ref, "adopt");

        // Every phase after checking asserts evidence adoption discards.
        expect(
          (await apply(admin, adopted.evidence_ref, 1, "checking_authority")).rows[0]?.outcome,
        ).toBe("adoption_target_invalid");

        const applied = await apply(admin, adopted.evidence_ref, 1, "checking_publication");
        expect(applied.rows[0]?.outcome).toBe("applied");
        const row = await admin.query<Record<string, unknown>>(
          `SELECT phase, revision, generation, plan_encoded_resource_sha256,
                  first_current_observation_at, finality_deadline_at, readiness_observed_at,
                  plan_exposed_at, publication_deadline_at
             FROM hns_root_import_lifecycle WHERE root_import_session_id = $1`,
          [session],
        );
        const state = row.rows[0];
        // Bound to what is published, on a new generation.
        expect(state?.plan_encoded_resource_sha256).toBe(otherDigest);
        expect(state?.generation).toBe("2");
        expect(state?.phase).toBe("checking_publication");
        // Fresh safe-view and readiness evidence are required again: the old
        // anchor, its deadline and the readiness it produced are all gone.
        expect(state?.first_current_observation_at).toBeNull();
        expect(state?.finality_deadline_at).toBeNull();
        expect(state?.readiness_observed_at).toBeNull();
        // The exposure record is not rewritten. Adoption changes what the
        // operation is measured against, not the history of what was issued.
        expect(state?.plan_exposed_at).not.toBeNull();
        expect(state?.publication_deadline_at).not.toBeNull();

        // On the new generation the digest is immutable again, and evidence
        // recorded against the old generation no longer applies.
        await expect(
          admin.query(
            `UPDATE hns_root_import_lifecycle SET plan_encoded_resource_sha256 = $2
              WHERE root_import_session_id = $1`,
            [session, planDigest],
          ),
        ).rejects.toThrow(/plan digest is immutable/u);
        expect((await recordFinding(admin, matching, 1)).rows[0]?.outcome).toBe(
          "generation_conflict",
        );
        // And a generation never moves backwards.
        await expect(
          admin.query(
            "UPDATE hns_root_import_lifecycle SET generation = 1 WHERE root_import_session_id = $1",
            [session],
          ),
        ).rejects.toThrow(/generation never decreases/u);
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
