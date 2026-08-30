import {
  AppendDanceChoreographyRevision,
  BadRequest,
  ClearSongDancePresentation,
  Conflict,
  CreateDanceChoreography,
  DisableDanceChoreography,
  type GetDanceChoreographyProcessing,
  type GetDanceChoreographyRevision,
  InternalError,
  type ListReadyDanceChoreographies,
  NotFound,
  RetireDanceChoreography,
  SetSongDancePresentation,
} from "@pirate/contracts";
import { Data, Effect, Schema } from "effect";
import { canonicalBodyHash } from "../content/common.ts";

type ResponseOf<T extends { readonly response: Schema.ConstraintDecoder<unknown> }> =
  Schema.Schema.Type<T["response"]>;

export type CreateDanceReferenceResponse = ResponseOf<typeof CreateDanceChoreography>;
export type GetDanceReferenceProcessingResponse = ResponseOf<typeof GetDanceChoreographyProcessing>;
export type AppendDanceReferenceResponse = ResponseOf<typeof AppendDanceChoreographyRevision>;
export type DisableDanceReferenceResponse = ResponseOf<typeof DisableDanceChoreography>;
export type RetireDanceReferenceResponse = ResponseOf<typeof RetireDanceChoreography>;
export type ListReadyDanceReferencesResponse = ResponseOf<typeof ListReadyDanceChoreographies>;
export type GetDanceReferenceRevisionResponse = ResponseOf<typeof GetDanceChoreographyRevision>;
export type SetDancePresentationResponse = ResponseOf<typeof SetSongDancePresentation>;
export type ClearDancePresentationResponse = ResponseOf<typeof ClearSongDancePresentation>;

export type DanceReferenceAction = Readonly<{
  readonly actorAccountId: string;
  readonly httpMethod: "POST" | "PUT" | "DELETE";
  readonly endpointTemplate:
    | "/communities/:communityId/posts/:postId/dance/choreographies"
    | "/communities/:communityId/dance/choreographies/:choreographyId/revisions"
    | "/communities/:communityId/dance/choreographies/:choreographyId/disable"
    | "/communities/:communityId/dance/choreographies/:choreographyId/retire"
    | "/communities/:communityId/posts/:postId/dance/presentation";
  readonly idempotencyKey: string;
  readonly requestHash: string;
}>;

export type DanceReferencePolicyAuthority = Readonly<{
  readonly extraction: Readonly<{
    readonly policyVersion: string;
    readonly outputProfile: Readonly<{
      readonly sampleRateHz: number;
      readonly channels: number;
      readonly codec: "flac" | "pcm_s16le" | "pcm_s24le" | "wav";
    }>;
  }>;
  readonly alignment: Readonly<{
    readonly policyVersion: string;
    readonly adapterId: string;
    readonly adapterRevision: string;
    readonly limits: Readonly<{
      readonly maximumAbsoluteOffsetMs: number;
      readonly maximumAbsoluteDriftMs: number;
      readonly maximumAbsoluteSlopeDeltaPpm: number;
      readonly minimumOverallConfidenceBps: number;
      readonly minimumCoverageBps: number;
      readonly minimumSoundtrackMatchBps: number;
    }>;
  }>;
  readonly pose: Readonly<{
    readonly modelVersion: string;
    readonly runtimeVersion: string;
    readonly featureSchemaVersion: string;
    readonly scorerContractVersion: string;
    readonly fingerprintPolicyVersion: string;
    readonly integrityPolicyVersion: string;
  }>;
  readonly qualityLimits: Readonly<{
    readonly minimumUsableCoverageBps: number;
    readonly maximumMissingGapSlots: number;
    readonly minimumBodyCoverageBps: number;
    readonly minimumVisibilityCoverageBps: number;
    readonly minimumMotionEnergyBps: number;
    readonly minimumSpatialExtentBps: number;
  }>;
  readonly ownerPolicy: Readonly<{ readonly revision: number; readonly hash: string }>;
}>;

export type DanceReferenceAuthoringAuthority = DanceReferencePolicyAuthority &
  Readonly<{
    readonly canonicalAudio: Readonly<{
      readonly objectKey: string;
      readonly sha256: string;
      readonly durationMs: number;
      readonly audioRevision: number;
    }>;
    readonly referenceVideo: Readonly<{
      readonly postId: string;
      readonly objectKey: string;
      readonly sha256: string;
      readonly durationMs: number;
    }>;
  }>;

export interface DanceReferenceAuthoringAuthorityResolver {
  readonly resolve: (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly target:
      | Readonly<{ readonly kind: "song"; readonly songPostId: string }>
      | Readonly<{ readonly kind: "choreography"; readonly choreographyId: string }>;
    readonly audioRevision: number;
    readonly referenceVideoPostId: string;
    readonly startMs: number;
    readonly endMs: number;
  }) => Promise<DanceReferenceAuthoringAuthority>;
}

