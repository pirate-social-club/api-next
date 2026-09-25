import { expect, test } from "bun:test";
import { continueHnsCommunityPublication } from "@pirate/application/namespace-ownership";
import { Cause, Effect, Option } from "effect";
import type { Client } from "pg";
import { makeHnsCommunityPublicationQueue } from "../../../packages/platform-cf/src/hns-community-publication-queue.ts";
import { makeDirectPostgresControlPlaneLayer } from "../../../packages/platform-cf/src/postgres.ts";
import { makeControlPlaneRouteAttachmentCompletionStore } from "../../../packages/platform-cf/src/route-attachment-completion-repository.ts";
import { makeProductionHnsActivationCurrentView } from "./hns-activation-current-view-composition.ts";
import {
  activate,
  enabledConfiguration,
  lifecycle,
  prepareAcknowledgedImport,
  prepareReadyImport,
} from "./hns-community-activation.pg-fixture.ts";

/**
 * The separated clocks through the real HTTP handlers, repository, provisioner
 * executables and owner verifier. The one-hour mark is crossed by moving
 * stored timestamps, never by sleeping.
 */

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;
const BUDGET_MS = 240_000;

/**
 * Moves every stored clock of a started import back past the one-hour
 * challenge: the ownership session, its start reservation and the root-import
 * session's own pre-exposure bound. Triggers are suspended only for this write.
 */
