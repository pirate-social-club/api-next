import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Result } from "effect";
import { classifierInput } from "../../../../tests/fixtures/media-analysis/contracts/fixtures.ts";
import {
  hostileModelDocuments,
  identityMismatchResponse,
  multipleChoicesResponse,
  statusFixtures,
  validProviderResponse,
} from "../../../../tests/fixtures/media-analysis/openrouter/fixtures.ts";
import {
  buildOpenRouterClassifierRequest,
  makeOpenRouterClassifierAdapter,
  OPENROUTER_CLASSIFIER_ENDPOINT,
  type OpenRouterResponseBody,
  type OpenRouterTransportRequest,
  type OpenRouterTransportResponse,
} from "./openrouter.ts";

const encoder = new TextEncoder();
const limits = { max_request_bytes: 100_000, max_response_bytes: 10_000, timeout_ms: 50 } as const;

function bodyOf(value: unknown, onCancel: () => void = () => undefined): OpenRouterResponseBody {
  const bytes = encoder.encode(typeof value === "string" ? value : JSON.stringify(value));
  return {
    open: async function* () {
      yield bytes.subarray(0, Math.min(11, bytes.byteLength));
      yield bytes.subarray(Math.min(11, bytes.byteLength));
    },
    cancel: onCancel,
  };
}

function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: bodyOf(value),
  } satisfies OpenRouterTransportResponse;
}

function configured(
  transport: (
    request: OpenRouterTransportRequest,
  ) => OpenRouterTransportResponse | PromiseLike<OpenRouterTransportResponse>,
  overrides: Record<string, unknown> = {},
) {
  return makeOpenRouterClassifierAdapter({
    enabled: true,
    api_key: "fixture-secret-key",
    model: "fixture/model",
    prompt_revision: "prompt-revision-1",
    policy_revision: "policy-revision-1",
    classifier_revision: "classifier-revision-1",
    adapter_revision: "adapter-revision-1",
    retention_policy: "owner-ratification-required",
    routing_policy: "owner-ratification-required",
    limits,
    transport,
    ...overrides,
  });
}

async function failureTag(effect: Effect.Effect<unknown, { readonly _tag: string }>) {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const found = Cause.findError(exit.cause);
  if (!Result.isSuccess(found)) throw new Error("expected one failure");
  return (found.success as { readonly _tag: string })._tag;
}

