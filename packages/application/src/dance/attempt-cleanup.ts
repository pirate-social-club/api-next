import { Data, Effect, Schema } from "effect";

const Identifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 512 && value === value.trim() && !value.includes("\u0000")
      ? undefined
      : "Expected a bounded identifier",
  ),
);
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

export const DanceAttemptCleanupBinding = Schema.Struct({
  version: Schema.Literal("dance-attempt-cleanup-binding-v1"),
  cleanupOperationId: Identifier,
  sessionId: Identifier,
  artifactKind: Schema.Literals([
    "raw_video",
    "extracted_audio",
    "extracted_frames",
    "provider_payload",
  ]),
  privateArtifactRef: Identifier,
  attemptNumber: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  claimOwner: Identifier,
  claimFence: PositiveInteger,
});
export type DanceAttemptCleanupBinding = Schema.Schema.Type<typeof DanceAttemptCleanupBinding>;

export type DanceAttemptCleanupClaimResult =
  | Readonly<{ readonly kind: "claimed"; readonly binding: DanceAttemptCleanupBinding }>
  | Readonly<{ readonly kind: "busy" }>
  | Readonly<{ readonly kind: "terminal"; readonly status: "completed" | "exhausted" }>;

export class DanceAttemptCleanupInvalid extends Data.TaggedError("DanceAttemptCleanupInvalid")<{
  readonly phase: "claim" | "delete" | "complete" | "fail";
}> {}

export interface DanceAttemptCleanupStore {
  readonly claim: (input: {
    readonly cleanupOperationId: string;
    readonly workerId: string;
    readonly leaseSeconds: number;
  }) => Effect.Effect<DanceAttemptCleanupClaimResult, DanceAttemptCleanupInvalid>;
  readonly complete: (
    binding: DanceAttemptCleanupBinding,
  ) => Effect.Effect<"committed" | "replayed" | "stale", DanceAttemptCleanupInvalid>;
  readonly fail: (input: {
    readonly binding: DanceAttemptCleanupBinding;
    readonly failureCode: string;
    readonly retryAfterSeconds: number;
  }) => Effect.Effect<"retryable" | "exhausted" | "stale", DanceAttemptCleanupInvalid>;
}

export interface DanceAttemptArtifactDeleter {
  readonly deletePrivateArtifact: (
    binding: DanceAttemptCleanupBinding,
  ) => Effect.Effect<"deleted" | "already_absent", DanceAttemptCleanupInvalid>;
}

export type DanceAttemptCleanupDisposition =
  | Readonly<{ readonly kind: "inert" | "busy" | "stale" }>
  | Readonly<{ readonly kind: "terminal"; readonly status: "completed" | "exhausted" }>
  | Readonly<{ readonly kind: "committed" | "replayed"; readonly status: "completed" }>
  | Readonly<{ readonly kind: "retryable" | "exhausted"; readonly status: "failed" }>;

export function runDanceAttemptCleanup(
  input: {
    readonly cleanupOperationId: string;
    readonly workerId: string;
    readonly leaseSeconds: number;
    readonly retryAfterSeconds: number;
  },
  dependencies: {
    readonly store: DanceAttemptCleanupStore;
    readonly deleter: DanceAttemptArtifactDeleter | null;
  },
): Effect.Effect<DanceAttemptCleanupDisposition, never> {
  if (dependencies.deleter === null) return Effect.succeed({ kind: "inert" });
  const deleter = dependencies.deleter;
  return Effect.gen(function* () {
    const claim = yield* dependencies.store
      .claim(input)
      .pipe(Effect.catch(() => Effect.succeed({ kind: "busy" as const })));
    if (claim.kind === "busy") return { kind: "busy" } as const;
    if (claim.kind === "terminal") return { kind: "terminal", status: claim.status } as const;
    const deletion = yield* Effect.option(deleter.deletePrivateArtifact(claim.binding));
    if (deletion._tag === "None") {
      const failed = yield* dependencies.store
        .fail({
          binding: claim.binding,
          failureCode: "private_artifact_delete_failed",
          retryAfterSeconds: input.retryAfterSeconds,
        })
        .pipe(Effect.catch(() => Effect.succeed("stale" as const)));
      return failed === "stale"
        ? ({ kind: "stale" } as const)
        : ({ kind: failed, status: "failed" } as const);
    }
    const completed = yield* dependencies.store
      .complete(claim.binding)
      .pipe(Effect.catch(() => Effect.succeed("stale" as const)));
    return completed === "stale"
      ? ({ kind: "stale" } as const)
      : ({ kind: completed, status: "completed" } as const);
  });
}