async function ageChallenge(admin: Client, hours: number): Promise<void> {
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query(
      `UPDATE community_route_attachment_namespace_sessions
          SET started_at = started_at - ($1 * interval '1 hour'),
              expires_at = expires_at - ($1 * interval '1 hour'),
              created_at = created_at - ($1 * interval '1 hour')`,
      [hours],
    );
    await admin.query(
      `UPDATE hns_root_import_sessions
          SET created_at = created_at - interval '8 days',
              expires_at = clock_timestamp() - interval '1 minute'`,
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

async function counts(admin: Client) {
  const row = (
    await admin.query<Record<string, number>>(
      `SELECT
         (SELECT count(*)::int FROM hns_community_root_import_preparations) AS preparations,
         (SELECT count(*)::int FROM community_route_attachment_intents) AS intents,
         (SELECT count(*)::int FROM community_route_attachment_completion_attempts
           WHERE state <> 'not_attempted') AS counted_attempts,
         (SELECT count(*)::int FROM community_route_attachment_completion_attempts
           WHERE state = 'not_attempted') AS not_attempted,
         (SELECT count(*)::int FROM community_route_ownership_evidence) AS evidence`,
    )
  ).rows[0];
  if (row === undefined) throw new Error("counts unavailable");
  return row;
}

async function drainPublication(
  base: Awaited<ReturnType<typeof prepareAcknowledgedImport>>,
  times: number,
) {
  for (let index = 0; index < times; index++) {
    await base.admin.query(
      "UPDATE hns_community_publication_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'",
    );
    expect(
      await Effect.runPromise(
        continueHnsCommunityPublication(base.services, base.services.publicationQueue),
      ),
    ).toBe(true);
  }
}

pgTest(
  "an exposed plan acknowledged more than an hour after the start reaches readiness and activates",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const ready = await prepareReadyImport({
      connectionString: url,
      beforeAcknowledge: async (admin) => ageChallenge(admin, 3),
    });
    try {
      // The ownership check crossed the hour under hns-txt-import-v1: one
      // attempt, verified, and nothing reported the import as expired.
      expect(await counts(ready.admin)).toMatchObject({ counted_attempts: 1, not_attempted: 0 });
      const verified = await ready.admin.query(
        "SELECT status FROM community_route_attachment_completion_observations",
      );
      expect(verified.rows).toEqual([{ status: "verified" }]);
      const authorization = await ready.admin.query(
        `SELECT source, valid_until > clock_timestamp() + interval '13 days' AS fourteen_day_window
           FROM hns_root_import_publication_authorizations WHERE root_import_session_id=$1`,
        [ready.sessionId],
      );
      expect(authorization.rows).toEqual([{ source: "plan_exposure", fourteen_day_window: true }]);
      ready.hsd.setRecords(ready.planRecords);
      const response = await activate(
        ready,
        makeProductionHnsActivationCurrentView(
          makeDirectPostgresControlPlaneLayer(ready.scopedConnectionString),
          enabledConfiguration(ready.hsd.url),
        ),
        "activate-after-hour",
      );
      expect(response.status).toBe(201);
      expect(await lifecycle(ready)).toMatchObject({ phase: "activated" });
    } finally {
      await ready.cleanup();
    }
  },
  BUDGET_MS,
);

pgTest(
  "a start cut off before its session resumes after an hour at generation two, without a new admission",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const base = await prepareAcknowledgedImport({
      connectionString: url,
      acknowledge: false,
      interruptedStart: { beforeResume: async (admin) => ageChallenge(admin, 2) },
    });
    try {
      const { admin } = base;
      // The same preparation, admission and reservation; a new ceremony.
      expect(await counts(admin)).toMatchObject({ preparations: 1, intents: 1 });
      const requirement = await admin.query(
        "SELECT status, generation::int FROM community_route_attachment_requirement_states",
      );
      expect(requirement.rows).toEqual([{ status: "pending", generation: 2 }]);
      const ceremonies = await admin.query(
        `SELECT generation::int, superseded_namespace_session_id IS NOT NULL AS superseded
           FROM hns_community_root_import_preparation_ceremonies`,
      );
      expect(ceremonies.rows).toEqual([{ generation: 2, superseded: true }]);
      const sessions = await admin.query(
        `SELECT session.ownership_generation::int AS generation,
                session.expires_at = preparation.expires_at AS preparation_bound,
                ownership.generation::int AS ownership_generation,
                ownership.expires_at > clock_timestamp() AS live_challenge
           FROM hns_root_import_sessions AS session
           JOIN hns_community_root_import_preparations AS preparation
             ON preparation.root_import_session_id = session.root_import_session_id
           JOIN community_route_attachment_namespace_sessions AS ownership
             ON ownership.namespace_session_id = session.namespace_session_id`,
      );
      expect(sessions.rows).toEqual([
        { generation: 2, preparation_bound: true, ownership_generation: 2, live_challenge: true },
      ]);

      // A late proof for the superseded generation-1 challenge is refused and
      // changes nothing.
      const superseded = (
        await admin.query<Record<string, string>>(
          `SELECT ownership.* FROM community_route_attachment_namespace_sessions AS ownership
            WHERE ownership.generation = 1`,
        )
      ).rows[0];
      if (superseded === undefined) throw new Error("generation-1 ownership session missing");
      const before = await counts(admin);
      const late = await Effect.runPromiseExit(
        base.services.completion.complete({
          actor_id: base.actor,
          community_id: base.community,
          attachment_intent_id: String(superseded.attachment_intent_id),
          ceremony_intent_id: String(superseded.ceremony_intent_id),
          session_id: String(superseded.namespace_session_id),
          expected_revision: Number(superseded.expected_revision),
          idempotency_key: "late-generation-one",
          channel: "poll_result",
        }),
      );
      const lateError =
        late._tag === "Failure" ? Cause.findErrorOption(late.cause) : Option.none<unknown>();
      expect(Option.getOrUndefined(lateError)).toMatchObject({
        _tag: "RouteAttachmentCompletionRejected",
        reason: "conflict",
      });
      expect(await counts(admin)).toEqual(before);
      expect(
        (
          await admin.query(
            "SELECT status, generation::int FROM community_route_attachment_requirement_states",
          )
        ).rows,
      ).toEqual([{ status: "pending", generation: 2 }]);

      // The generation-2 challenge then completes normally past its own hour.
      await ageChallenge(admin, 2);
      expect((await base.acknowledge()).status).toBe(202);
      base.verifyOwnerPublication();
      await drainPublication(base, 1);
      const status = (await (await base.call(base.sessionUrl)).json()) as { status: string };
      expect(status.status).toBe("observing");
    } finally {
      await base.cleanup();
    }
  },
  BUDGET_MS,
);

pgTest(
  "a fresh browser resumes the cut-off preparation with its own key and still spends no admission",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const base = await prepareAcknowledgedImport({
      connectionString: url,
      acknowledge: false,
      interruptedStart: {
        beforeResume: async (admin) => ageChallenge(admin, 2),
        resumeKey: "fresh-browser",
      },
    });
    try {
      expect(await counts(base.admin)).toMatchObject({ preparations: 1, intents: 1 });
      const generation = await base.admin.query(
        "SELECT ownership_generation::int AS generation FROM hns_root_import_sessions",
      );
      expect(generation.rows).toEqual([{ generation: 2 }]);
    } finally {
      await base.cleanup();
    }
  },
  BUDGET_MS,
);

