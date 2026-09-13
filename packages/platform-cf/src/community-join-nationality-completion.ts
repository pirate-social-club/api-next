import type { ControlPlaneError, ControlPlaneTransaction } from "@pirate/application";
import { VerificationCompletionStorageFailed } from "@pirate/application/verification";
import { Effect } from "effect";

type Row = Readonly<Record<string, unknown>>;

export type CommunityJoinNationalityAdvanceOutcome = "advanced" | "stale" | "not_applicable";

function storageFailure(): VerificationCompletionStorageFailed {
  return new VerificationCompletionStorageFailed();
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function asTimestamp(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function oneRow(rows: readonly Row[]): Row | null | undefined {
  if (rows.length > 1) return undefined;
  return rows[0] ?? null;
}

/**
 * Satisfies the joiner's nationality requirement when a generic verification
 * session for a `community_join` nationality attempt completes. The write
 * matches the exact actor, child intent, requirement, and current attempt; a
 * superseded generation, a foreign actor, a different action kind, or a
 * non-pending state grants nothing and leaves the requirement untouched.
 * Membership is never written here: the user re-fetches eligibility and joins
 * explicitly, and the join transaction re-evaluates the account evidence.
 */
export function advanceCommunityJoinNationalityVerificationInTransaction(
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly actor_id: string;
    readonly proof_session_id: string;
    readonly result_hash: string;
  }>,
): Effect.Effect<
  CommunityJoinNationalityAdvanceOutcome,
  VerificationCompletionStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    const sessionResult = yield* transaction.execute<Row>({
      label: "community.join.nationality.lock-session",
      text: `SELECT proof_session_id, actor_id, intent_id, status, expires_at,
                    completed_at, terminal_at, completion_idempotency_key,
                    completion_result_hash, creation_ceremony_intent_id
               FROM proof_sessions
              WHERE proof_session_id = $1 AND actor_id = $2
              FOR UPDATE`,
      values: [input.proof_session_id, input.actor_id],
      readonly: false,
    });
    const session = oneRow(sessionResult.rows);
    if (session === undefined) return yield* Effect.fail(storageFailure());
    if (session === null) return "not_applicable" as const;

    const sessionIntentId = asString(session.intent_id);
    const creationCeremonyId = asString(session.creation_ceremony_intent_id);
    if (sessionIntentId === null || creationCeremonyId !== null) {
      return "not_applicable" as const;
    }

    const attemptResult = yield* transaction.execute<Row>({
      label: "community.join.nationality.lock-attempt",
      text: `SELECT attempt.ceremony_intent_id,
                    attempt.actor_id,
                    attempt.intent_id,
                    attempt.generation,
                    attempt.provider_id,
                    attempt.expires_at,
                    state.status AS requirement_status,
                    state.generation AS requirement_generation,
                    state.current_ceremony_intent_id
               FROM nationality_ceremony_attempts AS attempt
               JOIN nationality_requirement_states AS state
                 ON state.action_kind = attempt.action_kind
                AND state.intent_id = attempt.intent_id
                AND state.requirement_kind = attempt.requirement_kind
              WHERE attempt.ceremony_intent_id = $1
                AND attempt.actor_id = $2
                AND attempt.action_kind = 'community_join'
                AND attempt.requirement_kind = 'nationality'
              FOR UPDATE OF attempt, state`,
      values: [sessionIntentId, input.actor_id],
      readonly: false,
    });
    const attempt = oneRow(attemptResult.rows);
    if (attempt === null) return "not_applicable" as const;
    if (attempt === undefined) return yield* Effect.fail(storageFailure());

    const attemptGeneration = asInteger(attempt.generation);
    const stateGeneration = asInteger(attempt.requirement_generation);
    const completedAt = asTimestamp(session.completed_at);
    const terminalAt = asTimestamp(session.terminal_at);
    const sessionExpiresAt = asTimestamp(session.expires_at);
    if (
      attemptGeneration === null ||
      stateGeneration === null ||
      completedAt === null ||
      terminalAt === null ||
      sessionExpiresAt === null ||
      attemptGeneration <= 0 ||
      session.status !== "completed" ||
      asString(session.completion_result_hash) !== input.result_hash ||
      asString(session.completion_idempotency_key) === null ||
      completedAt !== terminalAt ||
      Date.parse(completedAt) >= Date.parse(sessionExpiresAt) ||
      attemptGeneration !== stateGeneration ||
      asString(attempt.current_ceremony_intent_id) !== sessionIntentId ||
      attempt.requirement_status !== "pending"
    ) {
      return "stale" as const;
    }

    const intentId = asString(attempt.intent_id);
    if (intentId === null) return yield* Effect.fail(storageFailure());
    const satisfied = yield* transaction.execute({
      label: "community.join.nationality.satisfy-requirement",
      text: `UPDATE nationality_requirement_states
                SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
              WHERE action_kind = 'community_join' AND intent_id = $2
                AND requirement_kind = 'nationality' AND actor_id = $3
                AND status = 'pending' AND generation = $4
                AND current_ceremony_intent_id = $5`,
      values: [completedAt, intentId, input.actor_id, attemptGeneration, sessionIntentId],
      readonly: false,
    });
    if (satisfied.rowCount !== 1) {
      return yield* Effect.fail(storageFailure());
    }
    return "advanced" as const;
  });
}
