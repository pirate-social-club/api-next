import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { generateClient, generateOpenApi, generateRouteTable, schemaToOpenApi } from "./codegen.ts";
import { endpoint } from "./endpoint.ts";
import {
  BadRequest,
  Conflict,
  IdempotencyConflict,
  OwnerRecoveryInProgress,
  RateLimited,
} from "./errors.ts";
import { Cents } from "./money.ts";
import { diffBreaking, type OpenApiDocument } from "./openapi-diff.ts";
import { PublicPostRouteResultV1, PublicPostRouteV1 } from "./public-post-routes.ts";
import { registry } from "./registry.ts";
import { LocalizedPost, VideoPostProjectionV1, VideoSoundtrackProjectionV1 } from "./v1.ts";

const fixture = endpoint({
  method: "POST",
  path: "/echo/:message",
  auth: Auth.user(),
  request: { body: Schema.Struct({ uppercase: Schema.optional(Schema.Boolean) }) },
  response: Schema.Struct({ message: Schema.String }),
  errors: [RateLimited],
});
const fixtureDoc = () => generateOpenApi([fixture]);

type TestSchema = Record<string, unknown>;
const responseDocument = (schema: TestSchema): OpenApiDocument => ({
  openapi: "3.1.0",
  info: { title: "reference ownership", version: "1" },
  paths: {
    "/reference": {
      get: {
        operationId: "get_reference",
        responses: {
          "200": { content: { "application/json": { schema } } },
        },
      },
    },
  },
});
const responseEndpoint = (response: Schema.Top, path = "/reference") =>
  endpoint({
    method: "GET",
    path,
    auth: Auth.public(),
    response,
  });