pgTest(
  "an expired preparation gets a typed refusal, never a 500, and a new start is possible",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    let refusal: { status: number; body: unknown } | undefined;
    const base = await prepareAcknowledgedImport({
      connectionString: url,
      acknowledge: false,
      interruptedStart: {
        beforeResume: async (admin, start) => {
          await admin.query("BEGIN");
          await admin.query("SET LOCAL session_replication_role = replica");
          await admin.query(
            `UPDATE hns_community_root_import_preparations
                SET created_at = created_at - interval '8 days',
                    expires_at = clock_timestamp() - interval '1 minute'`,
          );
          await admin.query(
            `UPDATE community_route_attachment_intents
                SET created_at = created_at - interval '8 days',
                    updated_at = updated_at - interval '8 days',
                    expires_at = clock_timestamp() - interval '1 minute'`,
          );
          await admin.query("COMMIT");
          refusal = await start("start");
        },
        resumeKey: "start-again",
      },
    });
    try {
      expect(refusal).toMatchObject({
        status: 409,
        body: {
          error: {
            code: "conflict",
            retryable: false,
            details: { reason: "root_import_preparation_expired", next_action: "start_new_import" },
          },
        },
      });
      // The fresh start admitted a second preparation and retired the first parent.
      expect(await counts(base.admin)).toMatchObject({ preparations: 2, intents: 2 });
    } finally {
      await base.cleanup();
    }
  },
  BUDGET_MS,
);

pgTest(
  "the publication deadline closes checks and the lifecycle holds the import for recovery",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const base = await prepareAcknowledgedImport({ connectionString: url });
    try {
      await base.admin.query(
        `UPDATE hns_root_import_lifecycle
            SET publication_deadline_at = clock_timestamp() - interval '1 second'
          WHERE root_import_session_id=$1`,
        [base.sessionId],
      );
      await drainPublication(base, 1);
      expect(await counts(base.admin)).toMatchObject({ counted_attempts: 0, not_attempted: 0 });
      const job = await base.admin.query(
        "SELECT state, failure_code FROM hns_community_publication_jobs",
      );
      expect(job.rows).toEqual([{ state: "failed", failure_code: "publication_window_closed" }]);
      const current = await base.admin.query(
        "SELECT revision::int FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
        [base.sessionId],
      );
      // The lifecycle runner's decision for a passed publication deadline,
      // committed through the same SQL writer.
      await base.admin.query(
        `SELECT * FROM commit_hns_root_import_lifecycle_decision_v1(
           $1, $2, $3, 'deadline_reached', 'transition',
           'publication_deadline_recovery_authority_retained', 'recovery_required',
           '{"pending_reason":"publication_deadline_reached"}'::jsonb, '[]'::jsonb)`,
        [base.sessionId, current.rows[0]?.revision, `deadline_reached:publication:test`],
      );
      const projected = (await (await base.call(base.sessionUrl)).json()) as {
        status: string;
        lifecycle: { phase: string; permitted_actions: string[] };
      };
      // Held with authority retained: not reported failed or expired.
      expect(projected.status).toBe("awaiting_owner_update");
      expect(projected.lifecycle).toMatchObject({
        phase: "recovery_required",
        permitted_actions: ["poll", "recover"],
      });
      const again = await base.call(`${base.sessionUrl}/poll`, {
        expected_revision: base.revision,
        idempotency_key: "after-deadline",
      });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({
        error: {
          details: {
            reason: "publication_window_closed",
            window_reason: "recovery_required",
            next_action: "operator_recovery",
          },
        },
      });
    } finally {
      await base.cleanup();
    }
  },
  BUDGET_MS,
);

pgTest(
  "verifier outages never spend the ownership check budget",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const base = await prepareAcknowledgedImport({
      connectionString: url,
      initialObservation: "unavailable",
    });
    try {
      await drainPublication(base, 5);
      expect(await counts(base.admin)).toMatchObject({ counted_attempts: 0, not_attempted: 1 });
      const job = await base.admin.query(
        "SELECT state, failure_code FROM hns_community_publication_jobs",
      );
      expect(job.rows).toEqual([{ state: "pending", failure_code: null }]);
      expect(await lifecycle(base as never)).toMatchObject({ phase: "checking_publication" });
    } finally {
      await base.cleanup();
    }
  },
  BUDGET_MS,
);

