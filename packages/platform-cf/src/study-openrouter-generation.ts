import {
  STUDY_LANGUAGE_PROFILE_PROMPT_V2,
  STUDY_LANGUAGE_PROFILE_SYSTEM_PROMPT_V2,
  STUDY_LANGUAGE_PROFILE_VALIDATOR_V2,
  STUDY_TRANSLATION_PROMPT_V2,
  STUDY_TRANSLATION_SYSTEM_PROMPT_V2,
  type StudyLanguageProfileAnalysis,
  type StudyLanguageProfileRequest,
  type StudyLanguageProfileTransport,
  StudyLanguageProfileUnavailable,
  type StudyTranslationGenerationRequest,
  StudyTranslationGenerationUnavailable,
  type StudyTranslationGeneratorTransport,
} from "@pirate/application";
import { LanguageTagV1 } from "@pirate/contracts";
import { Effect, Option, Schema } from "effect";

export const STUDY_OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions" as const;
export const STUDY_OPENROUTER_ADAPTER_V1 = "study_openrouter_adapter_v1" as const;

export type StudyOpenRouterProviderPolicy = Readonly<{
  requireParameters: true;
  dataCollection: "deny";
  zdr: true;
  allowFallbacks: false;
  order: readonly string[];
  only: readonly string[];
}>;

export type StudyOpenRouterFetch = (input: string, init: RequestInit) => Promise<Response>;

export type StudyOpenRouterLimits = Readonly<{
  maxRequestBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
}>;

type DisabledOptions = Readonly<{ enabled?: false }>;
type EnabledOptions = Readonly<{
  enabled: true;
  apiKey: string;
  model: string;
  providerPolicy: StudyOpenRouterProviderPolicy;
  accountPluginsDisabled: true;
  fetch?: StudyOpenRouterFetch;
  limits?: StudyOpenRouterLimits;
}>;
export type StudyOpenRouterOptions = DisabledOptions | EnabledOptions;

