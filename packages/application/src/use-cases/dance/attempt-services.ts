import {
  BadRequest,
  Conflict,
  CreateDanceSession,
  FinalizeDanceSessionUpload,
  GetDanceSession,
  InternalError,
  NotFound,
  RecordDanceSessionConsent,
  ReserveDanceSessionUpload,
  SubmitDanceSessionForGrading,
} from "@pirate/contracts";
import { Data, Effect, Schema } from "effect";
import { canonicalBodyHash } from "../content/common.ts";

type ResponseOf<T extends { readonly response: Schema.ConstraintDecoder<unknown> }> =
  Schema.Schema.Type<T["response"]>;

export type CreateDanceSessionResponse = ResponseOf<typeof CreateDanceSession>;
export type RecordDanceSessionConsentResponse = ResponseOf<typeof RecordDanceSessionConsent>;
export type ReserveDanceSessionUploadResponse = ResponseOf<typeof ReserveDanceSessionUpload>;
export type FinalizeDanceSessionUploadResponse = ResponseOf<typeof FinalizeDanceSessionUpload>;
export type SubmitDanceSessionForGradingResponse = ResponseOf<typeof SubmitDanceSessionForGrading>;
export type GetDanceSessionResponse = ResponseOf<typeof GetDanceSession>;

export type DanceAttemptAction = Readonly<{
  readonly actorAccountId: string;
  readonly httpMethod: "POST";
  readonly endpointTemplate:
    | "/communities/:communityId/posts/:postId/dance/choreographies/:choreographyId/revisions/:revision/sessions"
    | "/communities/:communityId/dance/sessions/:sessionId/consent"
    | "/communities/:communityId/dance/sessions/:sessionId/upload-reservations"
    | "/communities/:communityId/dance/sessions/:sessionId/upload/finalize"
    | "/communities/:communityId/dance/sessions/:sessionId/grading-submissions";
  readonly idempotencyKey: string;
  readonly requestHash: string;
}>;

export type DanceAttemptActionReplay =
  | Readonly<{ readonly kind: "miss" }>
  | Readonly<{ readonly kind: "conflict" }>
  | Readonly<{ readonly kind: "replay"; readonly response: unknown }>;

export type DanceAttemptSessionAuthority = Readonly<{
  readonly sessionId: string;
  readonly audioRevision: number;
  readonly segmentId: string;
  readonly expectedScoredDurationMs: number;
  readonly cue: Readonly<{
    readonly kind: "hands_on_head" | "arms_t" | "hands_on_hips";
    readonly holdMs: number;
    readonly observationStartMs: number;
    readonly observationEndMs: number;
  }>;
  readonly policy: Readonly<{
    readonly qualificationPolicyVersionId: string;
    readonly calibrationVersionId: string;
    readonly calibrationChecksum: string;
    readonly capturedAdmissionState: "shadow";
    readonly platformFloorBps: number;
    readonly poseModelVersion: string;
    readonly featureSchemaVersion: string;
    readonly scorerContractVersion: string;
    readonly mirrorPolicyVersion: string;
    readonly cuePolicyVersion: string;
    readonly fingerprintPolicyVersion: string;
    readonly fingerprintKeyVersion: string;
    readonly integrityPolicyVersion: string;
    readonly graderAdapterVersion: string;
  }>;
  readonly sessionTermsHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}>;

export interface DanceAttemptSessionAuthorityResolver {
  readonly resolve: (input: {
    readonly actorAccountId: string;
    readonly personaId: string;
    readonly communityId: string;
    readonly songPostId: string;
    readonly choreographyId: string;
    readonly choreographyRevision: number;
  }) => Promise<DanceAttemptSessionAuthority>;
}

export type DanceAttemptUploadReservationAuthority = Readonly<{
  readonly reservationId: string;
  readonly privateObjectKey: string;
  readonly uploadUrl: string;
  readonly expectedContentType: "video/mp4" | "video/quicktime" | "video/webm";
  readonly expectedSizeBytes: number;
  readonly expectedDurationMs: number;
  readonly expectedSha256: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}>;

