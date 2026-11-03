import { expect, test } from "bun:test";
import { diffBreaking, type OpenApiDocument } from "./openapi-diff.ts";

function document(values: readonly string[], request = false): OpenApiDocument {
  const content = { "application/json": { schema: { type: "string", enum: [...values] } } };
  return {
    openapi: "3.1.0",
    info: { title: "Enum transition fixture", version: "1" },
    paths: {
      "/enum": {
        post: {
          operationId: "post_enum",
          ...(request ? { requestBody: { required: true, content } } : {}),
          responses: { "200": { description: "Success", ...(request ? {} : { content }) } },
        },
      },
    },
  };
}

test("reports every added response value, so declaring one cannot hide another in the same enum", () => {
  expect(
    diffBreaking(document(["retained"]), document(["retained", "adopted", "unreviewed"])),
  ).toEqual([
    'response POST /enum: enum value added: "adopted"',
    'response POST /enum: enum value added: "unreviewed"',
  ]);
});

test("reports every removed request value in an enum", () => {
  expect(
    diffBreaking(document(["retained", "one", "two"], true), document(["retained"], true)),
  ).toEqual([
    'request POST /enum: enum value removed: "one"',
    'request POST /enum: enum value removed: "two"',
  ]);
});
