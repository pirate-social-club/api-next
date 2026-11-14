import { Context, Effect, Schema } from "effect";
import { Ceremony } from "./aggregate.ts";
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
import {
  unavailableCodes,
  actionCodes,
  type Code,
  type ConflictDetail,
} from "./outcomes.ts";
import type { State } from "./ceremony.ts";
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
const errorResponse = (
  error: { reason: Code; detail?: ConflictDetail },
  retained?: State,
) =>
  Response.json(
    {
      ...(retained
        ? envelope(retained)
        : { schema: "pirate.namespace-admission/1" }),
      status: unavailableCodes.includes(error.reason)
        ? "unavailable"
        : actionCodes.includes(error.reason)
          ? "action_required"
          : "denied",
      reason: error.reason,
      ...(error.detail ? { detail: error.detail } : {}),
      ...(actionCodes.includes(error.reason)
        ? { responsibleRole: "operator" }
        : {}),
    },
    {
      status: unavailableCodes.includes(error.reason)
        ? 503
        : [
              "invalid_signature",
              "not_allowlisted",
              "authorization_expired",
              "publication_not_enabled",
            ].includes(error.reason)
          ? 403
          : ["revision_conflict", "request_conflict"].includes(error.reason)
            ? 409
            : 400,
    },
  );
export const handle = Effect.fn("Admission.http")(
  function* (request: Request) {
    const url = new URL(request.url),
      access = yield* HttpAccess;
    if (request.method === "GET" && url.pathname === "/v1/capabilities")
      return Response.json({
        schema: "pirate.namespace-admission-capabilities/1",
        enabled: ["ceremony", "consent", "status", "observe", "cancel"],
        disabled: [
          "admission",
          "refresh",
          "installation_proof",
          "submission",
          "reconciliation",
          "sender_recovery",
        ],
      });
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
    const planned = yield* instructions(result).pipe(Effect.result);
    // An instruction-read failure must not discard the durable operation envelope,
    // including when a consent transition already committed successfully.
    if (planned._tag === "Failure")
      return errorResponse(planned.failure, result);
    const publication = planned.success;
    return Response.json({
      ...envelope(result),
      ...(publication ? { publication } : {}),
    });
  },
  Effect.catch((e) => Effect.succeed(errorResponse(e))),
);
