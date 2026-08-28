import { TextModerationProviderError } from "@pirate/application";
import type { ImageModerationProviderServiceV1 } from "@pirate/application/media/processing-contracts";
import type {
  NormalizedModerationInputEvidenceV1,
  TextModerationProviderEvaluationV1,
  TextModerationProviderServiceV1,
} from "@pirate/application/text-moderation-runtime";
import {
  MODERATION_POLICY_CATEGORIES_V1,
  type ModerationPolicyCategoryV1,
  type TextModerationInputV1,
} from "@pirate/contracts";
import { canonicalTextModerationInput } from "@pirate/domain";
import { Effect, Predicate, Schema } from "effect";

export const OPENAI_MODERATION_MODEL = "omni-moderation-2024-09-26" as const;
export const OPENAI_MODERATION_BASE_URL = "https://api.openai.com/v1" as const;
export const OPENAI_MODERATION_TIMEOUT_MS = 10_000 as const;
export const OPENAI_MODERATION_MAX_RESPONSE_BYTES = 1_048_576 as const;
export const OPENAI_MODERATION_MAX_REQUEST_BYTES = 1_048_576 as const;

const Probability = Schema.Number.check(
  Schema.makeFilter((value) =>
    Number.isFinite(value) && value >= 0 && value <= 1
      ? undefined
      : "Expected a finite moderation probability",
  ),
);
const AppliedInputTypes = Schema.Array(Schema.Literals(["text", "image"]));

const Categories = Schema.Struct({
  harassment: Schema.Boolean,
  "harassment/threatening": Schema.Boolean,
  hate: Schema.Boolean,
  "hate/threatening": Schema.Boolean,
  illicit: Schema.Boolean,
  "illicit/violent": Schema.Boolean,
  "self-harm": Schema.Boolean,
  "self-harm/intent": Schema.Boolean,
  "self-harm/instructions": Schema.Boolean,
  sexual: Schema.Boolean,
  "sexual/minors": Schema.Boolean,
  violence: Schema.Boolean,
  "violence/graphic": Schema.Boolean,
});
const Scores = Schema.Struct({
  harassment: Probability,
  "harassment/threatening": Probability,
  hate: Probability,
  "hate/threatening": Probability,
  illicit: Probability,
  "illicit/violent": Probability,
  "self-harm": Probability,
  "self-harm/intent": Probability,
  "self-harm/instructions": Probability,
  sexual: Probability,
  "sexual/minors": Probability,
  violence: Probability,
  "violence/graphic": Probability,
});
const Applied = Schema.Struct({
  harassment: AppliedInputTypes,
  "harassment/threatening": AppliedInputTypes,
  hate: AppliedInputTypes,
  "hate/threatening": AppliedInputTypes,
  illicit: AppliedInputTypes,
  "illicit/violent": AppliedInputTypes,
  "self-harm": AppliedInputTypes,
  "self-harm/intent": AppliedInputTypes,
  "self-harm/instructions": AppliedInputTypes,
  sexual: AppliedInputTypes,
  "sexual/minors": AppliedInputTypes,
  violence: AppliedInputTypes,
  "violence/graphic": AppliedInputTypes,
});
const OpenAiModerationResponse = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  results: Schema.Array(
    Schema.Struct({
      flagged: Schema.Boolean,
      categories: Categories,
      category_scores: Scores,
      category_applied_input_types: Applied,
    }),
  ),
});

export type OpenAiModerationTransport = (request: Request) => Promise<Response>;

export type OpenAiModerationDiagnostic = Readonly<{
  readonly outcome: "fetch_error" | "non_success";
  readonly status?: number;
  readonly error_type?: string;
  readonly error_code?: string;
  readonly error_name?: string;
  readonly rate_limit_requests?: string;
  readonly rate_limit_remaining_requests?: string;
  readonly retry_after?: string;
}>;

export type OpenAiTextModerationOptions = Readonly<{
  readonly apiKey: string;
  readonly model?: typeof OPENAI_MODERATION_MODEL;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly transport?: OpenAiModerationTransport;
  readonly reportDiagnostic?: (diagnostic: OpenAiModerationDiagnostic) => void;
}>;

class OpenAiModerationFailure extends Error {
  constructor(readonly reason: TextModerationProviderError["reason"]) {
    super(reason);
  }
}

const digestHex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const exactCategoryKeys = (value: unknown): boolean => {
  if (!Predicate.isObject(value)) return false;
  const expected = new Set<string>(MODERATION_POLICY_CATEGORIES_V1);
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
};

const closedCategoryObjects = (value: unknown): boolean => {
  if (!Predicate.isObject(value) || !Array.isArray(value.results)) return false;
  return value.results.every(
    (result) =>
      Predicate.isObject(result) &&
      exactCategoryKeys(result.categories) &&
      exactCategoryKeys(result.category_scores) &&
      exactCategoryKeys(result.category_applied_input_types),
  );
};

