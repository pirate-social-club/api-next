import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Fiber, Result } from "effect";
import { classifierInput } from "../../../../tests/fixtures/media-analysis/contracts/fixtures.ts";
import {
  authorityChoiceResponse,
  conflictingProviderResponse,
  hostileModelDocuments,
  identityMatrixResponses,
  identityMismatchResponse,
  missingMetadataResponse,
  multipleChoicesResponse,
  nonStopFinishResponse,
  providerPolicy,
  statusFixtures,
  unboundedMetadataResponse,
  unknownRootFieldResponse,
  validProviderResponse,
  wrongIndexResponse,
  zeroChoicesResponse,
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

function modelResponse(document: unknown) {
  return {
    ...validProviderResponse,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(document) },
      },
    ],
  };
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
    provider_policy: providerPolicy,
    account_plugins_disabled: true,
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

  test("builds the fixed closed request and keeps transcript and lyrics as inert data", () => {
    const request = buildOpenRouterClassifierRequest(
      classifierInput,
      {
        api_key: "fixture-secret-key",
        model: "fixture/model",
        provider_policy: providerPolicy,
        account_plugins_disabled: true,
        limits,
      },
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
    expect(body.tool_choice).toBe("none");
    expect(body.provider).toEqual(providerPolicy);
    expect(request?.headers["x-openrouter-metadata"]).toBe("enabled");
    expect(
      buildOpenRouterClassifierRequest(
        classifierInput,
        {
          api_key: "fixture-secret-key",
          model: "fixture/model",
          provider_policy: providerPolicy,
          account_plugins_disabled: true,
          limits: { ...limits, max_request_bytes: 1 },
        },
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(
      buildOpenRouterClassifierRequest(
        classifierInput,
        {
          api_key: "fixture-secret-key",
          model: "fixture/model",
          provider_policy: providerPolicy,
          account_plugins_disabled: false,
          limits,
        } as never,
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(jsonSchema.strict).toBe(true);
    expect((jsonSchema.schema as Record<string, unknown>).additionalProperties).toBe(false);
    const messages = body.messages as Array<Record<string, unknown>>;
    const userMessage = messages[1];
    if (userMessage === undefined) throw new Error("missing user message");
    const content = userMessage.content as Array<Record<string, unknown>>;
    const userContent = content[0];
    if (userContent === undefined) throw new Error("missing user content");
    const userText = userContent?.text as string;
    const hostileInputs = JSON.parse(userText);
    expect(hostileInputs.transcript_data.kind).toBe("untrusted_transcript_evidence");
    expect(hostileInputs.lyrics_data.kind).toBe("untrusted_author_lyrics");
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
      expect(result.transcript_identity.transcript_sha256).toBe(
        classifierInput.transcript.transcript_sha256,
      );
      expect(result.lyrics_identity.lyrics_revision).toBe(
        classifierInput.accepted_lyrics.lyrics_revision,
      );
    }
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("fixture-secret-key");
    expect(
      await failureTag(
        configured(() => response(unknownRootFieldResponse)).classify(classifierInput, {
          signal: new AbortController().signal,
        }),
      ),
    ).toBe("malformed_response");
    expect(
      await failureTag(
        configured(() => response(unboundedMetadataResponse)).classify(classifierInput, {
          signal: new AbortController().signal,
        }),
      ),
    ).toBe("malformed_response");
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
        configured(() => response(modelResponse(document))).classify(classifierInput, {
          signal: new AbortController().signal,
        }),
      );
      expect(["malformed_response", "unparseable_result"]).toContain(tag);
    }
    const multiple = await failureTag(
      configured(() => response(multipleChoicesResponse)).classify(classifierInput, {
        signal: new AbortController().signal,
      }),
    );
    expect(multiple).toBe("ambiguous_result");
    expect(
      await failureTag(
        configured(() => response(zeroChoicesResponse)).classify(classifierInput, {
          signal: new AbortController().signal,
        }),
      ),
    ).toBe("malformed_response");
    for (const envelope of [wrongIndexResponse, nonStopFinishResponse]) {
      expect(
        await failureTag(
          configured(() => response(envelope)).classify(classifierInput, {
            signal: new AbortController().signal,
          }),
        ),
      ).toBe("malformed_response");
    }
    const invalidLanguage = await failureTag(
      configured(() => response(modelResponse(hostileModelDocuments.invalid_language))).classify(
        classifierInput,
        { signal: new AbortController().signal },
      ),
    );
    expect(invalidLanguage).toBe("out_of_policy");
    const unsafeUncertainDowngrade = await failureTag(
      configured(() =>
        response(modelResponse(hostileModelDocuments.uncertain_safety_downgrade)),
      ).classify(classifierInput, { signal: new AbortController().signal }),
    );
    expect(unsafeUncertainDowngrade).toBe("out_of_policy");
    const outOfBounds = await failureTag(
      configured(() =>
        response(modelResponse(hostileModelDocuments.out_of_bounds_evidence)),
      ).classify(classifierInput, { signal: new AbortController().signal }),
    );
    expect(outOfBounds).toBe("out_of_policy");
  });

  test("maps provider statuses without returning secrets or upstream bodies", async () => {
    const failureEvidence: unknown[] = [];
    const unauthorized = await failureTag(
      configured(
        () => response({ error: { secret: "must-not-cross" } }, statusFixtures.unauthorized),
        { evidence_sink: (value: unknown) => failureEvidence.push(value) },
      ).classify(classifierInput, { signal: new AbortController().signal }),
    );
    expect(unauthorized).toBe("permanent_rejection");
    expect(failureEvidence[0]).toMatchObject({ provider_status: statusFixtures.unauthorized });
    const throttled = await failureTag(
      configured(() =>
        response({ error: "secret" }, statusFixtures.throttled, { "retry-after": "1" }),
      ).classify(classifierInput, { signal: new AbortController().signal }),
    );
    expect(throttled).toBe("rate_limited");
    expect(
      await failureTag(
        configured(() => response({ error: "secret" }, statusFixtures.throttled)).classify(
          classifierInput,
          { signal: new AbortController().signal },
        ),
      ),
    ).toBe("provider_unavailable");
    for (const status of [
      statusFixtures.bad_request,
      statusFixtures.not_found,
      statusFixtures.too_large,
      statusFixtures.invalid_request,
    ]) {
      expect(
        await failureTag(
          configured(() => response("ignored", status)).classify(classifierInput, {
            signal: new AbortController().signal,
          }),
        ),
      ).toBe("permanent_rejection");
    }
    for (const status of [
      statusFixtures.timeout,
      statusFixtures.internal,
      statusFixtures.bad_gateway,
      statusFixtures.unavailable,
      statusFixtures.gateway_timeout,
    ]) {
      expect(
        await failureTag(
          configured(() => response("ignored", status)).classify(classifierInput, {
            signal: new AbortController().signal,
          }),
        ),
      ).toBe("provider_unavailable");
    }
  });

  test("requires identity match and records it only in the private sink", async () => {
    const evidence: unknown[] = [];
    const tag = await failureTag(
      configured(() => response(identityMismatchResponse), {
        evidence_sink: (value: unknown) => evidence.push(value),
      }).classify(classifierInput, { signal: new AbortController().signal }),
    );
    expect(tag).toBe("ambiguous_result");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      requested_model: "fixture/model",
      served_model: "different/model",
      completion_id: "completion-fixture",
      provider_status: 200,
    });
    expect(JSON.stringify(evidence[0])).not.toContain("fixture-secret-key");
    const successEvidence: unknown[] = [];
    expect(
      (
        await Effect.runPromise(
          configured(() => response(validProviderResponse), {
            evidence_sink: (value: unknown) => successEvidence.push(value),
          }).classify(classifierInput, { signal: new AbortController().signal }),
        )
      ).status,
    ).toBe("classified");
    expect(successEvidence[0]).toMatchObject({
      requested_model: "fixture/model",
      served_model: "fixture/model",
      selected_provider: "FixtureProvider",
      completion_id: "completion-fixture",
      provider_status: 200,
      outcome: "classified",
    });
    expect(
      await failureTag(
        configured(() => response(missingMetadataResponse)).classify(classifierInput, {
          signal: new AbortController().signal,
        }),
      ),
    ).toBe("ambiguous_result");
    expect(
      await failureTag(
        configured(() => response(conflictingProviderResponse)).classify(classifierInput, {
          signal: new AbortController().signal,
        }),
      ),
    ).toBe("ambiguous_result");
    expect(
      await failureTag(
        configured(() => response(authorityChoiceResponse)).classify(classifierInput, {
          signal: new AbortController().signal,
        }),
      ),
    ).toBe("malformed_response");
    for (const envelope of Object.values(identityMatrixResponses)) {
      expect(
        await failureTag(
          configured(() => response(envelope)).classify(classifierInput, {
            signal: new AbortController().signal,
          }),
        ),
      ).toBe("ambiguous_result");
    }
  });

  test("rejects missing provider policy without transport and snapshots config/input", async () => {
    let calls = 0;
    const mutablePolicy = { ...providerPolicy, order: ["FixtureProvider"] };
    const adapter = configured(
      (request) => {
        calls += 1;
        const body = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
        expect(body.provider).toEqual(providerPolicy);
        return response(validProviderResponse);
      },
      { provider_policy: mutablePolicy },
    );
    mutablePolicy.order[0] = "MutatedProvider";
    const mutableInput = structuredClone(classifierInput);
    const pending = adapter.classify(mutableInput, { signal: new AbortController().signal });
    (mutableInput.transcript as unknown as { transcript: string }).transcript =
      "mutated after classify";
    const result = await Effect.runPromise(pending);
    expect(result.status).toBe("classified");
    expect(calls).toBe(1);
    const missing = makeOpenRouterClassifierAdapter({
      enabled: true,
      api_key: "fixture-secret-key",
      model: "fixture/model",
      prompt_revision: "prompt-revision-1",
      policy_revision: "policy-revision-1",
      classifier_revision: "classifier-revision-1",
      adapter_revision: "adapter-revision-1",
      transport: () => {
        calls += 1;
        return response(validProviderResponse);
      },
    } as never);
    expect(
      await failureTag(missing.classify(classifierInput, { signal: new AbortController().signal })),
    ).toBe("permanent_rejection");
    expect(calls).toBe(1);
    const missingPlugins = makeOpenRouterClassifierAdapter({
      enabled: true,
      api_key: "fixture-secret-key",
      model: "fixture/model",
      prompt_revision: "prompt-revision-1",
      policy_revision: "policy-revision-1",
      classifier_revision: "classifier-revision-1",
      adapter_revision: "adapter-revision-1",
      provider_policy: providerPolicy,
      transport: () => {
        calls += 1;
        return response(validProviderResponse);
      },
    } as never);
    expect(
      await failureTag(
        missingPlugins.classify(classifierInput, { signal: new AbortController().signal }),
      ),
    ).toBe("permanent_rejection");
    expect(calls).toBe(1);
  });

  test("rejects oversized, wrong-content-type, and invalid UTF-8 responses", async () => {
    expect(
      await failureTag(
        configured(() => response("x".repeat(10_001))).classify(classifierInput, {
          signal: new AbortController().signal,
        }),
      ),
    ).toBe("malformed_response");
    expect(
      await failureTag(
        configured(() =>
          response(validProviderResponse, 200, { "content-length": "10001" }),
        ).classify(classifierInput, { signal: new AbortController().signal }),
      ),
    ).toBe("malformed_response");
    expect(
      await failureTag(
        configured(() => ({
          status: 200,
          headers: { "content-type": "application/json" },
          body: bodyOf('{"choices":['),
        })).classify(classifierInput, { signal: new AbortController().signal }),
      ),
    ).toBe("malformed_response");
    expect(
      await failureTag(
        configured(() => ({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: bodyOf(validProviderResponse),
        })).classify(classifierInput, { signal: new AbortController().signal }),
      ),
    ).toBe("malformed_response");
    expect(
      await failureTag(
        configured(() => ({
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            open: async function* () {
              yield new Uint8Array([0xff, 0xfe]);
            },
            cancel: () => undefined,
          },
        })).classify(classifierInput, { signal: new AbortController().signal }),
      ),
    ).toBe("malformed_response");
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

    let inFlightSignal: AbortSignal | undefined;
    const inFlightController = new AbortController();
    const inFlight = configured((request) => {
      inFlightSignal = request.signal;
      return new Promise<never>(() => undefined);
    });
    const inFlightPending = inFlight.classify(classifierInput, {
      signal: inFlightController.signal,
    });
    const inFlightExit = Effect.runPromiseExit(inFlightPending);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(inFlightSignal).toBeDefined();
    inFlightController.abort();
    expect(Exit.isFailure(await inFlightExit)).toBe(true);
    expect(inFlightSignal?.aborted).toBe(true);

    const timeout = configured(() => new Promise<never>(() => undefined));
    expect(
      await failureTag(timeout.classify(classifierInput, { signal: new AbortController().signal })),
    ).toBe("timeout");

    let readerCancelled = false;
    const bodyReadNeverSettles = configured(() => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        getReader: () => ({
          read: () => new Promise<never>(() => undefined),
          cancel: () => {
            readerCancelled = true;
          },
          releaseLock: () => undefined,
        }),
      },
    }));
    expect(
      await failureTag(
        bodyReadNeverSettles.classify(classifierInput, {
          signal: new AbortController().signal,
        }),
      ),
    ).toBe("timeout");
    expect(readerCancelled).toBe(true);

    let cancelled = false;
    const late = configured(
      () =>
        new Promise<OpenRouterTransportResponse>((resolve) => {
          setTimeout(
            () =>
              resolve({
                ...response(validProviderResponse),
                body: bodyOf(validProviderResponse, () => {
                  cancelled = true;
                  return Promise.reject(new Error("late cancellation failure"));
                }),
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

    let neverSettlingCancelCalled = false;
    const lateNeverSettles = configured(
      () =>
        new Promise<OpenRouterTransportResponse>((resolve) => {
          setTimeout(
            () =>
              resolve({
                ...response(validProviderResponse),
                body: bodyOf(validProviderResponse, () => {
                  neverSettlingCancelCalled = true;
                  return new Promise<never>(() => undefined);
                }),
              }),
            100,
          );
        }),
    );
    expect(
      await failureTag(
        lateNeverSettles.classify(classifierInput, { signal: new AbortController().signal }),
      ),
    ).toBe("timeout");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(neverSettlingCancelCalled).toBe(true);
  });

  test("aborts the transport when the Effect fiber is interrupted", async () => {
    let transportSignal: AbortSignal | undefined;
    const effect = configured((request) => {
      transportSignal = request.signal;
      return new Promise<never>(() => undefined);
    }).classify(classifierInput, { signal: new AbortController().signal });
    const fiber = Effect.runFork(effect);
    await Effect.runPromise(Effect.sleep(10));
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(transportSignal?.aborted).toBe(true);
  });
});