describe("published schema reference ownership", () => {
  test("shared definition names remain independent across operations and request locations", () => {
    const string = Schema.Struct({ value: Schema.String }).annotate({ identifier: "Shared" });
    const number = Schema.Struct({ value: Schema.Number }).annotate({ identifier: "Shared" });
    const source = (second: Schema.Top) => [
      responseEndpoint(Schema.Struct({ a: string, b: string }), "/first"),
      endpoint({
        method: "POST",
        path: "/second",
        auth: Auth.public(),
        request: {
          query: Schema.Struct({ a: string, b: string }),
          body: Schema.Struct({ a: number, b: number }),
        },
        response: Schema.Struct({ a: second, b: second }),
      }),
    ];
    const before = generateOpenApi(source(number));
    expect(Object.keys(before.components?.schemas ?? {})).toHaveLength(4);
    expect(diffBreaking(before, structuredClone(before))).toEqual([]);
    const after = generateOpenApi(source(string));
    expect(diffBreaking(before, after)).toEqual([
      "response POST /second: enum constraint removed at a.value",
      "response POST /second: enum constraint removed at b.value",
    ]);
    const standalone = schemaToOpenApi(Schema.Struct({ a: string, b: string }));
    expect(standalone.$defs).toHaveProperty("Shared");
    expect(JSON.stringify(standalone)).toContain("#/$defs/Shared");
    expect(JSON.stringify(before)).not.toContain('"$ref":"#/$defs/');
  });

  test("JSON Pointer escaping survives publication and standalone client decoding", async () => {
    const shared = Schema.Struct({ value: Schema.String }).annotate({ identifier: "a/~b % #" });
    const spec = responseEndpoint(Schema.Struct({ first: shared, second: shared }), "/escaped");
    const document = generateOpenApi([spec]);
    expect(diffBreaking(document, structuredClone(document))).toEqual([]);
    const text = generateClient({ Escaped: spec });
    expect(text).toContain("readonly first: { readonly value: string }");
    const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(text);
    const generated = await import(`data:text/javascript;base64,${btoa(javascript)}`);
    let payload: unknown = { first: { value: "one" }, second: { value: "two" } };
    const client = generated.createPirateApiClient("https://fixture.invalid", {
      fetchImpl: async () => Response.json(payload),
    });
    expect(await client.get_escaped()).toEqual(payload);
    payload = { first: { value: 1 }, second: { value: "two" } };
    await expect(client.get_escaped()).rejects.toMatchObject({
      _tag: "ApiClientResponseValidationError",
      operation: "get_escaped",
      path: "expected string",
    });
  });

  test("retained inline definitions require explicit historical ownership and stay byte-exact", () => {
    const shared = Schema.Struct({ value: Schema.String }).annotate({ identifier: "Shared" });
    const schema = Schema.Struct({ first: shared, second: shared });
    const retained = responseDocument(schemaToOpenApi(schema));
    const bytes = JSON.stringify(retained);
    const published = generateOpenApi([responseEndpoint(schema)]);
    expect(() => diffBreaking(retained, published)).toThrow("Unresolved OpenAPI schema reference");
    expect(
      diffBreaking(retained, published, { oldSchemaReferences: "embedded-definitions" }),
    ).toEqual([]);
    expect(JSON.stringify(retained)).toBe(bytes);
    expect(() =>
      diffBreaking(published, retained, { oldSchemaReferences: "embedded-definitions" }),
    ).toThrow("Unresolved OpenAPI schema reference");
  });

  test("schema keywords used as property names are not mistaken for references or annotations", () => {
    const shared = Schema.Struct({
      $ref: Schema.String,
      const: Schema.Struct({ value: Schema.String }),
    }).annotate({ identifier: "Keywords" });
    const document = generateOpenApi([responseEndpoint(Schema.Struct({ a: shared, b: shared }))]);
    expect(diffBreaking(document, structuredClone(document))).toEqual([]);
    const changed = Schema.Struct({
      $ref: Schema.String,
      const: Schema.Struct({ value: Schema.NullOr(Schema.String) }),
    }).annotate({ identifier: "Keywords" });
    const candidate = generateOpenApi([
      responseEndpoint(Schema.Struct({ a: changed, b: changed })),
    ]);
    expect(diffBreaking(document, candidate)).toEqual([
      "response GET /reference: type changed from string to null at a.const.value",
      "response GET /reference: type changed from string to null at b.const.value",
    ]);
  });

  test("nested definitions and productive recursive references terminate and still detect changes", () => {
    const schema: TestSchema = {
      $ref: "#/components/schemas/Tree/$defs/Node",
    };
    const make = (type: string): OpenApiDocument => ({
      ...responseDocument(schema),
      components: {
        schemas: {
          Tree: {
            $defs: {
              Node: {
                type: "object",
                properties: {
                  children: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Tree/$defs/Node" },
                  },
                  value: { $ref: "#/components/schemas/Tree/$defs/Nested/$defs/Value" },
                },
                required: ["children", "value"],
                additionalProperties: false,
              },
              Nested: { $defs: { Value: { type } } },
            },
          },
        },
      },
    });
    expect(diffBreaking(make("string"), make("string"))).toEqual([]);
    expect(diffBreaking(make("string"), make("number"))).toEqual([
      "response GET /reference: type changed from string to number at value",
    ]);
    interface Tree {
      readonly value: string;
      readonly children: ReadonlyArray<Tree>;
    }
    const tree: Schema.Codec<Tree> = Schema.Struct({
      value: Schema.String,
      children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => tree)),
    });
    const emitted = generateOpenApi([responseEndpoint(tree)]);
    expect(diffBreaking(emitted, structuredClone(emitted))).toEqual([]);
  });

  test("unresolved, external, non-schema, invalid pointer and unproductive cycle references fail closed", () => {
    const valid = responseDocument({ type: "string" });
    for (const reference of [
      "#/$defs/missing",
      "https://fixture.invalid/schema",
      "#/info",
      "#/bad~2pointer",
      "#/bad%ZZ",
    ]) {
      const invalid = responseDocument({ $ref: reference });
      expect(() => diffBreaking(valid, invalid)).toThrow(/OpenAPI/);
    }
    const cycle = {
      ...responseDocument({ $ref: "#/components/schemas/A" }),
      components: {
        schemas: { A: { $ref: "#/components/schemas/B" }, B: { $ref: "#/components/schemas/A" } },
      },
    };
    expect(() => diffBreaking(valid, cycle)).toThrow("Unproductive OpenAPI reference cycle");
    const extra = structuredClone(valid);
    extra.paths["/new"] = {
      get: {
        responses: {
          "200": { content: { "application/json": { schema: { $ref: "#/$defs/missing" } } } },
        },
      },
    };
    expect(() => diffBreaking(valid, extra)).toThrow("Unresolved OpenAPI schema reference");
    expect(() => diffBreaking(valid, responseDocument({ $dynamicRef: "#node" }))).toThrow(
      "Unsupported OpenAPI reference keyword",
    );
    const siblings = { ...valid, components: { schemas: { Text: { type: "string" } } } };
    expect(() =>
      diffBreaking(valid, {
        ...siblings,
        paths: responseDocument({ $ref: "#/components/schemas/Text", minLength: 1 }).paths,
      }),
    ).toThrow("Unsupported OpenAPI $ref sibling");
  });

  test("retained public route shape reports both author fields and preserves age/video alternatives", () => {
    const [original, song] = VideoSoundtrackProjectionV1.members;
    const oldSoundtrack = Schema.Union([
      Schema.Struct({ ...original.fields, origin_author_persona_id: Schema.String }),
      Schema.Struct({
        ...song.fields,
        song_reference: Schema.Struct({
          ...song.fields.song_reference.fields,
          song_author_persona_id: Schema.String,
        }),
      }),
    ]);
    const oldVideo = Schema.Struct({ ...VideoPostProjectionV1.fields, soundtrack: oldSoundtrack });
    const oldPost = Schema.Struct({
      ...LocalizedPost.fields,
      video: Schema.optional(Schema.NullOr(oldVideo)),
    });
    const oldContent = Schema.Struct({
      kind: Schema.Literal("content"),
      post_id: Schema.String,
      content: oldPost,
      route: Schema.NullOr(PublicPostRouteV1),
    });
    const age = PublicPostRouteResultV1.members[2];
    const retained = responseDocument(schemaToOpenApi(Schema.Union([oldContent, age])));
    const current = generateOpenApi([responseEndpoint(PublicPostRouteResultV1)]);
    const context = { oldSchemaReferences: "embedded-definitions" } as const;
    expect(diffBreaking(retained, current, context)).toEqual([
      "response GET /reference: type changed from string to null at content.video.soundtrack.origin_author_persona_id",
      "response GET /reference: type changed from string to null at content.video.soundtrack.song_reference.song_author_persona_id",
    ]);
    const video = PublicPostRouteResultV1.members[1];
    const strictVideo = Schema.Struct({
      ...video.fields,
      content: Schema.Struct({
        ...video.fields.content.fields,
        video: oldVideo,
      }),
    });
    const specialization = generateOpenApi([
      responseEndpoint(Schema.Union([oldContent, strictVideo, age])),
    ]);
    expect(diffBreaking(retained, specialization, context)).toEqual([]);
    const changedAge = Schema.Struct({
      ...age.fields,
      locked: Schema.Struct({
        ...age.fields.locked.fields,
        content_rating: Schema.String,
      }),
    });
    const ageChanged = generateOpenApi([
      responseEndpoint(Schema.Union([oldContent, strictVideo, changedAge])),
    ]);
    expect(diffBreaking(specialization, ageChanged)).toEqual([
      "response GET /reference: enum constraint removed at locked.content_rating",
    ]);
    const removedAge = generateOpenApi([responseEndpoint(Schema.Union([oldContent, strictVideo]))]);
    expect(diffBreaking(current, removedAge)).toEqual([]);
    // Removing an existing output alternative is allowed; adding it back must
    // detect the locked payload, rather than claiming content was newly added.
    expect(diffBreaking(specialization, removedAge)).toEqual([]);
    expect(diffBreaking(removedAge, specialization).length).toBeGreaterThan(0);
  });

  test("request and response union directions remain opposite with referenced alternatives", () => {
    const a = Schema.Struct({ kind: Schema.Literal("a"), value: Schema.String }).annotate({
      identifier: "A",
    });
    const b = Schema.Struct({ kind: Schema.Literal("b"), value: Schema.Number }).annotate({
      identifier: "B",
    });
    const source = (both: boolean) =>
      endpoint({
        method: "POST",
        path: "/union",
        auth: Auth.public(),
        request: { body: Schema.Struct({ first: both ? Schema.Union([a, b]) : a, second: a }) },
        response: Schema.Struct({ first: both ? Schema.Union([a, b]) : a, second: a }),
      });
    const narrow = generateOpenApi([source(false)]);
    const wide = generateOpenApi([source(true)]);
    expect(
      diffBreaking(narrow, wide).every((message) => message.startsWith("response POST /union:")),
    ).toBe(true);
    expect(diffBreaking(narrow, wide).length).toBeGreaterThan(0);
    expect(
      diffBreaking(wide, narrow).every((message) => message.startsWith("request POST /union:")),
    ).toBe(true);
    expect(diffBreaking(wide, narrow).length).toBeGreaterThan(0);
  });
});