export type DanceAttemptSealedUploadAuthority = Readonly<{
  readonly reservationId: string;
  readonly privateObjectKey: string;
  readonly contentType: "video/mp4" | "video/quicktime" | "video/webm";
  readonly sizeBytes: number;
  readonly durationMs: number;
  readonly serverSha256: string;
  readonly sealedAt: string;
}>;

export interface DanceAttemptUploadAuthority {
  readonly reserve: (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly sessionId: string;
    readonly expectedContentType: DanceAttemptUploadReservationAuthority["expectedContentType"];
    readonly expectedSizeBytes: number;
    readonly expectedDurationMs: number;
    readonly expectedSha256: string | null;
  }) => Promise<DanceAttemptUploadReservationAuthority>;
  readonly seal: (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly sessionId: string;
    readonly reservationId: string;
  }) => Promise<DanceAttemptSealedUploadAuthority>;
}

export class DanceAttemptStoreError extends Data.TaggedError("DanceAttemptStoreError")<{
  readonly operation: "action" | "create" | "consent" | "reserve" | "finalize" | "submit" | "get";
  readonly reason:
    | "invalid-input"
    | "not-found"
    | "idempotency-conflict"
    | "state-conflict"
    | "authority-conflict"
    | "quota-exceeded"
    | "invalid-row"
    | "unavailable";
}> {}

export interface DanceAttemptStore {
  readonly lookupAction: (action: DanceAttemptAction) => Promise<DanceAttemptActionReplay>;
  readonly create: (input: {
    readonly action: DanceAttemptAction;
    readonly communityId: string;
    readonly songPostId: string;
    readonly choreographyId: string;
    readonly choreographyRevision: number;
    readonly personaId: string;
    readonly authority: DanceAttemptSessionAuthority;
  }) => Promise<CreateDanceSessionResponse>;
  readonly consent: (input: {
    readonly action: DanceAttemptAction;
    readonly communityId: string;
    readonly sessionId: string;
    readonly personaId: string;
    readonly sessionTermsHash: string;
    readonly consentPolicyVersionId: string;
    readonly retentionDisclosureVersion: string;
    readonly source: "camera" | "file_upload";
  }) => Promise<RecordDanceSessionConsentResponse>;
  readonly reserve: (input: {
    readonly action: DanceAttemptAction;
    readonly communityId: string;
    readonly sessionId: string;
    readonly authority: DanceAttemptUploadReservationAuthority;
  }) => Promise<ReserveDanceSessionUploadResponse>;
  readonly finalize: (input: {
    readonly action: DanceAttemptAction;
    readonly communityId: string;
    readonly sessionId: string;
    readonly authority: DanceAttemptSealedUploadAuthority;
  }) => Promise<FinalizeDanceSessionUploadResponse>;
  readonly submit: (input: {
    readonly action: DanceAttemptAction;
    readonly communityId: string;
    readonly sessionId: string;
  }) => Promise<SubmitDanceSessionForGradingResponse>;
  readonly get: (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly sessionId: string;
  }) => Promise<GetDanceSessionResponse>;
}

export type DanceAttemptServices = Readonly<{
  readonly store: DanceAttemptStore;
  readonly sessionAuthority: DanceAttemptSessionAuthorityResolver | null;
  readonly uploadAuthority: DanceAttemptUploadAuthority | null;
}>;

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input),
    catch: () => new BadRequest({ message: "Invalid Dance attempt request" }),
  });

const mapFailure = (error: unknown) => {
  if (!(error instanceof DanceAttemptStoreError)) {
    return new InternalError({ message: "Dance attempt operation failed" });
  }
  switch (error.reason) {
    case "invalid-input":
      return new BadRequest({ message: "Dance attempt request is invalid" });
    case "not-found":
      return new NotFound({ message: "Dance attempt resource is unavailable" });
    case "idempotency-conflict":
      return new Conflict({ message: "Dance idempotency key conflicts with another request" });
    case "state-conflict":
    case "authority-conflict":
    case "quota-exceeded":
      return new Conflict({ message: "Dance attempt state does not permit this command" });
    case "invalid-row":
    case "unavailable":
      return new InternalError({ message: "Dance attempt operation is unavailable" });
  }
};

const callStore = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => mapFailure(error) });

