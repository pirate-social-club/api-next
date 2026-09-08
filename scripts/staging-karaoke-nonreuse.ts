import { Schema } from "effect";
import type { Client } from "pg";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";

const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/u));
export const KaraokeSqlIdentity = Schema.Struct({
  accountId: Id,
  attemptId: Id,
  identityDigest: ReconciliationDigest,
});
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Session = Schema.Struct({
  session_id: Text,
  attempt_id: Id,
  account_id: Id,
  created_at: Text,
  recording_session_id: Text,
  recording_attempt_id: Id,
  recording_account_id: Id,
  artifact_id: Text,
  recording_created_at: Text,
});
const Artifact = Schema.Struct({
  learner_audio_artifact_id: Text,
  account_id: Id,
  attempt_ref: Text,
  expected_object_ref: Text,
  object_ref: Schema.NullOr(Text),
});

/** Private immutable identity only: mutable scores and recording state are excluded.
 * The caller supplies an authenticated, independently target-bound admin connection.
 * Missing rows never initialize an authority baseline.
 */
export async function observeKaraokeSqlIdentity(
  admin: Client,
  authority: { readonly accountId: string; readonly attemptId: string },
) {
  decodeReconciliation(Id, authority.accountId);
  decodeReconciliation(Id, authority.attemptId);
  const key = `karaoke/${authority.accountId}/${authority.attemptId}.pcm`;
  try {
    await admin.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await admin.query("SET LOCAL statement_timeout='3s'");
    await admin.query("SET LOCAL timezone='UTC'");
    const sessions = await admin.query(
      `SELECT s.session_id, s.attempt_id, s.account_id,
      s.created_at::text AS created_at, r.session_id AS recording_session_id,
      r.attempt_id AS recording_attempt_id, r.account_id AS recording_account_id,
      r.artifact_id, r.created_at::text AS recording_created_at
      FROM api_next.karaoke_sessions s
      LEFT JOIN api_next.karaoke_recordings r ON r.attempt_id=s.attempt_id
      WHERE s.attempt_id=$1 LIMIT 2`,
      [authority.attemptId],
    );
    const recordings = await admin.query(
      `SELECT count(*)::int AS n
      FROM api_next.karaoke_recordings WHERE attempt_id=$1 OR object_ref=$2`,
      [authority.attemptId, key],
    );
    const artifacts = await admin.query(
      `SELECT learner_audio_artifact_id, account_id,
      attempt_ref, expected_object_ref, object_ref FROM api_next.learner_audio_artifacts
      WHERE attempt_ref=$1 OR expected_object_ref=$2 OR object_ref=$2 LIMIT 3`,
      [authority.attemptId, key],
    );
    const count = recordings.rows[0]?.n;
    if (!Number.isSafeInteger(count)) throw new Error("karaoke_sql_count_denied");
    if (sessions.rows.length === 0 && count === 0 && artifacts.rows.length === 0) {
      return { state: "absent" as const, key, observedAt: new Date().toISOString() };
    }
    if (sessions.rows.length !== 1 || count !== 1 || artifacts.rows.length > 1)
      throw new Error("karaoke_sql_identity_ambiguous");
    const row = decodeReconciliation(Session, sessions.rows[0]);
    if (
      row.account_id !== authority.accountId ||
      row.attempt_id !== authority.attemptId ||
      row.recording_session_id !== row.session_id ||
      row.recording_account_id !== row.account_id ||
      row.recording_attempt_id !== row.attempt_id
    )
      throw new Error("karaoke_sql_identity_mismatch");
    for (const value of artifacts.rows) {
      const artifact = decodeReconciliation(Artifact, value);
      if (
        artifact.account_id !== authority.accountId ||
        artifact.attempt_ref !== authority.attemptId ||
        artifact.learner_audio_artifact_id !== row.artifact_id ||
        artifact.expected_object_ref !== key ||
        (artifact.object_ref !== null && artifact.object_ref !== key)
      )
        throw new Error("karaoke_sql_artifact_mismatch");
    }
    return {
      state: "present" as const,
      key,
      identity: decodeReconciliation(KaraokeSqlIdentity, {
        ...authority,
        identityDigest: reconciliationDigest(JSON.stringify(row)),
      }),
      observedAt: new Date().toISOString(),
    };
  } catch {
    throw new Error("karaoke_sql_nonreuse_unproven");
  } finally {
    await admin.query("ROLLBACK").catch(() => {
      throw new Error("karaoke_sql_nonreuse_unproven");
    });
  }
}

/** Phase comes from the authenticated reset journal, not a caller-supplied flag. */
export function verifyKaraokeSqlNonReuse(
  baseline: typeof KaraokeSqlIdentity.Type,
  observation: Awaited<ReturnType<typeof observeKaraokeSqlIdentity>>,
  phase: "before-reset" | "after-reset",
) {
  const trusted = decodeReconciliation(KaraokeSqlIdentity, baseline);
  const key = `karaoke/${trusted.accountId}/${trusted.attemptId}.pcm`;
  if (
    observation.key !== key ||
    (phase === "after-reset"
      ? observation.state !== "absent"
      : observation.state !== "present" ||
        JSON.stringify(observation.identity) !== JSON.stringify(trusted))
  )
    throw new Error("karaoke_sql_nonreuse_unproven");
  return { keyNotReused: true as const, observedAt: observation.observedAt };
}