const DEFAULT_LIMITS: StudyOpenRouterLimits = {
  maxRequestBytes: 512 * 1024,
  maxResponseBytes: 512 * 1024,
  timeoutMs: 45_000,
};
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const BoundedText = Schema.NonEmptyString.check(Schema.isMaxLength(4_096));
const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const Confidence = Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })));
const LanguageUnit = Schema.Struct({
  study_unit_id: Identifier,
  detected_languages: Schema.Array(LanguageTagV1).check(Schema.isMaxLength(8)),
  dominant_language: Schema.NullOr(LanguageTagV1),
  mixed: Schema.Boolean,
  vocable_only: Schema.Boolean,
  proper_name_only: Schema.Boolean,
  confidence: Confidence,
});
const LanguageOutput = Schema.Struct({
  units: Schema.Array(LanguageUnit).check(Schema.isMaxLength(256)),
});
const ProviderEnvelope = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.optional(Schema.NullOr(Identifier)),
    model: Schema.optional(Schema.NullOr(Identifier)),
    provider: Schema.optional(Schema.NullOr(Identifier)),
    choices: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          message: Schema.StructWithRest(Schema.Struct({ content: BoundedText }), [
            Schema.Record(Schema.String, Schema.Unknown),
          ]),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ).check(Schema.isLengthBetween(1, 1)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const languageOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["units"],
  properties: {
    units: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "study_unit_id",
          "detected_languages",
          "dominant_language",
          "mixed",
          "vocable_only",
          "proper_name_only",
          "confidence",
        ],
        properties: {
          study_unit_id: { type: "string" },
          detected_languages: { type: "array", maxItems: 8, items: { type: "string" } },
          dominant_language: { type: ["string", "null"] },
          mixed: { type: "boolean" },
          vocable_only: { type: "boolean" },
          proper_name_only: { type: "boolean" },
          confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

const translationOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["units"],
  properties: {
    units: { type: "array", maxItems: 256, items: { type: "object" } },
  },
} as const;

const validConfiguration = (options: EnabledOptions): boolean => {
  const limits = options.limits ?? DEFAULT_LIMITS;
  return (
    options.apiKey.length > 0 &&
    options.apiKey === options.apiKey.trim() &&
    options.apiKey.length <= 4_096 &&
    options.model.length > 0 &&
    options.model === options.model.trim() &&
    options.model.length <= 256 &&
    options.accountPluginsDisabled === true &&
    options.providerPolicy.order.length > 0 &&
    options.providerPolicy.only.length > 0 &&
    limits.maxRequestBytes > 0 &&
    limits.maxRequestBytes <= 1024 * 1024 &&
    limits.maxResponseBytes > 0 &&
    limits.maxResponseBytes <= 1024 * 1024 &&
    limits.timeoutMs > 0 &&
    limits.timeoutMs <= 120_000
  );
};

const requestBody = (
  options: EnabledOptions,
  systemPrompt: string,
  schema: Readonly<Record<string, unknown>>,
  payload: unknown,
): Uint8Array | null => {
  let bytes: Uint8Array;
  try {
    bytes = textEncoder.encode(
      JSON.stringify({
        model: options.model,
        messages: [
          {
            role: "system",
            content: `${systemPrompt}\nOutput JSON Schema: ${JSON.stringify(schema)}`,
          },
          { role: "user", content: [{ type: "text", text: JSON.stringify(payload) }] },
        ],
        stream: false,
        provider: {
          require_parameters: options.providerPolicy.requireParameters,
          data_collection: options.providerPolicy.dataCollection,
          zdr: options.providerPolicy.zdr,
          allow_fallbacks: options.providerPolicy.allowFallbacks,
          order: [...options.providerPolicy.order],
          only: [...options.providerPolicy.only],
        },
        response_format: { type: "json_object" },
      }),
    );
  } catch {
    return null;
  }
  return bytes.byteLength <= (options.limits ?? DEFAULT_LIMITS).maxRequestBytes ? bytes : null;
};

const readBounded = async (
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("aborted");
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      size += chunk.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("response_too_large");
        throw new Error("response_too_large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

type ProviderResult = Readonly<{
  providerId: string;
  providerModel: string;
  output: unknown;
}>;

const invoke = (
  options: EnabledOptions,
  body: Uint8Array,
): Effect.Effect<ProviderResult, "provider" | "invalid-result"> =>
  Effect.tryPromise({
    try: async () => {
      const limits = options.limits ?? DEFAULT_LIMITS;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("timeout"), limits.timeoutMs);
      try {
        const response = await (options.fetch ?? fetch)(STUDY_OPENROUTER_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal: controller.signal,
          redirect: "manual",
        });
        const bytes = await readBounded(response, limits.maxResponseBytes, controller.signal);
        if (response.status !== 200) throw new Error("provider_status");
        const envelopeJson = JSON.parse(textDecoder.decode(bytes)) as unknown;
        const envelope = Option.getOrThrow(
          Schema.decodeUnknownOption(ProviderEnvelope, { onExcessProperty: "ignore" })(
            envelopeJson,
          ),
        );
        const choice = envelope.choices[0];
        if (choice === undefined) throw new Error("missing_choice");
        return {
          providerId: envelope.provider ?? "openrouter",
          providerModel: envelope.model ?? options.model,
          output: JSON.parse(choice.message.content) as unknown,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    catch: () => "provider" as const,
  }).pipe(
    Effect.flatMap((result) =>
      result.output === null || typeof result.output !== "object"
        ? Effect.fail("invalid-result" as const)
        : Effect.succeed(result),
    ),
  );

const languagePayload = (request: StudyLanguageProfileRequest) => ({
  kind: "quoted_song_language_profile_request_v1",
  identity: {
    community_id: request.communityId,
    post_id: request.postId,
    lyrics_revision: request.lyricsRevision,
    source_hash: request.sourceHash,
  },
  song_language_hints: {
    primary: request.primaryLanguageHint,
    secondary: request.secondaryLanguageHint,
  },
  ordered_song_lines: request.contextLines.map((line) => ({
    ordinal: line.ordinal,
    lyric_line_id: line.lyricLineId,
    line_version: line.lineVersion,
    study_unit_id: line.studyUnitId,
    source_text: line.sourceText,
  })),
  ordered_study_units: request.units.map((unit) => ({
    study_unit_id: unit.studyUnitId,
    source_text: unit.sourceText,
  })),
});

const translationPayload = (request: StudyTranslationGenerationRequest) => ({
  kind: "quoted_song_translation_generation_request_v1",
  identity: {
    generation_run_id: request.generationRunId,
    community_id: request.communityId,
    post_id: request.postId,
    lyrics_revision: request.lyricsRevision,
    lyrics_source_hash: request.lyricsSourceHash,
    language_profile_revision: request.languageProfileRevision,
  },
  learning_language: request.learningLanguage,
  target_language: request.targetLanguage,
  learner_band: request.learnerBand,
  ordered_song_lines: request.contextLines.map((line) => ({
    ordinal: line.ordinal,
    lyric_line_id: line.lyricLineId,
    line_version: line.lineVersion,
    study_unit_id: line.studyUnitId,
    source_text: line.sourceText,
  })),
  ordered_study_units: request.units.map((unit) => ({
    study_unit_id: unit.studyUnitId,
    lyric_line_id: unit.lyricLineId,
    line_version: unit.lineVersion,
    source_hash: unit.sourceHash,
    source_text: unit.sourceText,
    previous_context: unit.previousContext,
    next_context: unit.nextContext,
    language: unit.language,
  })),
});

export const makeOpenRouterStudyLanguageProfileTransport = (
  options: StudyOpenRouterOptions,
): StudyLanguageProfileTransport => ({
  analyze: (request) => {
    if (!options.enabled) {
      return Effect.fail(new StudyLanguageProfileUnavailable({ reason: "disabled" }));
    }
    if (!validConfiguration(options)) {
      return Effect.fail(new StudyLanguageProfileUnavailable({ reason: "disabled" }));
    }
    const body = requestBody(
      options,
      STUDY_LANGUAGE_PROFILE_SYSTEM_PROMPT_V2,
      languageOutputSchema,
      languagePayload(request),
    );
    if (body === null) {
      return Effect.fail(new StudyLanguageProfileUnavailable({ reason: "invalid-result" }));
    }
    return invoke(options, body).pipe(
      Effect.flatMap((result) => {
        const output = Schema.decodeUnknownOption(LanguageOutput, { onExcessProperty: "error" })(
          result.output,
        );
        if (Option.isNone(output)) {
          return Effect.fail(new StudyLanguageProfileUnavailable({ reason: "invalid-result" }));
        }
        const analysis: StudyLanguageProfileAnalysis = {
          providerId: result.providerId,
          providerModel: result.providerModel,
          promptRevision: STUDY_LANGUAGE_PROFILE_PROMPT_V2,
          validatorRevision: STUDY_LANGUAGE_PROFILE_VALIDATOR_V2,
          units: output.value.units.map((unit) => ({
            studyUnitId: unit.study_unit_id,
            detectedLanguages: unit.detected_languages,
            dominantLanguage: unit.dominant_language,
            mixed: unit.mixed,
            vocableOnly: unit.vocable_only,
            properNameOnly: unit.proper_name_only,
            confidence: unit.confidence,
          })),
        };
        return Effect.succeed(analysis);
      }),
      Effect.catch((reason) =>
        Effect.fail(
          reason instanceof StudyLanguageProfileUnavailable
            ? reason
            : new StudyLanguageProfileUnavailable({ reason }),
        ),
      ),
    );
  },
});

export const makeOpenRouterStudyTranslationTransport = (
  options: StudyOpenRouterOptions,
): StudyTranslationGeneratorTransport => ({
  generate: (request) => {
    if (!options.enabled) {
      return Effect.fail(new StudyTranslationGenerationUnavailable({ reason: "disabled" }));
    }
    if (!validConfiguration(options)) {
      return Effect.fail(new StudyTranslationGenerationUnavailable({ reason: "disabled" }));
    }
    const body = requestBody(
      options,
      STUDY_TRANSLATION_SYSTEM_PROMPT_V2,
      translationOutputSchema,
      translationPayload(request),
    );
    if (body === null) {
      return Effect.fail(new StudyTranslationGenerationUnavailable({ reason: "invalid-result" }));
    }
    return invoke(options, body).pipe(
      Effect.map((result) => ({
        generation_run_id: request.generationRunId,
        provider_id: result.providerId,
        provider_model: result.providerModel,
        prompt_revision: STUDY_TRANSLATION_PROMPT_V2,
        units:
          result.output !== null && typeof result.output === "object" && "units" in result.output
            ? (result.output as { readonly units: unknown }).units
            : null,
      })),
      Effect.mapError((reason) => new StudyTranslationGenerationUnavailable({ reason })),
    );
  },
});