const validActor = (actorAccountId: string) =>
  actorAccountId.length > 0 && actorAccountId === actorAccountId.trim()
    ? Effect.void
    : Effect.fail(new BadRequest({ message: "Invalid Dance attempt actor" }));

const action = (
  actorAccountId: string,
  endpointTemplate: DanceAttemptAction["endpointTemplate"],
  idempotencyKey: string,
  requestHash: string,
): DanceAttemptAction => ({
  actorAccountId,
  httpMethod: "POST",
  endpointTemplate,
  idempotencyKey,
  requestHash,
});

const replay = <S extends Schema.ConstraintDecoder<unknown>>(
  responseSchema: S,
  stored: DanceAttemptActionReplay,
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

const requireSessionAuthority = (services: DanceAttemptServices) =>
  services.sessionAuthority === null
    ? Effect.fail(new InternalError({ message: "Dance session creation is unavailable" }))
    : Effect.succeed(services.sessionAuthority);

const requireUploadAuthority = (services: DanceAttemptServices) =>
  services.uploadAuthority === null
    ? Effect.fail(new InternalError({ message: "Dance private upload is unavailable" }))
    : Effect.succeed(services.uploadAuthority);

export function makeDanceAttemptService(services: DanceAttemptServices) {
  const create = Effect.fn("DanceAttempt.create")(function* (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly songPostId: string;
    readonly choreographyId: string;
    readonly choreographyRevision: string;
    readonly body: unknown;
  }) {
    yield* validActor(input.actorAccountId);
    const path = yield* decode(CreateDanceSession.request.path, {
      communityId: input.communityId,
      postId: input.songPostId,
      choreographyId: input.choreographyId,
      revision: input.choreographyRevision,
    });
    const body = yield* decode(CreateDanceSession.request.body, input.body);
    const requestHash = yield* canonicalBodyHash({ path, body });
    const identity = action(
      input.actorAccountId,
      "/communities/:communityId/posts/:postId/dance/choreographies/:choreographyId/revisions/:revision/sessions",
      body.idempotency_key,
      requestHash,
    );
    const priorResponse = yield* replay(
      CreateDanceSession.response,
      yield* callStore(() => services.store.lookupAction(identity)),
    );
    if (priorResponse !== null) return priorResponse;
    const resolver = yield* requireSessionAuthority(services);
    const authority = yield* Effect.tryPromise({
      try: () =>
        resolver.resolve({
          actorAccountId: input.actorAccountId,
          personaId: body.persona_id,
          communityId: path.communityId,
          songPostId: path.postId,
          choreographyId: path.choreographyId,
          choreographyRevision: Number(path.revision),
        }),
      catch: () => new NotFound({ message: "Dance session authority is unavailable" }),
    });
    return yield* callStore(() =>
      services.store.create({
        action: identity,
        communityId: path.communityId,
        songPostId: path.postId,
        choreographyId: path.choreographyId,
        choreographyRevision: Number(path.revision),
        personaId: body.persona_id,
        authority,
      }),
    );
  });

  const consent = Effect.fn("DanceAttempt.consent")(function* (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly sessionId: string;
    readonly body: unknown;
  }) {
    yield* validActor(input.actorAccountId);
    const path = yield* decode(RecordDanceSessionConsent.request.path, {
      communityId: input.communityId,
      sessionId: input.sessionId,
    });
    const body = yield* decode(RecordDanceSessionConsent.request.body, input.body);
    const requestHash = yield* canonicalBodyHash({ path, body });
    return yield* callStore(() =>
      services.store.consent({
        action: action(
          input.actorAccountId,
          "/communities/:communityId/dance/sessions/:sessionId/consent",
          body.idempotency_key,
          requestHash,
        ),
        communityId: path.communityId,
        sessionId: path.sessionId,
        personaId: body.persona_id,
        sessionTermsHash: body.session_terms_hash,
        consentPolicyVersionId: body.consent_policy_version_id,
        retentionDisclosureVersion: body.retention_disclosure_version,
        source: body.source,
      }),
    );
  });

  const reserve = Effect.fn("DanceAttempt.reserve")(function* (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly sessionId: string;
    readonly body: unknown;
  }) {
    yield* validActor(input.actorAccountId);
    const path = yield* decode(ReserveDanceSessionUpload.request.path, {
      communityId: input.communityId,
      sessionId: input.sessionId,
    });
    const body = yield* decode(ReserveDanceSessionUpload.request.body, input.body);
    const requestHash = yield* canonicalBodyHash({ path, body });
    const identity = action(
      input.actorAccountId,
      "/communities/:communityId/dance/sessions/:sessionId/upload-reservations",
      body.idempotency_key,
      requestHash,
    );
    const priorResponse = yield* replay(
      ReserveDanceSessionUpload.response,
      yield* callStore(() => services.store.lookupAction(identity)),
    );
    if (priorResponse !== null) return priorResponse;
    const authority = yield* requireUploadAuthority(services);
    const reservation = yield* Effect.tryPromise({
      try: () =>
        authority.reserve({
          actorAccountId: input.actorAccountId,
          communityId: path.communityId,
          sessionId: path.sessionId,
          expectedContentType: body.expected_content_type,
          expectedSizeBytes: body.expected_size_bytes,
          expectedDurationMs: body.expected_duration_ms,
          expectedSha256: body.expected_sha256 ?? null,
        }),
      catch: () => new InternalError({ message: "Dance private upload is unavailable" }),
    });
    return yield* callStore(() =>
      services.store.reserve({
        action: identity,
        communityId: path.communityId,
        sessionId: path.sessionId,
        authority: reservation,
      }),
    );
  });

  const finalize = Effect.fn("DanceAttempt.finalize")(function* (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly sessionId: string;
    readonly body: unknown;
  }) {
    yield* validActor(input.actorAccountId);
    const path = yield* decode(FinalizeDanceSessionUpload.request.path, {
      communityId: input.communityId,
      sessionId: input.sessionId,
    });
    const body = yield* decode(FinalizeDanceSessionUpload.request.body, input.body);
    const requestHash = yield* canonicalBodyHash({ path, body });
    const identity = action(
      input.actorAccountId,
      "/communities/:communityId/dance/sessions/:sessionId/upload/finalize",
      body.idempotency_key,
      requestHash,
    );
    const priorResponse = yield* replay(
      FinalizeDanceSessionUpload.response,
      yield* callStore(() => services.store.lookupAction(identity)),
    );
    if (priorResponse !== null) return priorResponse;
    const authority = yield* requireUploadAuthority(services);
    const sealed = yield* Effect.tryPromise({
      try: () =>
        authority.seal({
          actorAccountId: input.actorAccountId,
          communityId: path.communityId,
          sessionId: path.sessionId,
          reservationId: body.reservation_id,
        }),
      catch: () => new Conflict({ message: "Dance upload could not be sealed" }),
    });
    return yield* callStore(() =>
      services.store.finalize({
        action: identity,
        communityId: path.communityId,
        sessionId: path.sessionId,
        authority: sealed,
      }),
    );
  });

  const submit = Effect.fn("DanceAttempt.submit")(function* (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly sessionId: string;
    readonly body: unknown;
  }) {
    yield* validActor(input.actorAccountId);
    const path = yield* decode(SubmitDanceSessionForGrading.request.path, {
      communityId: input.communityId,
      sessionId: input.sessionId,
    });
    const body = yield* decode(SubmitDanceSessionForGrading.request.body, input.body);
    const requestHash = yield* canonicalBodyHash({ path, body });
    return yield* callStore(() =>
      services.store.submit({
        action: action(
          input.actorAccountId,
          "/communities/:communityId/dance/sessions/:sessionId/grading-submissions",
          body.idempotency_key,
          requestHash,
        ),
        communityId: path.communityId,
        sessionId: path.sessionId,
      }),
    );
  });

  const get = Effect.fn("DanceAttempt.get")(function* (input: {
    readonly actorAccountId: string;
    readonly communityId: string;
    readonly sessionId: string;
  }) {
    yield* validActor(input.actorAccountId);
    const path = yield* decode(GetDanceSession.request.path, {
      communityId: input.communityId,
      sessionId: input.sessionId,
    });
    return yield* callStore(() =>
      services.store.get({
        actorAccountId: input.actorAccountId,
        communityId: path.communityId,
        sessionId: path.sessionId,
      }),
    );
  });

  return { create, consent, reserve, finalize, submit, get } as const;
}
