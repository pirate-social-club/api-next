import { Data, Effect, Schema } from "effect";

const Identifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 512 && value === value.trim() && !value.includes("\u0000")
      ? undefined
      : "Expected a bounded identifier",
  ),
);
const ObjectRef = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 2_048 && value === value.trim() && !value.includes("\u0000")
      ? undefined
      : "Expected a bounded private object reference",
  ),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const NonNegativeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const BasisPoints = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }));

export const FrozenDanceAttemptInput = Schema.Struct({
  version: Schema.Literal("frozen-dance-attempt-input-v1"),
  attemptId: Identifier,
  sessionId: Identifier,
  inputDigest: Sha256,
  privateMediaRef: ObjectRef,
  sealedMediaSha256: Sha256,
  segmentId: Identifier,
  choreographyId: Identifier,
  choreographyRevision: PositiveInteger,
  referenceArtifactRef: ObjectRef,
  referenceArtifactSha256: Sha256,
  scoredWindowStartMs: NonNegativeInteger,
  scoredWindowEndMs: PositiveInteger,
  expectedScoredDurationMs: Schema.Int.check(Schema.isBetween({ minimum: 6_000, maximum: 30_000 })),
  policy: Schema.Struct({
    capturedAdmissionState: Schema.Literal("shadow"),
    poseModelVersion: Identifier,
    featureSchemaVersion: Identifier,
    scorerContractVersion: Identifier,
    mirrorPolicyVersion: Identifier,
    fingerprintPolicyVersion: Identifier,
    fingerprintKeyVersion: Identifier,
    integrityPolicyVersion: Identifier,
    graderAdapterVersion: Identifier,
  }),
}).check(
  Schema.makeFilter((input) =>
    input.scoredWindowEndMs - input.scoredWindowStartMs === input.expectedScoredDurationMs
      ? undefined
      : "Expected an exact frozen Dance scoring interval",
  ),
);
export type FrozenDanceAttemptInput = Schema.Schema.Type<typeof FrozenDanceAttemptInput>;

export const DanceAttemptProcessingBinding = Schema.Struct({
  version: Schema.Literal("dance-attempt-processing-binding-v1"),
  effectIdentity: Identifier,
  attemptId: Identifier,
  inputDigest: Sha256,
  attemptNumber: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  claimOwner: Identifier,
  claimFence: PositiveInteger,
});
export type DanceAttemptProcessingBinding = Schema.Schema.Type<
  typeof DanceAttemptProcessingBinding
>;

const EvidenceSummary = Schema.Struct({
  schema_version: Schema.Literal(1),
  usable_coverage_bps: BasisPoints,
  selected_mirror: Schema.Literals(["original", "mirrored"]),
  meaningful_motion_accepted: Schema.Boolean,
  replay_outcome: Schema.Literals(["unique", "duplicate", "rejected"]),
  subject_continuity: Schema.Literal("stable"),
});

const FingerprintEvidence = Schema.Struct({
  claimId: Identifier,
  policyVersion: Identifier,
  keyVersion: Identifier,
  matchScope: Schema.Literals(["same_account", "platform_wide"]),
  accountScopeId: Schema.NullOr(Identifier),
  wholeSequenceFingerprint: Sha256,
  segmentFingerprints: Schema.Array(Sha256).check(Schema.isMinLength(1)),
});

export const DanceAttemptProcessingOutcome = Schema.Struct({
  version: Schema.Literal("dance-attempt-processing-outcome-v1"),
  binding: DanceAttemptProcessingBinding,
  gradeOutcome: Schema.Literals(["scored", "rejected"]),
  qualificationOutcome: Schema.Literal("suppressed_shadow"),
  scoreBps: Schema.NullOr(BasisPoints),
  rejectionCode: Schema.NullOr(Identifier),
  scoredWindowStartMs: NonNegativeInteger,
  scoredWindowEndMs: PositiveInteger,
  scoredDurationMs: Schema.Int.check(Schema.isBetween({ minimum: 6_000, maximum: 30_000 })),
  evidenceSummary: Schema.NullOr(EvidenceSummary),
  evidenceDigest: Sha256,
  fingerprint: Schema.NullOr(FingerprintEvidence),
}).check(
  Schema.makeFilter((outcome) => {
    if (outcome.scoredWindowEndMs - outcome.scoredWindowStartMs !== outcome.scoredDurationMs) {
      return "Expected an exact Dance terminal scoring interval";
    }
    if (
      outcome.fingerprint !== null &&
      (outcome.fingerprint.matchScope === "same_account") !==
        (outcome.fingerprint.accountScopeId !== null)
    ) {
      return "Expected the Dance fingerprint scope to bind its account identity";
    }
    if (outcome.fingerprint !== null && outcome.evidenceSummary === null) {
      return "Expected fingerprinted Dance evidence to include its summary";
    }
    return outcome.gradeOutcome === "scored"
      ? outcome.scoreBps !== null &&
        outcome.rejectionCode === null &&
        outcome.evidenceSummary !== null &&
        outcome.fingerprint !== null
        ? undefined
        : "Expected scored Dance evidence"
      : outcome.scoreBps === null && outcome.rejectionCode !== null
        ? undefined
        : "Expected rejected Dance evidence";
  }),
);
export type DanceAttemptProcessingOutcome = Schema.Schema.Type<
  typeof DanceAttemptProcessingOutcome
>;

export class DanceAttemptProcessingInvalid extends Data.TaggedError(
  "DanceAttemptProcessingInvalid",
)<{
  readonly phase: "claim" | "adapter" | "outcome" | "complete" | "fail";
}> {}

