import { Context, Effect, Schema } from "effect";
import { Ceremony } from "./model.ts";
import {
  AdmissionError,
  HnsObserver,
  CreateInput,
  ConsentInput,
  RevisionInput,
  create,
  current,
  consent,
  cancel,
  observe,
  envelope,
  instructions,
} from "./service.ts";
import type { Binding } from "./protocol.ts";
import { strictJson } from "./strict-json.ts";
import { unavailableCodes } from "./outcomes.ts";
export class HttpAccess extends Context.Service<
  HttpAccess,
  {
    authorize: (
      request: Request,
      binding: Binding,
      body: string,
    ) => Effect.Effect<void, AdmissionError>;
  }
>()("@pirate/hns-admission/HttpAccess") {}
const json = Effect.fn("Admission.json")(function* (request: Request) {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > 16384)
    return yield* new AdmissionError({ reason: "body_too_large" });
  // Bound streaming input as well as Content-Length; cancel the reader on overflow.
  const reader = request.body?.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "",
    size = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: () => new AdmissionError({ reason: "invalid_request" }),
        });
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 16384) {
          yield* Effect.tryPromise({
            try: () => reader.cancel(),
            catch: () => new AdmissionError({ reason: "invalid_request" }),
          });
          return yield* new AdmissionError({ reason: "body_too_large" });
        }
        text += yield* Effect.try({
          try: () => decoder.decode(chunk.value, { stream: true }),
          catch: () => new AdmissionError({ reason: "invalid_request" }),
        });
      }
    } finally {
      reader.releaseLock();
    }
  }
  return (
    text +
    (yield* Effect.try({
      try: () => decoder.decode(),
      catch: () => new AdmissionError({ reason: "invalid_request" }),
    }))
  );
});
const parse = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  body: string,
): Effect.Effect<A, AdmissionError> =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(schema)(strictJson(body), {
        onExcessProperty: "error",
      }),
    catch: () => new AdmissionError({ reason: "invalid_request" }),
  });
export const handle = Effect.fn("Admission.http")(
  function* (request: Request) {
    const url = new URL(request.url),
      access = yield* HttpAccess;
    const match =
      /^\/v1\/(ceremonies|operations)\/(0x[0-9a-f]{64})(?:\/(consent|cancel|observe))?$/.exec(
        url.pathname,
      );
    if (request.method === "POST" && url.pathname === "/v1/ceremonies") {
      const body = yield* json(request),
        input = yield* parse(CreateInput, body);
      yield* access.authorize(request, input.binding, body);
      const state = yield* create(input);
      return Response.json(
        {
          ...envelope(state),
          consent: {
            nonce: state.nonce,
            resourceDigest: state.resourceDigest,
            createdAt: state.createdAt,
          },
        },
        { status: 202 },
      );
    }
    if (!match)
      return Response.json({ error: "endpoint_not_enabled" }, { status: 404 });
    const [, kind, id, action] = match;
    const model = yield* Ceremony,
      stored = yield* model.get(id);
    if (!stored)
      return Response.json({ error: "operation_unknown" }, { status: 404 });
    const body = request.method === "POST" ? yield* json(request) : "";
    yield* access.authorize(request, stored.binding, body);
    let result;
    if (request.method === "GET" && !action) result = yield* current(id);
    else if (
      request.method === "POST" &&
      kind === "ceremonies" &&
      action === "consent"
    )
      result = yield* consent(id, yield* parse(ConsentInput, body));
    else if (
      request.method === "POST" &&
      kind === "ceremonies" &&
      action === "cancel"
    )
      result = yield* cancel(
        id,
        (yield* parse(RevisionInput, body)).expectedRevision,
      );
    else if (
      request.method === "POST" &&
      kind === "ceremonies" &&
      action === "observe"
    ) {
      yield* parse(Schema.Struct({}), body);
      result = yield* observe(id);
    } else
      return Response.json({ error: "endpoint_not_enabled" }, { status: 404 });
    const publication = yield* instructions(result);
    return Response.json({
      ...envelope(result),
      ...(publication ? { publication } : {}),
    });
  },
  Effect.catch((e) =>
    Effect.succeed(
      Response.json(
        {
          schema: "pirate.namespace-admission/1",
          status: unavailableCodes.includes(e.reason)
            ? "unavailable"
            : "denied",
          reason: e.reason,
        },
        {
          status: unavailableCodes.includes(e.reason)
            ? 503
            : e.reason === "invalid_signature"
              ? 403
              : e.reason === "revision_conflict" ||
                  e.reason === "request_conflict"
                ? 409
                : 400,
        },
      ),
    ),
  ),
);