const readBoundedBody = async (
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > limit) {
      throw new OpenAiModerationFailure("invalid");
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new OpenAiModerationFailure("timeout");
      const next = await reader.read();
      if (next.done) break;
      if (next.value === undefined) throw new OpenAiModerationFailure("invalid");
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel("moderation response limit exceeded");
        throw new OpenAiModerationFailure("invalid");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const textInputs = (input: TextModerationInputV1): readonly string[] =>
  [input.title, input.body].filter((value): value is string => value !== null);

const safeDiagnosticToken = (value: string | null): string | undefined =>
  value !== null && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : undefined;

const reportDiagnosticSafely = (
  report: (diagnostic: OpenAiModerationDiagnostic) => void,
  diagnostic: OpenAiModerationDiagnostic,
): void => {
  try {
    report(diagnostic);
  } catch {
    // Diagnostics must never alter fail-closed moderation behavior.
  }
};

const boundedProviderErrorMetadata = async (
  response: Response,
  signal: AbortSignal,
): Promise<Pick<OpenAiModerationDiagnostic, "error_code" | "error_type">> => {
  try {
    const bytes = await readBoundedBody(response, 16_384, signal);
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Predicate.isObject(raw) || !Predicate.isObject(raw.error)) return {};
    const errorType =
      typeof raw.error.type === "string" ? safeDiagnosticToken(raw.error.type) : undefined;
    const errorCode =
      typeof raw.error.code === "string" ? safeDiagnosticToken(raw.error.code) : undefined;
    return {
      ...(errorType === undefined ? {} : { error_type: errorType }),
      ...(errorCode === undefined ? {} : { error_code: errorCode }),
    };
  } catch {
    return {};
  }
};

const validateOptions = (options: OpenAiTextModerationOptions) => {
  const model = options.model ?? OPENAI_MODERATION_MODEL;
  const baseUrl = options.baseUrl ?? OPENAI_MODERATION_BASE_URL;
  const timeoutMs = options.timeoutMs ?? OPENAI_MODERATION_TIMEOUT_MS;
  const maxRequestBytes = options.maxRequestBytes ?? OPENAI_MODERATION_MAX_REQUEST_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? OPENAI_MODERATION_MAX_RESPONSE_BYTES;
  let endpoint: URL;
  try {
    endpoint = new URL(`${baseUrl.replace(/\/$/u, "")}/moderations`);
  } catch {
    throw new Error("Invalid OpenAI moderation configuration");
  }
  if (
    model !== OPENAI_MODERATION_MODEL ||
    baseUrl !== OPENAI_MODERATION_BASE_URL ||
    options.apiKey.length === 0 ||
    options.apiKey.trim() !== options.apiKey ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes <= 0 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0
  ) {
    throw new Error("Invalid OpenAI moderation configuration");
  }
  return { model, endpoint: endpoint.toString(), timeoutMs, maxRequestBytes, maxResponseBytes };
};

