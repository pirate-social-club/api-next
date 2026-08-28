import { describe, expect, test } from "bun:test";
import { MODERATION_POLICY_CATEGORIES_V1 } from "@pirate/contracts";
import { Cause, Effect, Exit, Result } from "effect";
import {
  makeOpenAiTextModerationProvider,
  OPENAI_MODERATION_MODEL,
} from "./openai-text-moderation.ts";

const input = {
  version: "text-moderation-input-v1",
  surface: "text_post",
  title: "Separate title",
  body: "Separate body",
} as const;

const categoryRecord = <A>(value: A): Record<string, A> =>
  Object.fromEntries(MODERATION_POLICY_CATEGORIES_V1.map((category) => [category, value]));

const result = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  flagged: false,
  categories: categoryRecord(false),
  category_scores: categoryRecord(0.01),
  category_applied_input_types: categoryRecord(["text"]),
  ...overrides,
});

const response = (results: readonly unknown[]) =>
  new Response(
    JSON.stringify({
      id: "modr_test",
      model: OPENAI_MODERATION_MODEL,
      results,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const failureReason = async (
  provider: ReturnType<typeof makeOpenAiTextModerationProvider>,
): Promise<string> => {
  const exit = await Effect.runPromiseExit(provider.evaluate(input));
  if (Exit.isSuccess(exit)) throw new Error("expected provider failure");
  const found = Cause.findError(exit.cause);
  const failure = Result.isSuccess(found) ? found.success : undefined;
  return typeof failure === "object" && failure !== null && "reason" in failure
    ? String(failure.reason)
    : "unknown";
};

describe("OpenAI text moderation provider", () => {
  test("sends a bounded private image as one data-url input", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    const provider = makeOpenAiTextModerationProvider({
      apiKey: "test-key",
      transport: async (request) => {
        const body = (await request.json()) as {
          model: string;
          input: readonly [{ type: string; image_url: { url: string } }];
        };
        expect(body.model).toBe(OPENAI_MODERATION_MODEL);
        expect(body.input).toHaveLength(1);
        expect(body.input[0]?.type).toBe("image_url");
        expect(body.input[0]?.image_url.url).toBe("data:image/webp;base64,AQIDBA==");
        return response([
          result({
            flagged: true,
            categories: { ...categoryRecord(false), sexual: true },
            category_applied_input_types: {
              ...categoryRecord([]),
              sexual: ["image"],
            },
          }),
        ]);
      },
    });

    const evaluated = await Effect.runPromise(
      provider.evaluateImage({ bytes, mediaType: "image/webp", sha256 }),
    );
    expect(evaluated.input_sha256).toBe(sha256);
    expect(evaluated.matched_categories).toEqual(["sexual"]);
    expect(evaluated.evidence.applied_input_types.sexual).toEqual(["image"]);
  });

  test("sends separate ordered fields to the pinned model in one exact request", async () => {
    let calls = 0;
    const provider = makeOpenAiTextModerationProvider({
      apiKey: "test-key",
      transport: async (request) => {
        calls += 1;
        expect(request.method).toBe("POST");
        expect(request.url).toBe("https://api.openai.com/v1/moderations");
        expect(request.headers.get("authorization")).toBe("Bearer test-key");
        expect(await request.json()).toEqual({
          model: OPENAI_MODERATION_MODEL,
          input: ["Separate title", "Separate body"],
        });
        const first = result({
          categories: { ...categoryRecord(false), harassment: true },
          category_scores: { ...categoryRecord(0.01), harassment: 0 },
        });
        const second = result({
          categories: { ...categoryRecord(false), "sexual/minors": false },
          category_scores: { ...categoryRecord(0.01), "sexual/minors": 1 },
        });
        return response([first, second]);
      },
    });

    const evaluated = await Effect.runPromise(provider.evaluate(input));
    expect(calls).toBe(1);
    expect(evaluated.matched_categories).toEqual(["harassment"]);
    expect(evaluated.inputs).toHaveLength(2);
    expect(evaluated.inputs[0]?.scores.harassment).toBe(0);
    expect(evaluated.inputs[1]?.scores["sexual/minors"]).toBe(1);
  });

  test("fails closed on unknown categories, malformed output, and empty results", async () => {
    const unknown = result({
      categories: { ...categoryRecord(false), future_category: true },
    });
    for (const providerResponse of [
      response([unknown, result()]),
      response([]),
      new Response("not-json", { status: 200 }),
    ]) {
      const provider = makeOpenAiTextModerationProvider({
        apiKey: "test-key",
        transport: async () => providerResponse.clone(),
      });
      expect(await failureReason(provider)).toBe("invalid");
    }
  });

  test("maps non-success, timeout, and response overflow without retrying", async () => {
    let unavailableCalls = 0;
    const unavailable = makeOpenAiTextModerationProvider({
      apiKey: "test-key",
      transport: async () => {
        unavailableCalls += 1;
        return new Response("busy", { status: 503 });
      },
    });
    expect(await failureReason(unavailable)).toBe("unavailable");
    expect(unavailableCalls).toBe(1);

    const timedOut = makeOpenAiTextModerationProvider({
      apiKey: "test-key",
      timeoutMs: 5,
      transport: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });
    expect(await failureReason(timedOut)).toBe("timeout");

    const oversized = makeOpenAiTextModerationProvider({
      apiKey: "test-key",
      maxResponseBytes: 32,
      transport: async () => response([result(), result()]),
    });
    expect(await failureReason(oversized)).toBe("invalid");
  });

  test("reports bounded non-success metadata without request or response content", async () => {
    const diagnostics: unknown[] = [];
    const provider = makeOpenAiTextModerationProvider({
      apiKey: "secret-test-key",
      reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      transport: async () =>
        new Response(
          JSON.stringify({
            error: {
              type: "insufficient_quota",
              code: "billing_hard_limit_reached",
              message: "Separate title secret-test-key",
            },
          }),
          {
            status: 429,
            headers: {
              "retry-after": "12",
              "x-ratelimit-limit-requests": "0",
              "x-ratelimit-remaining-requests": "0",
            },
          },
        ),
    });

    expect(await failureReason(provider)).toBe("unavailable");
    expect(diagnostics).toEqual([
      {
        outcome: "non_success",
        status: 429,
        error_type: "insufficient_quota",
        error_code: "billing_hard_limit_reached",
        rate_limit_requests: "0",
        rate_limit_remaining_requests: "0",
        retry_after: "12",
      },
    ]);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("Separate title");
    expect(serialized).not.toContain("Separate body");
    expect(serialized).not.toContain("secret-test-key");
    expect(serialized).not.toContain("message");
  });

  test("reports bounded transport causes without request content or credentials", async () => {
    const diagnostics: unknown[] = [];
    const provider = makeOpenAiTextModerationProvider({
      apiKey: "secret-test-key",
      reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      transport: async () => {
        throw new TypeError("fetch failed for Separate body secret-test-key", {
          cause: Object.assign(new Error("connect ECONNRESET https://api.openai.com/v1"), {
            cause: "socket closed near Separate title and sk-private-token",
          }),
        });
      },
    });

    expect(await failureReason(provider)).toBe("unavailable");
    expect(diagnostics).toEqual([
      {
        outcome: "fetch_error",
        error_name: "TypeError",
        error_message: "fetch failed for [redacted] [redacted]",
        cause_name: "Error",
        cause_message: "connect ECONNRESET [url]",
        cause_detail: "socket closed near [redacted] and [redacted]",
      },
    ]);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("Separate title");
    expect(serialized).not.toContain("Separate body");
    expect(serialized).not.toContain("secret-test-key");
    expect(serialized).not.toContain("sk-private-token");
    expect(serialized).not.toContain("api.openai.com");
  });

  test("rejects moving aliases, alternate origins, and malformed credentials", () => {
    expect(() =>
      makeOpenAiTextModerationProvider({
        apiKey: "test-key",
        model: "omni-moderation-latest" as typeof OPENAI_MODERATION_MODEL,
      }),
    ).toThrow("Invalid OpenAI moderation configuration");
    expect(() =>
      makeOpenAiTextModerationProvider({
        apiKey: "test-key",
        baseUrl: "https://moderation-proxy.invalid/v1",
      }),
    ).toThrow("Invalid OpenAI moderation configuration");
    expect(() => makeOpenAiTextModerationProvider({ apiKey: " padded " })).toThrow(
      "Invalid OpenAI moderation configuration",
    );
  });
});