pgTest(
  "an exhausted ownership check is held for recovery, and retirement is a real exit",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const base = await prepareAcknowledgedImport({
      connectionString: url,
      acknowledge: false,
      initialObservation: "rejected",
    });
    try {
      const { admin } = base;
      const ownership = (
        await admin.query<Record<string, string>>(
          "SELECT * FROM community_route_attachment_namespace_sessions",
        )
      ).rows[0];
      if (ownership === undefined) throw new Error("ownership session missing");
      const complete = (key: string) =>
        Effect.runPromiseExit(
          base.services.completion.complete({
            actor_id: base.actor,
            community_id: base.community,
            attachment_intent_id: String(ownership.attachment_intent_id),
            ceremony_intent_id: String(ownership.ceremony_intent_id),
            session_id: String(ownership.namespace_session_id),
            expected_revision: Number(ownership.expected_revision),
            idempotency_key: key,
            channel: "poll_result",
          }),
        );
      for (const key of ["refused-1", "refused-2", "refused-3"]) await complete(key);
      expect(await counts(admin)).toMatchObject({ counted_attempts: 3, not_attempted: 0 });
      const exhausted = await complete("refused-4");
      const error =
        exhausted._tag === "Failure" ? Cause.findErrorOption(exhausted.cause) : Option.none();
      expect(Option.getOrUndefined(error)).toMatchObject({ reason: "attempt_budget_exhausted" });
      const held = await admin.query(
        `SELECT lifecycle.phase, lifecycle.pending_reason, lifecycle.revision::int AS revision,
                finding.reason, finding.supported_action, finding.evidence_ref
           FROM hns_root_import_lifecycle AS lifecycle
           JOIN hns_root_import_recovery_findings AS finding
             ON finding.root_import_session_id = lifecycle.root_import_session_id`,
      );
      expect(held.rows).toEqual([
        expect.objectContaining({
          phase: "recovery_required",
          pending_reason: "ownership_check_attempts_exhausted",
          reason: "ownership_check_attempts_exhausted",
          supported_action: "retire",
        }),
      ]);
      const projected = (await (await base.call(base.sessionUrl)).json()) as {
        lifecycle: { phase: string; permitted_actions: string[] };
      };
      expect(projected.lifecycle).toMatchObject({
        phase: "recovery_required",
        permitted_actions: ["poll", "recover"],
      });

      // The operator's retirement: authorize the finding's action, then apply
      // it. Retirement cannot resume a phase, only end the import.
      const finding = held.rows[0] as { revision: number; evidence_ref: string };
      const authorized = await admin.query(
        "SELECT outcome FROM authorize_hns_root_import_recovery_v1($1,$2,'retire',600,3600)",
        [base.sessionId, finding.evidence_ref],
      );
      expect(authorized.rows).toEqual([{ outcome: "recorded" }]);
      const resume = await admin.query(
        `SELECT outcome FROM apply_hns_root_import_recovery_v1(
           $1,$2,$3,'checking_publication','[]'::jsonb,3600)`,
        [base.sessionId, finding.evidence_ref, finding.revision],
      );
      expect(resume.rows).toEqual([{ outcome: "retire_target_invalid" }]);
      const retired = await admin.query(
        `SELECT outcome FROM apply_hns_root_import_recovery_v1(
           $1,$2,$3,'failed',
           jsonb_build_array(jsonb_build_object('kind','retention_review',
             'due_at', clock_timestamp() + interval '7 days')),
           3600)`,
        [base.sessionId, finding.evidence_ref, finding.revision],
      );
      expect(retired.rows).toEqual([{ outcome: "applied" }]);
      const after = await admin.query(
        `SELECT lifecycle.phase,
                hns_root_import_session_clock_passed_v1(
                  session.root_import_session_id, session.expires_at, clock_timestamp()) AS released,
                EXISTS (SELECT 1 FROM hns_root_import_lifecycle_jobs AS job
                         WHERE job.root_import_session_id = session.root_import_session_id
                           AND job.job_kind = 'retention_review') AS retention_scheduled
           FROM hns_root_import_lifecycle AS lifecycle
           JOIN hns_root_import_sessions AS session
             ON session.root_import_session_id = lifecycle.root_import_session_id`,
      );
      // Retired: its clock no longer holds the root, and the retention rules
      // take over releasing its provider resources.
      expect(after.rows).toEqual([{ phase: "failed", released: true, retention_scheduled: true }]);
    } finally {
      await base.cleanup();
    }
  },
  BUDGET_MS,
);