export type DanceReferenceActionReplay =
  | Readonly<{ readonly kind: "miss" }>
  | Readonly<{ readonly kind: "conflict" }>
  | Readonly<{ readonly kind: "replay"; readonly response: unknown }>;

export class DanceReferenceStoreError extends Data.TaggedError("DanceReferenceStoreError")<{
  readonly operation:
    | "action"
    | "create"
    | "get-processing"
    | "append"
    | "disable"
    | "retire"
    | "list-ready"
    | "get-revision"
    | "set-presentation"
    | "clear-presentation";
  readonly reason:
    | "invalid-input"
    | "not-found"
    | "idempotency-conflict"
    | "state-conflict"
    | "authority-conflict"
    | "invalid-row"
    | "unavailable";
}> {}

export interface DanceReferenceStore {
  readonly lookupAction: (action: DanceReferenceAction) => Promise<DanceReferenceActionReplay>;
  readonly create: (input: {
    readonly action: DanceReferenceAction;
    readonly communityId: string;
    readonly songPostId: string;
    readonly creatorPersonaId: string;
    readonly audioRevision: number;
    readonly referenceVideoPostId: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly mirrorPolicy: "strict" | "allowed";
    readonly authority: DanceReferenceAuthoringAuthority;
  }) => Promise<CreateDanceReferenceResponse>;
  readonly getProcessing: (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly choreographyId: string;
  }) => Promise<GetDanceReferenceProcessingResponse>;
  readonly append: (input: {
    readonly action: DanceReferenceAction;
    readonly communityId: string;
    readonly choreographyId: string;
    readonly audioRevision: number;
    readonly referenceVideoPostId: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly mirrorPolicy: "strict" | "allowed";
    readonly authority: DanceReferenceAuthoringAuthority;
  }) => Promise<AppendDanceReferenceResponse>;
  readonly disable: (input: {
    readonly action: DanceReferenceAction;
    readonly communityId: string;
    readonly choreographyId: string;
    readonly reason: "rights" | "safety";
  }) => Promise<DisableDanceReferenceResponse>;
  readonly retire: (input: {
    readonly action: DanceReferenceAction;
    readonly communityId: string;
    readonly choreographyId: string;
  }) => Promise<RetireDanceReferenceResponse>;
  readonly listReady: (input: {
    readonly communityId: string;
    readonly songPostId: string;
    readonly audioRevision: number;
    readonly cursor: string | null;
    readonly limit: number;
  }) => Promise<ListReadyDanceReferencesResponse>;
  readonly getRevision: (input: {
    readonly communityId: string;
    readonly choreographyId: string;
    readonly revision: number;
  }) => Promise<GetDanceReferenceRevisionResponse>;
  readonly setPresentation: (input: {
    readonly action: DanceReferenceAction;
    readonly communityId: string;
    readonly songPostId: string;
    readonly audioRevision: number;
    readonly choreographyId: string;
    readonly choreographyRevision: number;
  }) => Promise<SetDancePresentationResponse>;
  readonly clearPresentation: (input: {
    readonly action: DanceReferenceAction;
    readonly communityId: string;
    readonly songPostId: string;
    readonly audioRevision: number;
  }) => Promise<ClearDancePresentationResponse>;
}

export type DanceReferenceServices = Readonly<{
  readonly store: DanceReferenceStore;
  readonly authority: DanceReferenceAuthoringAuthorityResolver | null;
}>;

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input),
    catch: () => new BadRequest({ message: "Invalid Dance reference request" }),
  });

const mapFailure = (error: unknown) => {
  if (!(error instanceof DanceReferenceStoreError)) {
    return new InternalError({ message: "Dance reference operation failed" });
  }
  switch (error.reason) {
    case "invalid-input":
      return new BadRequest({ message: "Dance reference request is invalid" });
    case "not-found":
      return new NotFound({ message: "Dance reference resource is unavailable" });
    case "idempotency-conflict":
      return new Conflict({ message: "Dance idempotency key conflicts with another request" });
    case "state-conflict":
    case "authority-conflict":
      return new Conflict({ message: "Dance reference state does not permit this command" });
    case "invalid-row":
    case "unavailable":
      return new InternalError({ message: "Dance reference operation is unavailable" });
  }
};

const callStore = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => mapFailure(error) });

const validActor = (actorAccountId: string) =>
  actorAccountId.length > 0 && actorAccountId === actorAccountId.trim()
    ? Effect.void
    : Effect.fail(new BadRequest({ message: "Invalid Dance reference actor" }));

