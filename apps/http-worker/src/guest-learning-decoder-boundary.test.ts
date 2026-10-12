// Local decoder fixture only; never createHttpWorker or enable a definition.
// Hono supplies genuine matched path context to the exported maintained decoder.
import { expect, test } from "bun:test";
import { SubmitGuestStudyAnswerV1, toErrorBody } from "@pirate/contracts";
import { type Context, Hono } from "hono";
import { decodeInput } from "./transport.ts";

type DecoderEnv = Parameters<typeof decodeInput>[1] extends Context<infer E> ? E : never;

test("maintained frozen117 answer decoder applies genuine audio524288/JSON4096/duration60000 bounds", async () => {
  const app = new Hono<DecoderEnv>();
  let decoded = 0;
  app.post(SubmitGuestStudyAnswerV1.path, async (context) => {
    try {
      const input = await decodeInput(SubmitGuestStudyAnswerV1, context, null);
      decoded++;
      // No guest service, proof, provider, DB or route registry is composed.
      return context.json({
        raw: input.body instanceof Uint8Array,
        bytes: input.body instanceof Uint8Array ? input.body.byteLength : 0,
      });
    } catch (error) {
      const serialized = toErrorBody(error);
      return new Response(JSON.stringify(serialized.body), {
        status: serialized.status,
        headers: { "content-type": "application/json" },
      });
    }
  });
  const request = (type: string, body: Uint8Array | string, duration?: string) =>
    app.fetch(
      new Request(
        "https://community.example/communities/community-original/study/guest/v1/sessions/session-original/items/item-0/answers",
        {
          method: "POST",
          headers: {
            "content-type": type,
            "idempotency-key": "original-key",
            "x-study-attempt-number": "1",
            ...(duration === undefined ? {} : { "x-audio-duration-ms": duration }),
          },
          body,
        },
      ),
    );
  const exact = await request("audio/webm", new Uint8Array(524288), "60000");
  expect(exact.status).toBe(200);
  expect(await exact.json()).toEqual({ raw: true, bytes: 524288 });
  expect(decoded).toBe(1);
  expect((await request("audio/webm", new Uint8Array(524289), "60000")).status).toBe(400);
  expect(decoded).toBe(1);
  expect((await request("audio/webm", new Uint8Array([1]), "60001")).status).toBe(400);
  expect(decoded).toBe(1);
  expect(
    (await request("application/json", JSON.stringify({ kind: "single_select", choice_key: "a" })))
      .status,
  ).toBe(200);
  expect(decoded).toBe(2);
  expect(
    (
      await request(
        "application/json",
        " ".repeat(4096) + JSON.stringify({ kind: "single_select", choice_key: "a" }),
      )
    ).status,
  ).toBe(400);
  expect(decoded).toBe(2);
  expect(SubmitGuestStudyAnswerV1.implementation).toBe("disabled");
});