pgTest(
  "the verifier's authorization is written with the plan and denies every binding mismatch",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const base = await prepareAcknowledgedImport({ connectionString: url, acknowledge: false });
    try {
      const { admin } = base;
      const bound = (
        await admin.query<Record<string, string>>(
          `SELECT session.actor_id, session.community_id, session.root_label,
                  session.namespace_session_id, ownership.upstream_session_ref,
                  authorization_row.challenge_value_sha256, authorization_row.publish_plan_sha256
             FROM hns_root_import_sessions AS session
             JOIN community_route_attachment_namespace_sessions AS ownership
               ON ownership.namespace_session_id = session.namespace_session_id
             JOIN hns_root_import_publication_authorizations AS authorization_row
               ON authorization_row.root_import_session_id = session.root_import_session_id`,
        )
      ).rows[0];
      if (bound === undefined) throw new Error("authorization was not written with the plan");
      const fields = [
        "actor_id",
        "community_id",
        "root_label",
        "namespace_session_id",
        "upstream_session_ref",
        "challenge_value_sha256",
        "publish_plan_sha256",
      ] as const;
      const authorize = async (values: Record<string, string>) =>
        (
          await admin.query(
            "SELECT root_import_session_id FROM authorize_hns_root_import_publication_poll_v1($1,$2,$3,$4,$5,$6,$7)",
            fields.map((field) => values[field]),
          )
        ).rows.length;
      // Accepted more than an hour after the challenge was issued.
      await ageChallenge(admin, 3);
      expect(await authorize(bound)).toBe(1);
      for (const field of fields) {
        const changed = field.endsWith("sha256")
          ? "0".repeat(64)
          : field === "root_label"
            ? "otherroot"
            : "other";
        expect({ field, rows: await authorize({ ...bound, [field]: changed }) }).toEqual({
          field,
          rows: 0,
        });
      }
      // A generation bump, as recovery adoption would make, leaves it denied.
      await admin.query(
        "UPDATE hns_root_import_lifecycle SET generation = generation + 1, revision = revision + 1",
      );
      expect(await authorize(bound)).toBe(0);
    } finally {
      await base.cleanup();
    }
    const expired = await prepareAcknowledgedImport({ connectionString: url, acknowledge: false });
    try {
      const { admin } = expired;
      const bound = (
        await admin.query<Record<string, string>>(
          `SELECT session.actor_id, session.community_id, session.root_label,
                  session.namespace_session_id, ownership.upstream_session_ref,
                  authorization_row.challenge_value_sha256, authorization_row.publish_plan_sha256
             FROM hns_root_import_sessions AS session
             JOIN community_route_attachment_namespace_sessions AS ownership
               ON ownership.namespace_session_id = session.namespace_session_id
             JOIN hns_root_import_publication_authorizations AS authorization_row
               ON authorization_row.root_import_session_id = session.root_import_session_id`,
        )
      ).rows[0];
      if (bound === undefined) throw new Error("authorization was not written with the plan");
      const authorize = async () =>
        (
          await admin.query<{ within_snapshot: boolean }>(
            `SELECT decision.valid_until <= authorization_row.valid_until AS within_snapshot
               FROM authorize_hns_root_import_publication_poll_v1($1,$2,$3,$4,$5,$6,$7) AS decision
               JOIN hns_root_import_publication_authorizations AS authorization_row
                 ON authorization_row.root_import_session_id = decision.root_import_session_id`,
            [
              bound.actor_id,
              bound.community_id,
              bound.root_label,
              bound.namespace_session_id,
              bound.upstream_session_ref,
              bound.challenge_value_sha256,
              bound.publish_plan_sha256,
            ],
          )
        ).rows;
      expect(await authorize()).toEqual([{ within_snapshot: true }]);
      // The current lifecycle deadline closes it...
      await admin.query(
        "UPDATE hns_root_import_lifecycle SET publication_deadline_at = clock_timestamp() - interval '1 second'",
      );
      expect(await authorize()).toEqual([]);
      // ...and patching it later never extends validity past the snapshot.
      await admin.query(
        "UPDATE hns_root_import_lifecycle SET publication_deadline_at = clock_timestamp() + interval '30 days'",
      );
      expect(await authorize()).toEqual([{ within_snapshot: true }]);
      await expect(
        admin.query(
          "UPDATE hns_root_import_publication_authorizations SET valid_until = clock_timestamp()",
        ),
      ).rejects.toThrow("immutable");
      // The snapshot alone closes it too, however late the live deadline is.
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        `UPDATE hns_root_import_publication_authorizations
            SET authorized_at = clock_timestamp() - interval '2 days',
                valid_until = clock_timestamp() - interval '1 second'`,
      );
      await admin.query("COMMIT");
      expect(await authorize()).toEqual([]);
    } finally {
      await expired.cleanup();
    }
  },
  BUDGET_MS,
);

