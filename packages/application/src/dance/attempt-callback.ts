import { Data, Effect, Schema } from "effect";
import {
  type DanceAttemptProcessingBinding,
  type DanceAttemptProcessingClaim,
  type DanceAttemptProcessingInvalid,
  DanceAttemptProcessingOutcome,
  type DanceAttemptProcessingStore,
  validateDanceAttemptProcessingOutcome,
} from "./attempt-processing.ts";

const Identifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 512 && value === value.trim() && !value.includes("\u0000")
      ? undefined
      : "Expected a bounded identifier",
  ),
);
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

export const DANCE_ATTEMPT_CALLBACK_KEY_VERSION_HEADER =
  "x-pirate-dance-callback-key-version" as const;
export const DANCE_ATTEMPT_CALLBACK_TIMESTAMP_HEADER = "x-pirate-dance-callback-timestamp" as const;
export const DANCE_ATTEMPT_CALLBACK_SIGNATURE_HEADER = "x-pirate-dance-callback-signature" as const;

export const DanceAttemptCallbackPayload = Schema.Struct({
  version: Schema.Literal("dance-attempt-callback-v1"),
  operationIdentity: Identifier,
  attemptId: Identifier,
  inputDigest: Sha256,
  outcome: DanceAttemptProcessingOutcome,
});
export type DanceAttemptCallbackPayload = Schema.Schema.Type<typeof DanceAttemptCallbackPayload>;

export class DanceAttemptCallbackInvalid extends Data.TaggedError("DanceAttemptCallbackInvalid")<{
  readonly phase: "authentication" | "payload" | "binding" | "complete";
}> {}

export interface DanceAttemptCallbackAuthenticator {
  readonly verify: (input: {
    readonly keyVersion: string;
    readonly timestamp: string;
    readonly signature: string;
    readonly rawBody: Uint8Array;
  }) => Promise<boolean>;
}

export interface DanceAttemptCallbackClaimStore {
  readonly resolveCallbackClaim: (
    binding: DanceAttemptProcessingBinding,
  ) => Effect.Effect<DanceAttemptProcessingClaim | null, DanceAttemptProcessingInvalid>;
}

export type DanceAttemptCallbackDisposition =
  | Readonly<{ readonly kind: "committed" | "replayed" | "conflict" }>
  | Readonly<{
      readonly kind: "rejected";
      readonly reason: "authentication" | "payload" | "binding" | "stale";
    }>;

export function danceAttemptCallbackSigningBytes(input: {
  readonly keyVersion: string;
  readonly timestamp: string;
  readonly rawBody: Uint8Array;
}): Uint8Array {
  const prefix = new TextEncoder().encode(
    `dance-attempt-callback-v1\n${input.keyVersion}\n${input.timestamp}\n`,
  );
  const signed = new Uint8Array(prefix.length + input.rawBody.length);
  signed.set(prefix);
  signed.set(input.rawBody, prefix.length);
  return signed;
}

export function acceptDanceAttemptCallback(
  input: {
    readonly keyVersion: string;
    readonly timestamp: string;
    readonly signature: string;
    readonly rawBody: Uint8Array;
  },
  dependencies: {
    readonly authenticator: DanceAttemptCallbackAuthenticator;
    readonly store: DanceAttemptProcessingStore & DanceAttemptCallbackClaimStore;
  },
): Effect.Effect<DanceAttemptCallbackDisposition, never> {
  return Effect.gen(function* () {
    const authenticated = yield* Effect.tryPromise({
      try: () => dependencies.authenticator.verify(input),
      catch: () => new DanceAttemptCallbackInvalid({ phase: "authentication" }),
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    if (!authenticated) return { kind: "rejected", reason: "authentication" } as const;

    const payload = yield* Effect.try({
      try: () => {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(input.rawBody);
        return Schema.decodeUnknownSync(DanceAttemptCallbackPayload, {
          onExcessProperty: "error",
        })(JSON.parse(text) as unknown);
      },
      catch: () => new DanceAttemptCallbackInvalid({ phase: "payload" }),
    }).pipe(Effect.option);
    if (payload._tag === "None") return { kind: "rejected", reason: "payload" } as const;

    const callback = payload.value;
    const binding = callback.outcome.binding;
    if (
      callback.operationIdentity !== binding.effectIdentity ||
      callback.attemptId !== binding.attemptId ||
      callback.inputDigest !== binding.inputDigest
    ) {
      return { kind: "rejected", reason: "binding" } as const;
    }

    const claim = yield* dependencies.store.resolveCallbackClaim(binding).pipe(Effect.option);
    if (claim._tag === "None" || claim.value === null) {
      return { kind: "rejected", reason: "binding" } as const;
    }
    const outcome = yield* validateDanceAttemptProcessingOutcome(
      claim.value,
      callback.outcome,
    ).pipe(Effect.option);
    if (outcome._tag === "None") return { kind: "rejected", reason: "binding" } as const;

    const completed = yield* dependencies.store
      .complete(claim.value, outcome.value)
      .pipe(Effect.option);
    if (completed._tag === "None" || completed.value === "stale") {
      return { kind: "rejected", reason: "stale" } as const;
    }
    return { kind: completed.value } as const;
  });
}