const action = (
  actorAccountId: string,
  httpMethod: DanceReferenceAction["httpMethod"],
  endpointTemplate: DanceReferenceAction["endpointTemplate"],
  idempotencyKey: string,
  requestHash: string,
): DanceReferenceAction => ({
  actorAccountId,
  httpMethod,
  endpointTemplate,
  idempotencyKey,
  requestHash,
});

const replay = <S extends Schema.ConstraintDecoder<unknown>>(
  responseSchema: S,
  stored: DanceReferenceActionReplay,
) => {
  if (stored.kind === "miss") return Effect.succeed(null);
  if (stored.kind === "conflict") {
    return Effect.fail(
      new Conflict({ message: "Dance idempotency key conflicts with another request" }),
    );
  }
  return Effect.try({
    try: () => {
      const decoded = Schema.decodeUnknownSync(responseSchema)(stored.response) as S["Type"] & {
        readonly replayed: boolean;
      };
      return { ...decoded, replayed: true };
    },
    catch: () => new InternalError({ message: "Dance replay evidence is invalid" }),
  });
};

const requireAuthority = (services: DanceReferenceServices) =>
  services.authority === null
    ? Effect.fail(new InternalError({ message: "Dance reference authoring is unavailable" }))
    : Effect.succeed(services.authority);

