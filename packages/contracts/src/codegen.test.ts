import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { generateClient, generateOpenApi, generateRouteTable, schemaToOpenApi } from "./codegen.ts";
import { endpoint } from "./endpoint.ts";
import { BadRequest, RateLimited } from "./errors.ts";
import { Cents } from "./money.ts";
import { diffBreaking, type OpenApiDocument } from "./openapi-diff.ts";
import { registry } from "./registry.ts";

const fixture = endpoint({
  method: "POST",
  path: "/echo/:message",
  auth: Auth.user(),
  request: Schema.Struct({ uppercase: Schema.optional(Schema.Boolean) }),
  response: Schema.Struct({ message: Schema.String }),
  errors: [RateLimited],
});
const fixtureDoc = () => generateOpenApi([fixture]);

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
        request: Schema.Struct({ a: Schema.String }),
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
    expect(client).toContain('body: bodyEncoding === "raw-text" ? requestInput.body as string');
    expect(client).toContain(
      'request("post_callbacksRaw", "POST", "/callbacks/raw", input, options, "raw-text")',
    );
  });

  test("JSON remains the default request body encoding", () => {
    const client = generateClient({ Json: fixture });
    expect(client).toContain(
      'headers.set("content-type", bodyEncoding === "raw-text" ? "text/plain" : "application/json")',
    );
    expect(client).toContain(
      'body: bodyEncoding === "raw-text" ? requestInput.body as string : JSON.stringify(requestInput.body)',
    );
    expect(client).toContain(
      'request("post_echoMessage", "POST", "/echo/:message", input, options),',
    );
    expect(generateOpenApi([fixture]).paths["/echo/{message}"]?.post).toMatchObject({
      requestBody: { content: { "application/json": { schema: { type: "object" } } } },
    });
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
        request: Schema.Struct({ proof }),
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
      'response POST /echo/{message}: enum value added: "b"',
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