export type DanceAttemptProcessingClaim = Readonly<{
  readonly frozenInput: FrozenDanceAttemptInput;
  readonly binding: DanceAttemptProcessingBinding;
}>;

export type DanceAttemptProcessingClaimResult =
  | Readonly<{ readonly kind: "claimed"; readonly claim: DanceAttemptProcessingClaim }>
  | Readonly<{ readonly kind: "busy" }>
  | Readonly<{ readonly kind: "terminal"; readonly status: "completed" | "failed" }>;

export interface DanceAttemptProcessingStore {
  readonly claim: (input: {
    readonly attemptId: string;
    readonly workerId: string;
    readonly leaseSeconds: number;
  }) => Effect.Effect<DanceAttemptProcessingClaimResult, DanceAttemptProcessingInvalid>;
  readonly complete: (
    claim: DanceAttemptProcessingClaim,
    outcome: DanceAttemptProcessingOutcome,
  ) => Effect.Effect<"committed" | "replayed" | "stale", DanceAttemptProcessingInvalid>;
  readonly fail: (input: {
    readonly claim: DanceAttemptProcessingClaim;
    readonly failureCode: string;
    readonly retryAfterSeconds: number;
  }) => Effect.Effect<"retryable" | "exhausted" | "stale", DanceAttemptProcessingInvalid>;
}

export interface DanceAttemptGraderAdapter {
  readonly grade: (
    input: FrozenDanceAttemptInput,
    binding: DanceAttemptProcessingBinding,
  ) => Effect.Effect<DanceAttemptProcessingOutcome, DanceAttemptProcessingInvalid>;
}

export type DanceAttemptProcessingDisposition =
  | Readonly<{ readonly kind: "inert" | "busy" | "stale" }>
  | Readonly<{ readonly kind: "terminal"; readonly status: "completed" | "failed" }>
  | Readonly<{
      readonly kind: "committed" | "replayed";
      readonly status: "completed" | "failed";
    }>
  | Readonly<{ readonly kind: "retryable" | "exhausted"; readonly status: "failed" }>;

function sameBinding(
  left: DanceAttemptProcessingBinding,
  right: DanceAttemptProcessingBinding,
): boolean {
  return (
    left.effectIdentity === right.effectIdentity &&
    left.attemptId === right.attemptId &&
    left.inputDigest === right.inputDigest &&
    left.attemptNumber === right.attemptNumber &&
    left.claimOwner === right.claimOwner &&
    left.claimFence === right.claimFence
  );
}

function decodeOutcome(
  claim: DanceAttemptProcessingClaim,
  value: unknown,
): Effect.Effect<DanceAttemptProcessingOutcome, DanceAttemptProcessingInvalid> {
  return Effect.try({
    try: () => {
      const outcome = Schema.decodeUnknownSync(DanceAttemptProcessingOutcome, {
        onExcessProperty: "error",
      })(value);
      const input = claim.frozenInput;
      if (
        !sameBinding(claim.binding, outcome.binding) ||
        outcome.qualificationOutcome !== "suppressed_shadow" ||
        outcome.scoredWindowStartMs !== input.scoredWindowStartMs ||
        outcome.scoredWindowEndMs !== input.scoredWindowEndMs ||
        outcome.scoredDurationMs !== input.expectedScoredDurationMs ||
        (outcome.fingerprint !== null &&
          (outcome.fingerprint.policyVersion !== input.policy.fingerprintPolicyVersion ||
            outcome.fingerprint.keyVersion !== input.policy.fingerprintKeyVersion))
      ) {
        throw new Error("binding");
      }
      return outcome;
    },
    catch: () => new DanceAttemptProcessingInvalid({ phase: "outcome" }),
  });
}

export function runDanceAttemptProcessing(
  input: {
    readonly attemptId: string;
    readonly workerId: string;
    readonly leaseSeconds: number;
    readonly retryAfterSeconds: number;
  },
  dependencies: {
    readonly store: DanceAttemptProcessingStore;
    readonly adapter: DanceAttemptGraderAdapter | null;
  },
): Effect.Effect<DanceAttemptProcessingDisposition, never> {
  if (dependencies.adapter === null) return Effect.succeed({ kind: "inert" });
  const adapter = dependencies.adapter;
  return Effect.gen(function* () {
    const claimed = yield* dependencies.store
      .claim(input)
      .pipe(Effect.catch(() => Effect.succeed({ kind: "busy" as const })));
    if (claimed.kind === "busy") return { kind: "busy" } as const;
    if (claimed.kind === "terminal") return { kind: "terminal", status: claimed.status } as const;
    const rawOutcome = yield* Effect.option(
      adapter.grade(claimed.claim.frozenInput, claimed.claim.binding),
    );
    const outcome =
      rawOutcome._tag === "Some"
        ? yield* Effect.option(decodeOutcome(claimed.claim, rawOutcome.value))
        : rawOutcome;
    if (outcome._tag === "None") {
      const failed = yield* dependencies.store
        .fail({
          claim: claimed.claim,
          failureCode: "grader_adapter_failure",
          retryAfterSeconds: input.retryAfterSeconds,
        })
        .pipe(Effect.catch(() => Effect.succeed("stale" as const)));
      return failed === "stale"
        ? ({ kind: "stale" } as const)
        : ({ kind: failed, status: "failed" } as const);
    }
    const completed = yield* dependencies.store
      .complete(claimed.claim, outcome.value)
      .pipe(Effect.catch(() => Effect.succeed("stale" as const)));
    if (completed === "stale") return { kind: "stale" } as const;
    return {
      kind: completed,
      status: "completed",
    } as const;
  });
}