describe("codegen pipeline", () => {
  test("registry round-trips: every endpoint appears in OpenAPI, route table, client", () => {
    const doc = generateOpenApi(registry);
    const table = generateRouteTable(registry);
    const client = generateClient(registry);
    for (const endpoint of Object.values(registry)) {
      const path = endpoint.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      expect(doc.paths[path]).toHaveProperty(endpoint.method.toLowerCase());
      expect(table.some((b) => b.method === endpoint.method && b.path === endpoint.path)).toBe(
        true,
      );
      expect(client).not.toContain(`from "@pirate/contracts"`);
      expect(client).not.toContain(`from "effect"`);
    }
  });

  test("branded money types surface as integers, never JSON floats", () => {
    const json = schemaToOpenApi(Cents);
    expect(json.type).toBe("integer");
  });

  test("error unions become per-status responses carrying wire codes", () => {
    const doc = generateOpenApi([
      endpoint({
        method: "POST",
        path: "/x",
        auth: Auth.user(),
        request: { body: Schema.Struct({ a: Schema.String }) },
        response: Schema.Struct({ b: Schema.String }),
        errors: [BadRequest, RateLimited],
      }),
    ]);
    const responses = doc.paths["/x"]?.post?.responses as Record<
      string,
      { "x-error-codes"?: string[] }
    >;
    expect(responses["400"]?.["x-error-codes"]).toEqual(["bad_request"]);
    expect(responses["429"]?.["x-error-codes"]).toEqual(["rate_limited"]);
  });

  test("declares idempotency conflict details and preserves primitive refinements", () => {
    const textPost = endpoint({
      method: "POST",
      path: "/text-post",
      auth: Auth.user(),
      response: Schema.Struct({ id: Schema.NonEmptyString }),
      errors: [IdempotencyConflict],
    });
    const response = generateOpenApi([textPost]).paths["/text-post"]?.post?.responses as Record<
      string,
      Record<string, unknown>
    >;
    const response409 = response["409"] as Record<string, unknown>;
    const responseContent = response409.content as Record<string, Record<string, unknown>>;
    const responseSchema = responseContent["application/json"]?.schema as Record<string, unknown>;
    const responseProperties = responseSchema.properties as Record<string, Record<string, unknown>>;
    const errorSchema = responseProperties.error as Record<string, unknown>;
    const details = (errorSchema.properties as Record<string, unknown>).details as Record<
      string,
      unknown
    >;
    expect(details).toMatchObject({
      type: "object",
      required: ["reason_code", "submission_id"],
      additionalProperties: false,
    });
    expect(errorSchema.required as readonly string[]).toContain("details");
    const client = generateClient({ TextPost: textPost });
    expect(client).toContain('"detailsSchema"');
    expect(client).toContain("readonly id: string");
  });

  test("generates a code-specific bounded Retry-After contract", () => {
    const recovery = endpoint({
      method: "POST",
      path: "/recovery",
      auth: Auth.user({ browserSessionOnly: true }),
      response: Schema.Struct({ ok: Schema.Boolean }),
      errors: [Conflict, OwnerRecoveryInProgress],
    });
    const response = generateOpenApi([recovery]).paths["/recovery"]?.post?.responses as Record<
      string,
      Record<string, unknown>
    >;
    expect(response["409"]?.headers).toEqual({
      "Retry-After": {
        required: false,
        schema: {
          type: "string",
          pattern: "^(?:[1-9]|[1-9][0-9]|[1-9][0-9]{2}|[12][0-9]{3}|3[0-5][0-9]{2}|3600)$",
        },
        "x-required-for-error-codes": ["owner_recovery_in_progress"],
        "x-minimum-seconds": 1,
        "x-maximum-seconds": 3_600,
      },
    });
    const client = generateClient({ Recovery: recovery });
    expect(client).toContain('"code":"owner_recovery_in_progress"');
    expect(client).toContain(
      '"retryAfterHeader":{"minimumSeconds":1,"maximumSeconds":3600,"pattern":"^(?:[1-9]|[1-9][0-9]|[1-9][0-9]{2}|[12][0-9]{3}|3[0-5][0-9]{2}|3600)$","detailsKey":"retry_after_seconds"}',
    );
    expect(client).toContain("API error response Retry-After header disagreed with its details");
  });

  test("generated client is type-checkable source with typed methods", () => {
    const client = generateClient(registry);
    expect(client).toContain("export type GetHealthInput");
    expect(client).toContain("export type GetHealthResponse");
    expect(client).toContain("export type HealthResponse = GetHealthResponse");
    expect(client).toContain("export type GetPostsPostIdError");
    expect(client).not.toContain("ClientInput");
    expect(client).not.toContain("ClientOutput");
    expect(client).not.toContain("@pirate/contracts");
    expect(client).not.toContain('"effect"');
    expect(client).toContain("ApiClientResponseValidationError");
    expect(client).toContain("AbortSignal");
    expect(client).toContain("ERROR_DEFINITIONS");
    expect(client).not.toContain("throw await response.json()");
    expect(client).not.toContain("import {\n");
    expect(client).not.toContain("Promise<unknown>");
  });

  test("headers and raw-text bodies are represented in OpenAPI and the generated client", () => {
    const callback = endpoint({
      method: "POST",
      path: "/callbacks/raw",
      auth: Auth.public(),
      request: {
        headers: Schema.Struct({
          "x-signature": Schema.String,
          "x-optional": Schema.optional(Schema.String),
        }),
        body: Schema.String,
        bodyEncoding: "raw-text",
      },
      response: Schema.Struct({ accepted: Schema.Boolean }),
    });

    const operation = generateOpenApi([callback]).paths["/callbacks/raw"]?.post as {
      parameters: Array<{
        name: string;
        in: string;
        required: boolean;
        schema: Record<string, unknown>;
      }>;
      requestBody: {
        content: Record<string, { schema: Record<string, unknown> }>;
      };
    };
    expect(operation.parameters).toEqual([
      { name: "x-signature", in: "header", required: true, schema: { type: "string" } },
      {
        name: "x-optional",
        in: "header",
        required: false,
        schema: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    ]);
    expect(operation.requestBody.content["text/plain"]?.schema).toEqual({ type: "string" });

    const client = generateClient({ RawCallback: callback });
    expect(client).toContain(
      'readonly headers: { readonly "x-signature": string; readonly "x-optional"?: string | null }',
    );
    expect(client).toContain('bodyEncoding === "raw-text"');
    expect(client).toContain("headers.set(key, String(value))");
    expect(client).toContain(
      'body: rawBody || bodyEncoding === "raw-bytes" ? requestInput.body as Exclude<RequestInit["body"], undefined> : bodyEncoding === "raw-text" ? requestInput.body as string',
    );
    expect(client).toContain(
      'request("post_callbacksRaw", "POST", "/callbacks/raw", input, options, "raw-text", [], [])',
    );
  });

  test("JSON remains the default request body encoding", () => {
    const client = generateClient({ Json: fixture });
    expect(client).toContain(
      'bodyEncoding !== "raw-bytes") headers.set("content-type", bodyEncoding === "raw-text" ? "text/plain" : "application/json")',
    );
    expect(client).toContain(
      'body: rawBody || bodyEncoding === "raw-bytes" ? requestInput.body as Exclude<RequestInit["body"], undefined> : bodyEncoding === "raw-text" ? requestInput.body as string : bodyEncoding === "exact-json" ? serializeExactJsonBody(requestInput.body, exactJsonMembers) : JSON.stringify(requestInput.body)',
    );
    expect(client).toContain(
      'request("post_echoMessage", "POST", "/echo/:message", input, options, "json", [], []),',
    );
    expect(generateOpenApi([fixture]).paths["/echo/{message}"]?.post).toMatchObject({
      requestBody: { content: { "application/json": { schema: { type: "object" } } } },
    });
  });

  test("represents content-negotiated JSON and raw bodies on one operation", () => {
    const mixed = endpoint({
      method: "POST",
      path: "/mixed",
      auth: Auth.public(),
      request: {
        body: Schema.Struct({ choice_key: Schema.String }),
        rawBodyContentTypes: ["audio/webm"],
        rawBodyMaxBytes: 4,
      },
      response: Schema.Struct({ ok: Schema.Boolean }),
    });
    const operation = generateOpenApi([mixed]).paths["/mixed"]?.post as {
      requestBody: { content: Record<string, { schema: Record<string, unknown> }> };
    };
    expect(operation.requestBody.content["application/json"]?.schema).toMatchObject({
      type: "object",
    });
    expect(operation.requestBody.content["audio/webm"]?.schema).toEqual({
      type: "string",
      format: "binary",
    });
    const client = generateClient({ Mixed: mixed });
    expect(client).toContain("| ArrayBuffer | ArrayBufferView | Blob");
    expect(client).toContain('["audio/webm"]');
  });

  test("canonicalizes and fail-closes generated exact JSON bodies", () => {
    const exact = endpoint({
      method: "POST",
      path: "/exact",
      auth: Auth.user(),
      request: {
        body: Schema.Struct({ first: Schema.String, second: Schema.Int }),
        bodyEncoding: "exact-json",
      },
      response: Schema.Struct({ ok: Schema.Boolean }),
    });
    const client = generateClient({ Exact: exact });
    expect(client).toContain(
      'request("post_exact", "POST", "/exact", input, options, "exact-json", ["first","second"], [])',
    );
    expect(client).toContain("serializeExactJsonBody(requestInput.body, exactJsonMembers)");

    const transformed = endpoint({
      method: "POST",
      path: "/transformed",
      auth: Auth.user(),
      request: { body: Schema.NumberFromString, bodyEncoding: "exact-json" },
      response: Schema.Struct({ ok: Schema.Boolean }),
    });
    const integerLike = endpoint({
      method: "POST",
      path: "/integer-like",
      auth: Auth.user(),
      request: { body: Schema.Int, bodyEncoding: "exact-json" },
      response: Schema.Struct({ ok: Schema.Boolean }),
    });
    const integerIndexMember = endpoint({
      method: "POST",
      path: "/integer-index",
      auth: Auth.user(),
      request: {
        body: Schema.Struct({ "0": Schema.String, value: Schema.String }),
        bodyEncoding: "exact-json",
      },
      response: Schema.Struct({ ok: Schema.Boolean }),
    });
    expect(() => generateClient({ Transformed: transformed })).toThrow();
    expect(() => generateClient({ IntegerLike: integerLike })).toThrow();
    expect(() => generateClient({ IntegerIndex: integerIndexMember })).toThrow();
  });

  test("rejects a success/error status collision during OpenAPI generation", () => {
    expect(() =>
      generateOpenApi([
        endpoint({
          method: "POST",
          path: "/collision",
          auth: Auth.user(),
          response: Schema.Struct({ ok: Schema.Boolean }),
          successStatus: 400,
          errors: [BadRequest],
        }),
      ]),
    ).toThrow(/both success and error/);
  });
});

describe("openapi breaking-change diff", () => {
  const doc = (overrides?: (d: OpenApiDocument) => void): OpenApiDocument => {
    const base = fixtureDoc();
    if (overrides) overrides(base);
    return JSON.parse(JSON.stringify(base)) as OpenApiDocument;
  };

  test("identical documents pass", () => {
    expect(diffBreaking(doc(), doc())).toEqual([]);
  });

  test("additive change (new endpoint) passes", () => {
    const added = doc((d) => {
      d.paths["/new"] = { get: { operationId: "get_new", responses: {} } };
    });
    expect(diffBreaking(doc(), added)).toEqual([]);
  });

  test("new required or optional properties in a closed response break old generated clients", () => {
    const make = (response: Schema.Top) =>
      generateOpenApi([
        endpoint({ method: "GET", path: "/closed", auth: Auth.public(), response }),
      ]);
    const old = make(Schema.Struct({ existing: Schema.String }));
    for (const added of [Schema.Boolean, Schema.optional(Schema.Boolean)]) {
      const candidate = make(Schema.Struct({ existing: Schema.String, added }));
      expect(diffBreaking(old, candidate)).toEqual([
        "response GET /closed: property added to closed response: added",
      ]);
    }
  });

  test("closed response additions are detected through nested published references", () => {
    const make = (response: Schema.Top) =>
      generateOpenApi([
        endpoint({ method: "GET", path: "/nested", auth: Auth.public(), response }),
      ]);
    const old = make(
      Schema.Struct({
        result: Schema.Struct({ existing: Schema.String }).annotate({ identifier: "NestedResult" }),
      }),
    );
    const candidate = make(
      Schema.Struct({
        result: Schema.Struct({ existing: Schema.String, added: Schema.Boolean }).annotate({
          identifier: "NestedResult",
        }),
      }),
    );
    expect(diffBreaking(old, candidate)).toEqual([
      "response GET /nested: property added to closed response: result.added",
    ]);
  });

  test("inherited object names do not hide a new closed-response property", () => {
    const old = generateOpenApi([responseEndpoint(Schema.Struct({ existing: Schema.String }))]);
    for (const name of ["constructor", "toString", "__proto__"]) {
      const candidate = generateOpenApi([
        responseEndpoint(Schema.Struct({ existing: Schema.String, [name]: Schema.Boolean })),
      ]);
      expect(diffBreaking(old, candidate)).toEqual([
        `response GET /reference: property added to closed response: ${name}`,
      ]);
    }
  });

  test("open response additions and optional request additions remain compatible", () => {
    const old = doc();
    const candidate = doc();
    for (const document of [old, candidate]) {
      const operation = document.paths["/echo/{message}"]?.post as {
        responses: Record<
          "200",
          {
            content: {
              "application/json": {
                schema: { additionalProperties?: boolean; properties: Record<string, unknown> };
              };
            };
          }
        >;
      };
      operation.responses["200"].content["application/json"].schema.additionalProperties = true;
    }
    const operation = candidate.paths["/echo/{message}"]?.post as {
      responses: Record<
        "200",
        { content: { "application/json": { schema: { properties: Record<string, unknown> } } } }
      >;
      requestBody: {
        content: { "application/json": { schema: { properties: Record<string, unknown> } } };
      };
    };
    operation.responses["200"].content["application/json"].schema.properties.added = {
      type: "boolean",
    };
    operation.requestBody.content["application/json"].schema.properties.added = { type: "boolean" };
    expect(diffBreaking(old, candidate)).toEqual([]);
  });

  test("removed operation breaks", () => {
    const removed = doc((d) => {
      delete d.paths["/echo/{message}"];
    });
    expect(diffBreaking(doc(), removed)).toContain("operation removed: POST /echo/{message}");
  });

  test("removed response status breaks", () => {
    const removed = doc((d) => {
      const post = d.paths["/echo/{message}"]?.post as Record<string, unknown>;
      delete (post.responses as Record<string, unknown>).rate_limited_placeholder;
      delete (post.responses as Record<string, unknown>)["429"];
    });
    expect(diffBreaking(doc(), removed)).toContain(
      "response status removed on POST /echo/{message}: 429",
    );
  });

  test("newly required request property breaks", () => {
    const changed = doc((d) => {
      const post = d.paths["/echo/{message}"]?.post as unknown as {
        requestBody: { content: { "application/json": { schema: { required?: string[] } } } };
      };
      post.requestBody.content["application/json"].schema.required = ["uppercase"];
    });
    expect(diffBreaking(doc(), changed)).toContain(
      "request POST /echo/{message}: property became required: uppercase",
    );
  });

  test("operation id rename breaks (client method stability)", () => {
    const changed = doc((d) => {
      (d.paths["/echo/{message}"]?.post as Record<string, unknown>).operationId =
        "post_echoMessage2";
    });
    expect(diffBreaking(doc(), changed)).toContain(
      "operation id changed on POST /echo/{message}: post_echoMessage",
    );
  });

  test("preserves compatible request union alternatives", () => {
    const proof = Schema.Union([
      Schema.Struct({ type: Schema.Literal("privy"), token: Schema.String }),
      Schema.Struct({ type: Schema.Literal("jwt"), jwt: Schema.String }),
    ]);
    const oldDocument = generateOpenApi([
      endpoint({
        method: "POST",
        path: "/session",
        auth: Auth.public(),
        request: { body: Schema.Struct({ proof }) },
        response: Schema.Struct({ ok: Schema.Boolean }),
      }),
    ]);
    const newDocument = JSON.parse(JSON.stringify(oldDocument)) as OpenApiDocument;

    expect(diffBreaking(oldDocument, newDocument)).toEqual([]);
  });

  test("uses request-direction compatibility for parameters and body requiredness", () => {
    const optionalized = doc((d) => {
      const post = d.paths["/echo/{message}"]?.post as {
        parameters: Array<{ required: boolean }>;
        requestBody: { required: boolean };
      };
      const path = post.parameters[0];
      if (path) path.required = false;
      post.requestBody.required = false;
    });
    expect(diffBreaking(doc(), optionalized)).toEqual([]);

    const optionalOld = optionalized;
    expect(diffBreaking(optionalOld, doc())).toEqual([
      "request POST /echo/{message}: parameter became required: path:message",
      "request body became required on POST /echo/{message}",
    ]);
  });

  test("detects a newly added required request property", () => {
    const changed = doc((d) => {
      const post = d.paths["/echo/{message}"]?.post as unknown as {
        requestBody: {
          content: {
            "application/json": {
              schema: { properties: Record<string, unknown>; required?: string[] };
            };
          };
        };
      };
      const schema = post.requestBody.content["application/json"].schema;
      schema.properties.new_field = { type: "string" };
      schema.required = [...(schema.required ?? []), "new_field"];
    });
    expect(diffBreaking(doc(), changed)).toContain(
      "request POST /echo/{message}: property became required: new_field",
    );
  });

  test("allows response narrowing and rejects response widening", () => {
    const withEnum = (values: readonly string[]) =>
      doc((d) => {
        const post = d.paths["/echo/{message}"]?.post as unknown as {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { properties: { message: { enum?: readonly string[] } } };
                };
              };
            };
          };
        };
        post.responses["200"].content["application/json"].schema.properties.message.enum = values;
      });

    expect(diffBreaking(withEnum(["a", "b"]), withEnum(["a"]))).toEqual([]);
    expect(diffBreaking(withEnum(["a"]), withEnum(["a", "b"]))).toContain(
      'response POST /echo/{message}: enum value added: "b" at message',
    );
  });

  test("detects removal of a declared wire-error code", () => {
    const changed = doc((d) => {
      const post = d.paths["/echo/{message}"]?.post as unknown as {
        responses: Record<string, { "x-error-codes"?: string[] }>;
      };
      post.responses["429"] = {
        ...post.responses["429"],
        "x-error-codes": [],
      };
    });
    expect(diffBreaking(doc(), changed)).toContain(
      "error code removed on POST /echo/{message} status 429: rate_limited",
    );
  });
});
