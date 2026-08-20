import {
  BadRequest,
  CommitCommunityCreationIntent,
  Conflict,
  CreateCommunityCreationIntent,
  InternalError,
  NotFound,
  UpdateCommunityCreationIntent,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import {
  CommunityCreationRepositoryError,
  type CommunityCreationRepositoryFailure,
  type CommunityCreationStore,
  type M2Actor,
} from "../../ports.ts";

export interface CommunityCreationServices {
  readonly communityCreationStore: CommunityCreationStore["Service"];
}

export type CreateCommunityCreationIntentInput = Readonly<{
  readonly actor: M2Actor;
  readonly body: unknown;
}>;

export type GetCommunityCreationIntentInput = Readonly<{
  readonly actor: M2Actor;
  readonly intentId: string;
}>;

export type UpdateCommunityCreationIntentInput = Readonly<{
  readonly actor: M2Actor;
  readonly intentId: string;
  readonly body: unknown;
}>;

export type CommitCommunityCreationIntentInput = Readonly<{
  readonly actor: M2Actor;
  readonly intentId: string;
  readonly body: unknown;
}>;

const validIdentifier = (value: string): boolean =>
  value.length > 0 && value.trim() === value && !value.includes("\u0000");

const validateActor = (actor: M2Actor) =>
  actor.kind !== "agent" && validIdentifier(actor.userId)
    ? Effect.void
    : Effect.fail(
        new BadRequest({ message: "Only authenticated human actors may create communities" }),
      );

const decodeBody = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input),
    catch: () => new BadRequest({ message: "Invalid community creation request" }),
  });

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
};

const requestHash = (value: unknown) =>
  Effect.tryPromise({
    try: async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(canonicalValue(value)));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: () => new InternalError({ message: "Unable to fingerprint community creation request" }),
  });

const mapFailure = (failure: CommunityCreationRepositoryFailure) => {
  if (!(failure instanceof CommunityCreationRepositoryError)) {
    return new InternalError({ message: "Community creation operation failed" });
  }
  switch (failure.reason) {
    case "not-found":
      return new NotFound({ message: "Community creation intent not found" });
    case "idempotency-conflict":
      return new Conflict({ message: "Idempotency key was already used with a different request" });
    case "revision-conflict":
      return new Conflict({ message: "Community creation intent revision is stale" });
    case "constraint":
      return new Conflict({ message: "Community creation conflicts with an existing resource" });
    case "invalid-row":
      return new InternalError({ message: "Community creation returned an invalid record" });
  }
};

export const createCommunityCreationIntent = Effect.fn("createCommunityCreationIntent")(function* (
  input: CreateCommunityCreationIntentInput,
  services: CommunityCreationServices,
) {
  yield* validateActor(input.actor);
  const body = yield* decodeBody(CreateCommunityCreationIntent.request.body, input.body);
  const hash = yield* requestHash(body);
  return yield* services.communityCreationStore
    .create({ actor: input.actor, body, requestHash: hash })
    .pipe(Effect.mapError(mapFailure));
});

export const getCommunityCreationIntent = Effect.fn("getCommunityCreationIntent")(function* (
  input: GetCommunityCreationIntentInput,
  services: CommunityCreationServices,
) {
  yield* validateActor(input.actor);
  if (!validIdentifier(input.intentId)) {
    return yield* new NotFound({ message: "Community creation intent not found" });
  }
  const intent = yield* services.communityCreationStore
    .get(input)
    .pipe(Effect.mapError(mapFailure));
  if (intent === null) {
    return yield* new NotFound({ message: "Community creation intent not found" });
  }
  return intent;
});

export const updateCommunityCreationIntent = Effect.fn("updateCommunityCreationIntent")(function* (
  input: UpdateCommunityCreationIntentInput,
  services: CommunityCreationServices,
) {
  yield* validateActor(input.actor);
  if (!validIdentifier(input.intentId)) {
    return yield* new NotFound({ message: "Community creation intent not found" });
  }
  const body = yield* decodeBody(UpdateCommunityCreationIntent.request.body, input.body);
  const hash = yield* requestHash(body);
  return yield* services.communityCreationStore
    .update({ intentId: input.intentId, actor: input.actor, body, requestHash: hash })
    .pipe(Effect.mapError(mapFailure));
});

export const commitCommunityCreationIntent = Effect.fn("commitCommunityCreationIntent")(function* (
  input: CommitCommunityCreationIntentInput,
  services: CommunityCreationServices,
) {
  yield* validateActor(input.actor);
  if (!validIdentifier(input.intentId)) {
    return yield* new NotFound({ message: "Community creation intent not found" });
  }
  const body = yield* decodeBody(CommitCommunityCreationIntent.request.body, input.body);
  const hash = yield* requestHash(body);
  return yield* services.communityCreationStore
    .commit({ intentId: input.intentId, actor: input.actor, body, requestHash: hash })
    .pipe(Effect.mapError(mapFailure));
});
