import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Data, Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

export const KARAOKE_FINALIZATION_RECOVERY_BATCH_LIMIT = 50;
export const KARAOKE_FINALIZATION_RECOVERY_BINDING_PROBE =
  "system:karaoke-finalization-recovery-binding-probe:v1";

export interface KaraokeFinalizationRecoveryCandidate {
  readonly sessionId: string;
}

export interface KaraokeFinalizationRecoveryStore {
  readonly listCandidates: (input: {
    readonly limit: number;
  }) => Effect.Effect<
    readonly KaraokeFinalizationRecoveryCandidate[],
    ControlPlaneError | KaraokeFinalizationRecoveryInvalidRow
  >;
}

export interface KaraokeFinalizationRedriveResult {
  readonly outcome: "missing" | "idle" | "scheduled";
  readonly rearmed: readonly ("score" | "recording")[];
}

export interface KaraokeFinalizationRecoveryNamespace {
  readonly getByName: (sessionId: string) => {
    readonly redriveFinalization: () => Promise<KaraokeFinalizationRedriveResult>;
  };
}

export interface KaraokeFinalizationRecoverySummary {
  readonly selected: number;
  readonly scheduled: number;
  readonly rearmed: number;
  readonly missing: number;
  readonly rpcFailures: number;
}

export class KaraokeFinalizationRecoveryInvalidRow extends Data.TaggedError(
  "KaraokeFinalizationRecoveryInvalidRow",
)<Record<never, never>> {}

export class KaraokeFinalizationRecoveryBindingProbeFailed extends Data.TaggedError(
  "KaraokeFinalizationRecoveryBindingProbeFailed",
)<Record<never, never>> {}

const positiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive`);
  return value;
};

export const makeControlPlaneKaraokeFinalizationRecoveryStore = (
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): KaraokeFinalizationRecoveryStore => ({
  listCandidates: ({ limit }) =>
    Effect.gen(function* () {
      positiveInteger(limit, "limit");
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "karaoke.finalization-recovery.candidates",
        text: `WITH expired AS (
                 SELECT session.session_id, session.expires_at AS due_at, 0 AS kind_order
                   FROM karaoke_sessions session
                  WHERE session.status='active'
                    AND session.expires_at <= clock_timestamp()
                  ORDER BY session.expires_at, session.session_id
                  LIMIT $1
               ), pending_recordings AS (
                 SELECT recording.session_id, recording.created_at AS due_at, 1 AS kind_order
                   FROM karaoke_recordings recording
                   JOIN karaoke_sessions session
                     ON session.session_id=recording.session_id
                    AND session.attempt_id=recording.attempt_id
                  WHERE session.status='completed' AND recording.state='pending'
                  ORDER BY recording.created_at, recording.session_id
                  LIMIT $1
               ), due AS (
                 SELECT * FROM expired
                 UNION ALL
                 SELECT * FROM pending_recordings
               ), candidates AS (
                 SELECT session_id, min(due_at) AS due_at, min(kind_order) AS kind_order
                   FROM due GROUP BY session_id
               )
               SELECT session_id FROM candidates
                ORDER BY due_at, kind_order, session_id
                LIMIT $1`,
        values: [limit],
        readonly: true,
      });
      const candidates: KaraokeFinalizationRecoveryCandidate[] = [];
      for (const row of result.rows) {
        if (typeof row.session_id !== "string" || row.session_id.length === 0) {
          return yield* new KaraokeFinalizationRecoveryInvalidRow();
        }
        candidates.push({ sessionId: row.session_id });
      }
      return candidates;
    }).pipe(Effect.provide(runtime)),
});

export const redriveKaraokeFinalizations = Effect.fn("redriveKaraokeFinalizations")(
  function* (input: {
    readonly store: KaraokeFinalizationRecoveryStore;
    readonly namespace: KaraokeFinalizationRecoveryNamespace;
    readonly limit?: number;
  }): Effect.fn.Return<
    KaraokeFinalizationRecoverySummary,
    | ControlPlaneError
    | KaraokeFinalizationRecoveryInvalidRow
    | KaraokeFinalizationRecoveryBindingProbeFailed
  > {
    const probe: unknown = yield* Effect.tryPromise({
      try: () =>
        input.namespace
          .getByName(KARAOKE_FINALIZATION_RECOVERY_BINDING_PROBE)
          .redriveFinalization(),
      catch: () => new KaraokeFinalizationRecoveryBindingProbeFailed(),
    });
    if (
      typeof probe !== "object" ||
      probe === null ||
      !("outcome" in probe) ||
      probe.outcome !== "missing" ||
      !("rearmed" in probe) ||
      !Array.isArray(probe.rearmed) ||
      probe.rearmed.length !== 0
    ) {
      return yield* new KaraokeFinalizationRecoveryBindingProbeFailed();
    }
    const candidates = yield* input.store.listCandidates({
      limit: input.limit ?? KARAOKE_FINALIZATION_RECOVERY_BATCH_LIMIT,
    });
    let scheduled = 0;
    let rearmed = 0;
    let missing = 0;
    let rpcFailures = 0;
    for (const candidate of candidates) {
      const result = yield* Effect.tryPromise({
        try: () => input.namespace.getByName(candidate.sessionId).redriveFinalization(),
        catch: () => null,
      }).pipe(Effect.catch(() => Effect.succeed(null)));
      if (result === null) {
        rpcFailures += 1;
      } else if (result.outcome === "missing") {
        missing += 1;
      } else {
        if (result.outcome === "scheduled") scheduled += 1;
        rearmed += result.rearmed.length;
      }
    }
    return {
      selected: candidates.length,
      scheduled,
      rearmed,
      missing,
      rpcFailures,
    };
  },
);