export function makeDanceReferenceService(services: DanceReferenceServices) {
  const create = Effect.fn("DanceReference.create")(function* (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly songPostId: string;
    readonly body: unknown;
  }) {
    yield* validActor(input.actorAccountId);
    const body = yield* decode(CreateDanceChoreography.request.body, input.body);
    const requestHash = yield* canonicalBodyHash({
      community_id: input.communityId,
      song_post_id: input.songPostId,
      body,
    });
    const identity = action(
      input.actorAccountId,
      "POST",
      "/communities/:communityId/posts/:postId/dance/choreographies",
      body.idempotency_key,
      requestHash,
    );
    const prior = yield* callStore(() => services.store.lookupAction(identity));
    const priorResponse = yield* replay(CreateDanceChoreography.response, prior);
    if (priorResponse !== null) return priorResponse;
    const resolver = yield* requireAuthority(services);
    const authority = yield* Effect.tryPromise({
      try: () =>
        resolver.resolve({
          actorAccountId: input.actorAccountId,
          communityId: input.communityId,
          target: { kind: "song", songPostId: input.songPostId },
          audioRevision: body.audio_revision,
          referenceVideoPostId: body.reference_video_post_id,
          startMs: body.start_ms,
          endMs: body.end_ms,
        }),
      catch: () => new NotFound({ message: "Dance reference authoring authority is unavailable" }),
    });
    return yield* callStore(() =>
      services.store.create({
        action: identity,
        communityId: input.communityId,
        songPostId: input.songPostId,
        creatorPersonaId: body.creator_persona_id,
        audioRevision: body.audio_revision,
        referenceVideoPostId: body.reference_video_post_id,
        startMs: body.start_ms,
        endMs: body.end_ms,
        mirrorPolicy: body.mirror_policy,
        authority,
      }),
    );
  });

  const getProcessing = Effect.fn("DanceReference.getProcessing")(function* (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly choreographyId: string;
  }) {
    yield* validActor(input.actorAccountId);
    return yield* callStore(() => services.store.getProcessing(input));
  });

  const append = Effect.fn("DanceReference.append")(function* (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly choreographyId: string;
    readonly body: unknown;
  }) {
    yield* validActor(input.actorAccountId);
    const body = yield* decode(AppendDanceChoreographyRevision.request.body, input.body);
    const requestHash = yield* canonicalBodyHash({
      community_id: input.communityId,
      choreography_id: input.choreographyId,
      body,
    });
    const identity = action(
      input.actorAccountId,
      "POST",
      "/communities/:communityId/dance/choreographies/:choreographyId/revisions",
      body.idempotency_key,
      requestHash,
    );
    const prior = yield* callStore(() => services.store.lookupAction(identity));
    const priorResponse = yield* replay(AppendDanceChoreographyRevision.response, prior);
    if (priorResponse !== null) return priorResponse;
    const resolver = yield* requireAuthority(services);
    const authority = yield* Effect.tryPromise({
      try: () =>
        resolver.resolve({
          actorAccountId: input.actorAccountId,
          communityId: input.communityId,
          target: { kind: "choreography", choreographyId: input.choreographyId },
          audioRevision: body.audio_revision,
          referenceVideoPostId: body.reference_video_post_id,
          startMs: body.start_ms,
          endMs: body.end_ms,
        }),
      catch: () => new NotFound({ message: "Dance reference authoring authority is unavailable" }),
    });
    return yield* callStore(() =>
      services.store.append({
        action: identity,
        communityId: input.communityId,
        choreographyId: input.choreographyId,
        audioRevision: body.audio_revision,
        referenceVideoPostId: body.reference_video_post_id,
        startMs: body.start_ms,
        endMs: body.end_ms,
        mirrorPolicy: body.mirror_policy,
        authority,
      }),
    );
  });

  const disable = Effect.fn("DanceReference.disable")(function* (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly choreographyId: string;
    readonly body: unknown;
  }) {
    yield* validActor(input.actorAccountId);
    const body = yield* decode(DisableDanceChoreography.request.body, input.body);
    const requestHash = yield* canonicalBodyHash({
      community_id: input.communityId,
      choreography_id: input.choreographyId,
      body,
    });
    return yield* callStore(() =>
      services.store.disable({
        action: action(
          input.actorAccountId,
          "POST",
          "/communities/:communityId/dance/choreographies/:choreographyId/disable",
          body.idempotency_key,
          requestHash,
        ),
        communityId: input.communityId,
        choreographyId: input.choreographyId,
        reason: body.reason,
      }),
    );
  });

  const retire = Effect.fn("DanceReference.retire")(function* (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly choreographyId: string;
    readonly body: unknown;
  }) {
    yield* validActor(input.actorAccountId);
    const body = yield* decode(RetireDanceChoreography.request.body, input.body);
    const requestHash = yield* canonicalBodyHash({
      community_id: input.communityId,
      choreography_id: input.choreographyId,
      body,
    });
    return yield* callStore(() =>
      services.store.retire({
        action: action(
          input.actorAccountId,
          "POST",
          "/communities/:communityId/dance/choreographies/:choreographyId/retire",
          body.idempotency_key,
          requestHash,
        ),
        communityId: input.communityId,
        choreographyId: input.choreographyId,
      }),
    );
  });

  const listReady = Effect.fn("DanceReference.listReady")(function* (input: {
    readonly communityId: string;
    readonly songPostId: string;
    readonly audioRevision: string;
    readonly cursor?: string;
    readonly limit?: string;
  }) {
    const audioRevision = Number(input.audioRevision);
    const limit = input.limit === undefined ? 25 : Number(input.limit);
    if (!Number.isSafeInteger(audioRevision) || audioRevision < 1 || !Number.isInteger(limit)) {
      return yield* new BadRequest({ message: "Invalid Dance reference query" });
    }
    return yield* callStore(() =>
      services.store.listReady({
        communityId: input.communityId,
        songPostId: input.songPostId,
        audioRevision,
        cursor: input.cursor ?? null,
        limit,
      }),
    );
  });

  const getRevision = Effect.fn("DanceReference.getRevision")(function* (input: {
    readonly communityId: string;
    readonly choreographyId: string;
    readonly revision: string;
  }) {
    const revision = Number(input.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      return yield* new BadRequest({ message: "Invalid Dance choreography revision" });
    }
    return yield* callStore(() => services.store.getRevision({ ...input, revision }));
  });

  const setPresentation = Effect.fn("DanceReference.setPresentation")(function* (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly songPostId: string;
    readonly body: unknown;
  }) {
    yield* validActor(input.actorAccountId);
    const body = yield* decode(SetSongDancePresentation.request.body, input.body);
    const requestHash = yield* canonicalBodyHash({
      community_id: input.communityId,
      song_post_id: input.songPostId,
      body,
    });
    return yield* callStore(() =>
      services.store.setPresentation({
        action: action(
          input.actorAccountId,
          "PUT",
          "/communities/:communityId/posts/:postId/dance/presentation",
          body.idempotency_key,
          requestHash,
        ),
        communityId: input.communityId,
        songPostId: input.songPostId,
        audioRevision: body.audio_revision,
        choreographyId: body.choreography_id,
        choreographyRevision: body.choreography_revision,
      }),
    );
  });

  const clearPresentation = Effect.fn("DanceReference.clearPresentation")(function* (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly songPostId: string;
    readonly body: unknown;
  }) {
    yield* validActor(input.actorAccountId);
    const body = yield* decode(ClearSongDancePresentation.request.body, input.body);
    const requestHash = yield* canonicalBodyHash({
      community_id: input.communityId,
      song_post_id: input.songPostId,
      body,
    });
    return yield* callStore(() =>
      services.store.clearPresentation({
        action: action(
          input.actorAccountId,
          "DELETE",
          "/communities/:communityId/posts/:postId/dance/presentation",
          body.idempotency_key,
          requestHash,
        ),
        communityId: input.communityId,
        songPostId: input.songPostId,
        audioRevision: body.audio_revision,
      }),
    );
  });

  return {
    create,
    getProcessing,
    append,
    disable,
    retire,
    listReady,
    getRevision,
    setPresentation,
    clearPresentation,
  } as const;
}
