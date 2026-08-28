/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { setupNetwork } from "@msw/cloudflare";
import { MODERATION_POLICY_CATEGORIES_V1 } from "@pirate/contracts";
import { Effect } from "effect";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  makeOpenAiTextModerationProvider,
  OPENAI_MODERATION_MODEL,
} from "../../packages/platform-cf/src/openai-text-moderation.ts";

const categoryRecord = <A>(value: A): Record<string, A> =>
  Object.fromEntries(MODERATION_POLICY_CATEGORIES_V1.map((category) => [category, value]));

const network = setupNetwork();

describe("OpenAI moderation in the Workers runtime", () => {
  beforeAll(() => network.enable());

  afterEach(() => {
    network.resetHandlers();
  });

  afterAll(() => network.disable());

  it("constructs and sends the request through the genuine Workers fetch path", async () => {
    let intercepted = false;
    network.use(
      http.post("https://api.openai.com/v1/moderations", async ({ request }) => {
        intercepted = true;
        expect(request.redirect).toBe("manual");
        expect(request.headers.get("authorization")).toBe("Bearer workerd-test-key");
        expect(await request.json()).toEqual({
          model: OPENAI_MODERATION_MODEL,
          input: ["Benign runtime compatibility sentinel"],
        });
        return HttpResponse.json({
          id: "modr_workerd_runtime",
          model: OPENAI_MODERATION_MODEL,
          results: [
            {
              flagged: false,
              categories: categoryRecord(false),
              category_scores: categoryRecord(0.01),
              category_applied_input_types: categoryRecord(["text"]),
            },
          ],
        });
      }),
    );

    const provider = makeOpenAiTextModerationProvider({ apiKey: "workerd-test-key" });
    const evaluation = await Effect.runPromise(
      provider.evaluate({
        version: "text-moderation-input-v1",
        surface: "comment",
        title: null,
        body: "Benign runtime compatibility sentinel",
      }),
    );

    expect(intercepted).toBe(true);
    expect(evaluation.returned_model).toBe(OPENAI_MODERATION_MODEL);
    expect(evaluation.matched_categories).toEqual([]);
    expect(evaluation.inputs).toHaveLength(1);
  });
});