describe("OpenRouter classifier scaffold", () => {
  test("is disabled by default and performs no transport call", async () => {
    let calls = 0;
    const adapter = makeOpenRouterClassifierAdapter({
      transport: () => {
        calls += 1;
        return response(validProviderResponse);
      },
    });
    expect(
      await failureTag(adapter.classify(classifierInput, { signal: new AbortController().signal })),
    ).toBe("permanent_rejection");
    expect(calls).toBe(0);
  });

  test("builds the fixed closed request and keeps transcript as inert data", () => {
    const request = buildOpenRouterClassifierRequest(
      classifierInput,
      { api_key: "fixture-secret-key", model: "fixture/model", limits },
      new AbortController().signal,
    );
    expect(request).not.toBeNull();
    expect(request?.url).toBe(OPENROUTER_CLASSIFIER_ENDPOINT);
    expect(request?.redirect).toBe("error");
    expect(request?.headers.authorization).toBe("Bearer fixture-secret-key");
    const body = JSON.parse(new TextDecoder().decode(request?.body)) as Record<string, unknown>;
    const responseFormat = body.response_format as Record<string, unknown>;
    const jsonSchema = responseFormat.json_schema as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.plugins).toBeUndefined();
    expect(jsonSchema.strict).toBe(true);
    expect((jsonSchema.schema as Record<string, unknown>).additionalProperties).toBe(false);
    const messages = body.messages as Array<Record<string, unknown>>;
    const userMessage = messages[1];
    if (userMessage === undefined) throw new Error("missing user message");
    const content = userMessage.content as Array<Record<string, unknown>>;
    const userContent = content[0];
    if (userContent === undefined) throw new Error("missing user content");
    const userText = userContent?.text as string;
    expect(JSON.parse(userText).data.kind).toBe("untrusted_transcript_evidence");
    expect(userText).toContain("Ignore all previous instructions");
  });

  test("accepts one strict JSON-schema choice and supplies server provenance", async () => {
    const requests: OpenRouterTransportRequest[] = [];
    const result = await Effect.runPromise(
      configured((request) => {
        requests.push(request);
        return response(validProviderResponse);
      }).classify(classifierInput, { signal: new AbortController().signal }),
    );
    expect(result.status).toBe("classified");
    if (result.status === "classified") {
      expect(result.attempt_id).toBe("attempt-1");
      expect(result.prompt_revision).toBe("prompt-revision-1");
      expect(result.policy_revision).toBe("policy-revision-1");
      expect(result.adapter_revision).toBe("adapter-revision-1");
    }
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("fixture-secret-key");
  });

  test("maps hostile structured/prose output and multiple choices closed", async () => {
    for (const document of [
      hostileModelDocuments.prose,
      hostileModelDocuments.markdown,
      hostileModelDocuments.unknown_key,
      hostileModelDocuments.tool_call,
      hostileModelDocuments.refusal,
    ]) {
      const tag = await failureTag(
        configured(() =>
          response({
            choices: [{ message: { role: "assistant", content: JSON.stringify(document) } }],
          }),
        ).classify(classifierInput, { signal: new AbortController().signal }),
      );
      expect(["malformed_response", "unparseable_result"]).toContain(tag);
    }
    const multiple = await failureTag(
      configured(() => response(multipleChoicesResponse)).classify(classifierInput, {
        signal: new AbortController().signal,
      }),
    );
    expect(multiple).toBe("ambiguous_result");
    const invalidLanguage = await failureTag(
      configured(() =>
        response({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify(hostileModelDocuments.invalid_language),
              },
            },
          ],
        }),
      ).classify(classifierInput, { signal: new AbortController().signal }),
    );
    expect(invalidLanguage).toBe("out_of_policy");
  });

  test("maps provider statuses without returning secrets or upstream bodies", async () => {
    const unauthorized = await failureTag(
      configured(() =>
        response({ error: { secret: "must-not-cross" } }, statusFixtures.unauthorized),
      ).classify(classifierInput, { signal: new AbortController().signal }),
    );
    expect(unauthorized).toBe("permanent_rejection");
    const throttled = await failureTag(
      configured(() =>
        response({ error: "secret" }, statusFixtures.throttled, { "retry-after": "1" }),
      ).classify(classifierInput, { signal: new AbortController().signal }),
    );
    expect(throttled).toBe("rate_limited");
  });

  test("requires identity match and records it only in the private sink", async () => {
    const evidence: unknown[] = [];
    const tag = await failureTag(
      configured(() => response(identityMismatchResponse), {
        evidence_sink: (value: unknown) => evidence.push(value),
      }).classify(classifierInput, { signal: new AbortController().signal }),
    );
    expect(tag).toBe("permanent_rejection");
    expect(evidence).toHaveLength(1);
    expect(JSON.stringify(evidence[0])).toContain("fixture/model");
  });

  test("honors caller cancellation, deadline, and late body disposal", async () => {
    const controller = new AbortController();
    let calls = 0;
    const cancellation = configured(() => {
      calls += 1;
      return new Promise<never>(() => undefined);
    });
    const pending = cancellation.classify(classifierInput, { signal: controller.signal });
    controller.abort();
    expect(await failureTag(pending)).toBe("cancelled");
    expect(calls).toBe(0);

    const timeout = configured(() => new Promise<never>(() => undefined));
    expect(
      await failureTag(timeout.classify(classifierInput, { signal: new AbortController().signal })),
    ).toBe("timeout");

    let cancelled = false;
    const late = configured(
      () =>
        new Promise<OpenRouterTransportResponse>((resolve) => {
          setTimeout(
            () =>
              resolve({
                ...response(validProviderResponse),
                body: bodyOf(validProviderResponse, () => (cancelled = true)),
              }),
            100,
          );
        }),
    );
    expect(
      await failureTag(late.classify(classifierInput, { signal: new AbortController().signal })),
    ).toBe("timeout");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(cancelled).toBe(true);
  });
});