export function makeOpenAiTextModerationProvider(
  options: OpenAiTextModerationOptions,
): TextModerationProviderServiceV1 & ImageModerationProviderServiceV1 {
  const config = validateOptions(options);
  const transport = options.transport ?? ((request: Request) => fetch(request));
  const reportDiagnostic =
    options.reportDiagnostic ??
    ((diagnostic: OpenAiModerationDiagnostic) =>
      console.warn("openai_moderation_provider_failure", diagnostic));

  const requestModeration = async (inputs: readonly unknown[]) => {
    const body = new TextEncoder().encode(JSON.stringify({ model: config.model, input: inputs }));
    if (body.byteLength > config.maxRequestBytes) {
      throw new OpenAiModerationFailure("invalid");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("moderation timeout"), config.timeoutMs);
    try {
      let response: Response;
      try {
        response = await transport(
          new Request(config.endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              "content-type": "application/json",
            },
            body,
            signal: controller.signal,
            redirect: "error",
          }),
        );
      } catch (cause) {
        if (controller.signal.aborted) throw new OpenAiModerationFailure("timeout");
        reportDiagnosticSafely(reportDiagnostic, {
          outcome: "fetch_error",
          error_name: cause instanceof Error ? cause.name : "unknown",
        });
        throw cause;
      }
      if (!response.ok) {
        const providerMetadata = await boundedProviderErrorMetadata(response, controller.signal);
        const rateLimitRequests = safeDiagnosticToken(
          response.headers.get("x-ratelimit-limit-requests"),
        );
        const rateLimitRemainingRequests = safeDiagnosticToken(
          response.headers.get("x-ratelimit-remaining-requests"),
        );
        const retryAfter = safeDiagnosticToken(response.headers.get("retry-after"));
        reportDiagnosticSafely(reportDiagnostic, {
          outcome: "non_success",
          status: response.status,
          ...providerMetadata,
          ...(rateLimitRequests === undefined ? {} : { rate_limit_requests: rateLimitRequests }),
          ...(rateLimitRemainingRequests === undefined
            ? {}
            : { rate_limit_remaining_requests: rateLimitRemainingRequests }),
          ...(retryAfter === undefined ? {} : { retry_after: retryAfter }),
        });
        throw new OpenAiModerationFailure("unavailable");
      }
      const responseBytes = await readBoundedBody(
        response,
        config.maxResponseBytes,
        controller.signal,
      );
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes));
      } catch {
        throw new OpenAiModerationFailure("invalid");
      }
      if (!closedCategoryObjects(raw)) throw new OpenAiModerationFailure("invalid");
      let decoded: Schema.Schema.Type<typeof OpenAiModerationResponse>;
      try {
        decoded = Schema.decodeUnknownSync(OpenAiModerationResponse, {
          onExcessProperty: "error",
        })(raw);
      } catch {
        throw new OpenAiModerationFailure("invalid");
      }
      if (
        decoded.model !== config.model ||
        decoded.results.length === 0 ||
        decoded.results.length !== inputs.length
      ) {
        throw new OpenAiModerationFailure("invalid");
      }
      return decoded;
    } finally {
      clearTimeout(timer);
    }
  };

  const evaluate: TextModerationProviderServiceV1["evaluate"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        const canonical = canonicalTextModerationInput(input);
        if (canonical.kind !== "accepted") throw new OpenAiModerationFailure("invalid");
        const inputs = textInputs(input);
        const decoded = await requestModeration(inputs);
        const inputEvidence: NormalizedModerationInputEvidenceV1[] = [];
        const matched = new Set<ModerationPolicyCategoryV1>();
        for (let index = 0; index < decoded.results.length; index += 1) {
          const result = decoded.results[index];
          const text = inputs[index];
          if (result === undefined || text === undefined) {
            throw new OpenAiModerationFailure("invalid");
          }
          for (const category of MODERATION_POLICY_CATEGORIES_V1) {
            if (result.categories[category]) matched.add(category);
          }
          inputEvidence.push({
            input_sha256: await digestHex(new TextEncoder().encode(text)),
            categories: result.categories,
            scores: result.category_scores,
            applied_input_types: result.category_applied_input_types,
          });
        }
        return {
          provider_id: "openai",
          requested_model: config.model,
          returned_model: decoded.model,
          input_sha256: canonical.sha256,
          matched_categories: MODERATION_POLICY_CATEGORIES_V1.filter((category) =>
            matched.has(category),
          ),
          inputs: inputEvidence,
        } satisfies TextModerationProviderEvaluationV1;
      },
      catch: (cause) =>
        cause instanceof OpenAiModerationFailure
          ? new TextModerationProviderError({ reason: cause.reason })
          : new TextModerationProviderError({ reason: "unavailable" }),
    });

  const evaluateImage: ImageModerationProviderServiceV1["evaluateImage"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        if (
          input.bytes.byteLength === 0 ||
          !/^[0-9a-f]{64}$/u.test(input.sha256) ||
          !["image/jpeg", "image/png", "image/webp"].includes(input.mediaType)
        ) {
          throw new OpenAiModerationFailure("invalid");
        }
        const actualSha256 = await digestHex(input.bytes);
        if (actualSha256 !== input.sha256) throw new OpenAiModerationFailure("invalid");
        let binary = "";
        for (let offset = 0; offset < input.bytes.byteLength; offset += 32_768) {
          binary += String.fromCharCode(...input.bytes.subarray(offset, offset + 32_768));
        }
        const decoded = await requestModeration([
          {
            type: "image_url",
            image_url: { url: `data:${input.mediaType};base64,${btoa(binary)}` },
          },
        ]);
        const result = decoded.results[0];
        if (result === undefined) throw new OpenAiModerationFailure("invalid");
        const matched = MODERATION_POLICY_CATEGORIES_V1.filter(
          (category) => result.categories[category],
        );
        if (
          matched.some(
            (category) => !result.category_applied_input_types[category].includes("image"),
          )
        ) {
          throw new OpenAiModerationFailure("invalid");
        }
        return {
          provider_id: "openai",
          requested_model: config.model,
          returned_model: decoded.model,
          input_sha256: input.sha256,
          matched_categories: matched,
          evidence: {
            input_sha256: input.sha256,
            categories: result.categories,
            scores: result.category_scores,
            applied_input_types: result.category_applied_input_types,
          },
        };
      },
      catch: (cause) =>
        cause instanceof OpenAiModerationFailure
          ? new TextModerationProviderError({ reason: cause.reason })
          : new TextModerationProviderError({ reason: "unavailable" }),
    });

  return { evaluate, evaluateImage };
}