/** Every grant roles.sql.example gives the runtime role for these paths. */
const RUNTIME_FUNCTION_GRANTS = [
  "commit_hns_root_import_lifecycle_decision_v1(text,bigint,text,text,text,text,text,jsonb,jsonb,bigint,bigint,bigint)",
  "renew_hns_community_root_import_challenge_v1(text,text,text,text,jsonb,text)",
  "hns_root_import_publication_window_decision_v1(text)",
  "hns_root_import_publication_window_open_v1(text)",
  "hns_root_import_publication_window_v1(text,text,text)",
  "authorize_hns_root_import_publication_poll_v1(text,text,text,text,text,text,text)",
  "hold_hns_root_import_for_recovery_v1(text,text,text)",
] as const;

pgTest(
  "acknowledgement, claim and completion run as the runtime role with only its documented grants",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const base = await prepareAcknowledgedImport({ connectionString: url, acknowledge: false });
    const role = `hns_clocks_runtime_${Date.now()}`;
    const { admin } = base;
    const schema = String((await admin.query("SELECT current_schema() AS s")).rows[0]?.s);
    try {
      await admin.query(`CREATE ROLE ${role} NOLOGIN`);
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${role}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${role}`,
      );
      await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO ${role}`);
      await admin.query(
        `REVOKE INSERT, UPDATE, DELETE ON hns_root_import_publication_authorizations,
           hns_community_root_import_preparation_ceremonies,
           hns_root_import_separated_clocks_inventory FROM ${role}`,
      );
      for (const signature of RUNTIME_FUNCTION_GRANTS) {
        await admin.query(`GRANT EXECUTE ON FUNCTION "${schema}".${signature} TO ${role}`);
      }
      const restricted = makeDirectPostgresControlPlaneLayer(
        `${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent(
          `-c search_path=${schema},pg_temp -c role=${role}`,
        )}`,
      );
      const queue = makeHnsCommunityPublicationQueue(restricted);
      const acknowledged = await Effect.runPromise(
        queue.enqueue({
          actor_id: base.actor,
          community_id: base.community,
          root_import_session_id: base.sessionId,
          expected_revision: base.revision,
          idempotency_key: "restricted-acknowledgement",
        }),
      );
      expect(acknowledged).toEqual({ kind: "queued" });
      const claim = await Effect.runPromise(queue.claim());
      expect(claim).toMatchObject({ authorized: true });
      const ownership = (
        await admin.query<Record<string, string>>(
          "SELECT * FROM community_route_attachment_namespace_sessions",
        )
      ).rows[0];
      if (ownership === undefined) throw new Error("ownership session missing");
      const store = makeControlPlaneRouteAttachmentCompletionStore(restricted);
      const request = {
        actor_id: base.actor,
        community_id: base.community,
        attachment_intent_id: String(ownership.attachment_intent_id),
        ceremony_intent_id: String(ownership.ceremony_intent_id),
        session_id: String(ownership.namespace_session_id),
        expected_revision: Number(ownership.expected_revision),
        idempotency_key: "restricted-check",
        channel: "poll_result" as const,
      };
      const loaded = await Effect.runPromise(store.load(request));
      expect(loaded?.import_publication).toMatchObject({ window_open: true, reason: "open" });
      const reserved = await Effect.runPromise(
        store.reserve({
          request,
          completion_request_sha256: "a".repeat(64),
          completion_attempt_id: "restricted-attempt",
          evidence_ref: "restricted-evidence",
          lease_ms: 16_000,
          max_attempts: 3,
        }),
      );
      expect(reserved.kind).toBe("acquired");
    } finally {
      await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      await base.cleanup();
    }
  },
  BUDGET_MS,
);
