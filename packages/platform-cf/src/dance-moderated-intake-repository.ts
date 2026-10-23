import { Effect, type Layer, Schema } from "effect";
import {
  type ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneOperationTimedOut,
  ControlPlaneStatementFailed,
  type ControlPlaneTransaction,
  ControlPlaneTransactionOutcomeUnknown,
} from "../../application/src/ports.ts";
import { canonicalBodyHash } from "../../application/src/use-cases/content/common.ts";
import {
  ModeratedDanceCreationFacts,
  prepareModeratedDanceTerms,
  selectModeratedDanceCue,
} from "../../application/src/use-cases/dance/moderated-intake.ts";
import { DanceReviewServiceFailure } from "../../application/src/use-cases/dance/moderator-review-services.ts";
import {
  CreateModeratedDanceReferenceBody,
  ModeratedDanceCaptureOptions,
  ModeratedDanceIntakeCommand,
  ModeratedDanceIntakeReceipt,
  ModeratedDanceReferenceStatus,
  ModeratedDanceSessionView,
} from "../../contracts/src/dance-moderated-intake.ts";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";
import {
  decodeModeratedDanceCaptureContext,
  decodeModeratedDanceOwnerRubric,
} from "./dance-moderated-context.ts";
import {
  amzDate,
  canonicalQuery,
  encodeObjectPath,
  hmac,
  sha256Hex,
  signingKey,
} from "./r2-upload-signing.ts";

const fail = (reason: DanceReviewServiceFailure["reason"]) =>
  new DanceReviewServiceFailure({ reason });
const parse = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value),
    catch: () => fail("unavailable"),
  });
const call = Effect.fn("ModeratedDanceIntake.call")(function* (
  tx: Pick<ControlPlaneTransaction, "execute">,
  label: string,
  text: string,
  values: readonly unknown[],
) {
  const result = yield* tx.execute<{ packet: unknown }>({ label, text, values, readonly: false });
  if (
    result.rows.length !== 1 ||
    result.rows[0] === undefined ||
    !Object.hasOwn(result.rows[0], "packet")
  )
    return yield* fail("outcome_unknown");
  return result.rows[0].packet;
});
function classify(error: unknown) {
  if (error instanceof DanceReviewServiceFailure) return error;
  if (
    error instanceof ControlPlaneTransactionOutcomeUnknown ||
    (error instanceof ControlPlaneOperationTimedOut && error.outcomeCertainty === "unknown")
  )
    return fail("outcome_unknown");
  if (error instanceof ControlPlaneStatementFailed) {
    if (error.sqlState === "DRV02") return fail("not_found");
    if (error.sqlState === "DRV03") return fail("idempotency_conflict");
    if (error.sqlState === "DRV05") return fail("revision_conflict");
    if (error.sqlState === "DRV06" && error.label === "dance.intake.capture-options")
      return fail("invalid_request");
  }
  return fail("unavailable");
}
const Refusal = Schema.Struct({ refusal: Schema.NonEmptyString });
const replay = Schema.NullOr(
  Schema.Struct({ requestHash: Schema.String, receipt: ModeratedDanceIntakeReceipt }),
);
const access = Schema.Struct({
  key: Schema.String,
  contentType: Schema.Literals(["video/mp4", "video/quicktime"]),
  sizeBytes: Schema.Int,
  expiresInSeconds: Schema.Int,
});
export type ModeratedDanceUploadSigner = Readonly<{
  presign: (target: typeof access.Type) => Promise<{ url: string; expiresAtMs: number }>;
}>;

/** Uses ONLY the existing ingress bucket credential, with a separate private
 * prefix and signed content length/type/conditional create. No source bytes or
 * capability enter the immutable receipt. A replay cannot overwrite ingress. */
export function makeModeratedDanceUploadSigner(
  options: Readonly<{
    accountId: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    now?: () => Date;
  }>,
): ModeratedDanceUploadSigner {
  return {
    presign: async (target) => {
      if (
        !/^[a-f0-9]{32}$/u.test(options.accountId) ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(options.bucket) ||
        !/^[^\s\r\n]{1,256}$/u.test(options.accessKeyId) ||
        options.accessKeyId === "PENDING" ||
        options.secretAccessKey.length < 1 ||
        options.secretAccessKey === "PENDING" ||
        /[\r\n]/u.test(options.secretAccessKey) ||
        !/^moderated-dance\/ingress\/[a-f0-9-]{36}\/source$/u.test(target.key) ||
        !Number.isSafeInteger(target.sizeBytes) ||
        target.sizeBytes < 1 ||
        !Number.isSafeInteger(target.expiresInSeconds) ||
        target.expiresInSeconds < 1 ||
        target.expiresInSeconds > 604800
      )
        throw fail("unavailable");
      const now = options.now?.() ?? new Date(),
        date = amzDate(now),
        host = `${options.accountId}.r2.cloudflarestorage.com`,
        path = encodeObjectPath(options.bucket, target.key),
        scope = `${date.short}/auto/s3/aws4_request`;
      const headers = "content-length;content-type;host;if-none-match";
      const query = canonicalQuery([
        ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
        ["X-Amz-Credential", `${options.accessKeyId}/${scope}`],
        ["X-Amz-Date", date.full],
        ["X-Amz-Expires", String(target.expiresInSeconds)],
        ["X-Amz-SignedHeaders", headers],
      ]);
      const request = [
        "PUT",
        path,
        query,
        `content-length:${target.sizeBytes}\ncontent-type:${target.contentType}\nhost:${host}\nif-none-match:*\n`,
        headers,
        "UNSIGNED-PAYLOAD",
      ].join("\n");
      const stringToSign = [
        "AWS4-HMAC-SHA256",
        date.full,
        scope,
        await sha256Hex(new TextEncoder().encode(request)),
      ].join("\n");
      const signature = Array.from(
        await hmac(await signingKey(options.secretAccessKey, date.short), stringToSign),
        (n) => n.toString(16).padStart(2, "0"),
      ).join("");
      return {
        url: `https://${host}${path}?${query}&X-Amz-Signature=${signature}`,
        expiresAtMs: now.getTime() + target.expiresInSeconds * 1000,
      };
    },
  };
}

export function makeControlPlaneModeratedDanceIntakeStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
  accountId: string,
  input: Readonly<{
    /** Exact configured producer revisions, checked only for NEW capture. An
     * immutable receipt still recovers when processing is unavailable/paused. */
    signer: ModeratedDanceUploadSigner | null;
    rewardsEnabled?: boolean;
    randomId?: () => string;
    randomU32?: () => number;
  }>,
) {
  const id = input.randomId ?? (() => crypto.randomUUID());
  const entropy =
    input.randomU32 ?? (() => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0xffffffff);
  const command = Effect.fn("ModeratedDanceIntake.command")(function* (raw: unknown) {
    const body = yield* parse(ModeratedDanceIntakeCommand, raw);
    const hash = yield* canonicalBodyHash([
      "dance-moderated-intake-command-v1",
      accountId,
      body,
    ]).pipe(Effect.mapError(classify));
    const result = yield* withRetainedControlPlaneCommandTransaction((tx) =>
      Effect.gen(function* () {
        const prior = yield* parse(
          replay,
          yield* call(
            tx,
            "dance.intake.lock-replay",
            "SELECT lock_moderated_dance_intake_command_v1($1,$2::jsonb) AS packet",
            [accountId, JSON.stringify(body)],
          ),
        );
        if (prior !== null) {
          if (prior.requestHash !== hash) return yield* fail("idempotency_conflict");
          return prior.receipt;
        }
        let terms: unknown = null;
        if (body.operation === "create") {
          const facts = yield* parse(
            ModeratedDanceCreationFacts,
            yield* call(
              tx,
              "dance.intake.creation-facts",
              "SELECT load_moderated_dance_creation_facts_v1($1,$2::jsonb) AS packet",
              [accountId, JSON.stringify(body)],
            ),
          );
          if (
            facts.accountId !== accountId ||
            facts.personaId !== body.persona_id ||
            facts.communityId !== body.community_id ||
            facts.songPostId !== body.song_post_id ||
            facts.choreographyId !== body.choreography_id ||
            facts.choreographyRevision !== body.choreography_revision ||
            facts.policy.hash !== body.expected_policy_hash ||
            input.signer === null ||
            !facts.mediaReady
          )
            return yield* fail("unavailable");
          terms = yield* prepareModeratedDanceTerms(
            facts,
            { sessionId: id(), reviewId: id(), attemptId: id() },
            selectModeratedDanceCue(entropy),
          ).pipe(Effect.mapError(classify));
        }
        const receiptId = id(),
          uploadId = id(),
          objectKey = `moderated-dance/ingress/${id()}/source`;
        return yield* call(
          tx,
          "dance.intake.apply",
          "SELECT apply_moderated_dance_intake_v1($1,$2::jsonb,$3,$4,$5::jsonb,$6,$7) AS packet",
          [
            accountId,
            JSON.stringify(body),
            hash,
            receiptId,
            JSON.stringify(terms),
            uploadId,
            objectKey,
          ],
        );
      }),
    ).pipe(Effect.provide(runtime), Effect.mapError(classify));
    if (Schema.is(Refusal)(result)) return yield* fail("revision_conflict");
    return yield* parse(ModeratedDanceIntakeReceipt, result);
  });
  const read = Effect.fn("ModeratedDanceIntake.read")(function* (
    communityId: string,
    sessionId: string,
    uploadId: string | null,
    termsHash: string | null,
  ) {
    return yield* withRetainedControlPlaneCommandTransaction((tx) =>
      call(
        tx,
        "dance.intake.owned-read",
        "SELECT read_owned_moderated_dance_session_v1($1,$2,$3,$4,$5) AS packet",
        [accountId, communityId, sessionId, uploadId, termsHash],
      ),
    ).pipe(Effect.provide(runtime), Effect.mapError(classify));
  });
  const getSession = Effect.fn("ModeratedDanceIntake.getSession")(function* (
    communityId: string,
    sessionId: string,
  ) {
    return yield* parse(ModeratedDanceSessionView, yield* read(communityId, sessionId, null, null));
  });
  const uploadAccess = Effect.fn("ModeratedDanceIntake.uploadAccess")(function* (
    communityId: string,
    sessionId: string,
    uploadId: string,
    termsHash: string,
  ) {
    const target = yield* parse(access, yield* read(communityId, sessionId, uploadId, termsHash));
    if (input.signer === null) return yield* fail("unavailable");
    const signed = yield* Effect.tryPromise({
      try: () => input.signer?.presign(target) ?? Promise.reject(fail("unavailable")),
      catch: classify,
    });
    return {
      version: "dance-moderated-upload-access-v1" as const,
      upload_id: uploadId,
      url: signed.url,
      expires_at_ms: signed.expiresAtMs,
      content_type: target.contentType,
      size_bytes: target.sizeBytes,
      required_headers: [
        { name: "content-type" as const, value: target.contentType },
        { name: "if-none-match" as const, value: "*" },
      ],
    };
  });
  const captureOptions = Effect.fn("ModeratedDanceIntake.captureOptions")(function* (
    communityId: string,
    postId: string,
    cursor: string | null = null,
  ) {
    const raw = yield* withRetainedControlPlaneCommandTransaction((tx) =>
      call(
        tx,
        "dance.intake.capture-options",
        "SELECT read_moderated_dance_capture_options_v1($1,$2,$3,$4) AS packet",
        [accountId, communityId, postId, cursor],
      ),
    ).pipe(Effect.provide(runtime), Effect.mapError(classify));
    return yield* parse(ModeratedDanceCaptureOptions, raw);
  });
  const createReference = Effect.fn("ModeratedDanceIntake.createReference")(function* (
    raw: unknown,
  ) {
    const body = yield* parse(CreateModeratedDanceReferenceBody, raw),
      hash = yield* canonicalBodyHash([
        "moderated-dance-reference-command-v1",
        accountId,
        body,
      ]).pipe(Effect.mapError(classify));
    const result = yield* withRetainedControlPlaneCommandTransaction((tx) =>
      call(
        tx,
        "dance.reference.create",
        "SELECT create_moderated_dance_reference_v1($1,$2::jsonb,$3,$4,$5) AS packet",
        [accountId, JSON.stringify(body), hash, id(), id()],
      ),
    ).pipe(Effect.provide(runtime), Effect.mapError(classify));
    return yield* parse(ModeratedDanceReferenceStatus, result);
  });
  const getReference = Effect.fn("ModeratedDanceIntake.getReference")(function* (
    communityId: string,
    postId: string,
    choreographyId: string,
  ) {
    const raw = yield* withRetainedControlPlaneCommandTransaction((tx) =>
      call(
        tx,
        "dance.reference.status",
        "SELECT read_owned_moderated_dance_reference_v1($1,$2,$3,$4) AS packet",
        [accountId, communityId, postId, choreographyId],
      ),
    ).pipe(Effect.provide(runtime), Effect.mapError(classify));
    if (raw === null) return yield* new DanceReviewServiceFailure({ reason: "not_found" });
    return yield* parse(ModeratedDanceReferenceStatus, raw);
  });
  const captureContext = Effect.fn("ModeratedDanceIntake.captureContext")(function* (
    communityId: string,
    sessionId: string,
  ) {
    return yield* withRetainedControlPlaneCommandTransaction((tx) =>
      Effect.gen(function* () {
        const packet = yield* call(
          tx,
          "dance.intake.capture-context",
          "SELECT read_owned_moderated_dance_capture_context_v1($1,$2,$3) AS packet",
          [accountId, communityId, sessionId],
        );
        return yield* decodeModeratedDanceCaptureContext(
          packet,
          { accountId, communityId, sessionId },
          input.rewardsEnabled === true,
        );
      }),
    ).pipe(Effect.provide(runtime), Effect.mapError(classify));
  });
  const ownerRubric = Effect.fn("ModeratedDanceIntake.ownerRubric")(function* (
    communityId: string,
    reviewId: string,
  ) {
    return yield* withRetainedControlPlaneCommandTransaction((tx) =>
      Effect.gen(function* () {
        const packet = yield* call(
          tx,
          "dance.intake.owner-rubric",
          "SELECT read_moderated_dance_owner_rubric_v1($1,$2,$3) AS packet",
          [accountId, communityId, reviewId],
        );
        return yield* decodeModeratedDanceOwnerRubric(packet, communityId, reviewId);
      }),
    ).pipe(Effect.provide(runtime), Effect.mapError(classify));
  });
  return {
    command,
    getSession,
    uploadAccess,
    captureOptions,
    createReference,
    getReference,
    captureContext,
    ownerRubric,
  };
}
