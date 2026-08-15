import type { OpenApiDocument } from "./codegen.ts";

export type { OpenApiDocument };

/**
 * OpenAPI breaking-change detector (api-next 000 §5): contracts are
 * append-only within a major surface version; a breaking change requires a
 * new path or an explicit deprecation entry. The detector covers the
 * diff classes that would break the Solid client or the wire envelope;
 * purely additive changes pass.
 */

type JsonSchema = Record<string, unknown>;

interface Operation {
  readonly path: string;
  readonly method: string;
  readonly operation: JsonSchema;
}

function* operations(document: OpenApiDocument): Generator<Operation> {
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      yield { path, method, operation: operation as JsonSchema };
    }
  }
}

function requestBodySchema(operation: JsonSchema): JsonSchema | undefined {
  const body = operation.requestBody as JsonSchema | undefined;
  const content = body?.content as Record<string, { schema?: JsonSchema }> | undefined;
  return content?.["application/json"]?.schema;
}

function schemaBreaks(oldSchema: JsonSchema, newSchema: JsonSchema, where: string): string[] {
  const breaks: string[] = [];
  if (oldSchema.type !== undefined && oldSchema.type !== newSchema.type) {
    breaks.push(
      `${where}: type changed from ${String(oldSchema.type)} to ${String(newSchema.type)}`,
    );
  }
  if (oldSchema.const !== undefined && oldSchema.const !== newSchema.const) {
    breaks.push(
      `${where}: const changed from ${String(oldSchema.const)} to ${String(newSchema.const)}`,
    );
  }
  const oldProps = (oldSchema.properties ?? {}) as Record<string, JsonSchema>;
  const newProps = (newSchema.properties ?? {}) as Record<string, JsonSchema>;
  for (const name of Object.keys(oldProps)) {
    if (!(name in newProps)) breaks.push(`${where}: response/request property removed: ${name}`);
  }
  const oldRequired = new Set((oldSchema.required ?? []) as string[]);
  const newRequired = ((newSchema.required ?? []) as string[]).filter(
    (name) => !oldRequired.has(name),
  );
  for (const name of newRequired) {
    if (name in oldProps) breaks.push(`${where}: property became required: ${name}`);
  }
  for (const [name, prop] of Object.entries(newProps)) {
    const oldProp = oldProps[name];
    if (oldProp !== undefined && prop.minimum !== undefined) {
      if ((oldProp.minimum as number) < (prop.minimum as number)) {
        breaks.push(`${where}: property minimum raised: ${name}`);
      }
    }
  }
  return breaks;
}

export function diffBreaking(oldDoc: OpenApiDocument, newDoc: OpenApiDocument): readonly string[] {
  const breaks: string[] = [];
  const key = (op: Operation) => `${op.method.toUpperCase()} ${op.path}`;
  const oldOps = new Map<string, Operation>();
  for (const op of operations(oldDoc)) oldOps.set(key(op), op);
  const newOps = new Map<string, Operation>();
  for (const op of operations(newDoc)) newOps.set(key(op), op);

  for (const [opKey, oldOp] of oldOps) {
    const newOp = newOps.get(opKey);
    if (newOp === undefined) {
      breaks.push(`operation removed: ${opKey}`);
      continue;
    }
    if (oldOp.operation.operationId !== newOp.operation.operationId) {
      breaks.push(`operation id changed on ${opKey}: ${String(oldOp.operation.operationId)}`);
    }
    const oldResponses = oldOp.operation.responses as Record<string, unknown>;
    const newResponses = newOp.operation.responses as Record<string, unknown>;
    const oldStatuses = new Set(Object.keys(oldResponses));
    for (const status of Object.keys(newResponses)) {
      oldStatuses.delete(status);
    }
    for (const removed of oldStatuses) {
      breaks.push(`response status removed on ${opKey}: ${removed}`);
    }
    const oldBody = requestBodySchema(oldOp.operation);
    const newBody = requestBodySchema(newOp.operation);
    if (oldBody !== undefined && newBody === undefined) {
      breaks.push(`request body removed on ${opKey}`);
    } else if (oldBody !== undefined && newBody !== undefined) {
      breaks.push(...schemaBreaks(oldBody, newBody, `request ${opKey}`));
    }
    const oldResponse = oldResponses["200"] as JsonSchema | undefined;
    const newResponse = newResponses["200"] as JsonSchema | undefined;
    if (oldResponse !== undefined && newResponse !== undefined) {
      const oldContent = oldResponse.content as Record<string, { schema?: JsonSchema }>;
      const newContent = newResponse.content as Record<string, { schema?: JsonSchema }>;
      const oldSchema = oldContent["application/json"]?.schema as JsonSchema;
      const newSchema = newContent["application/json"]?.schema as JsonSchema;
      if (oldSchema !== undefined && newSchema !== undefined) {
        breaks.push(...schemaBreaks(oldSchema, newSchema, `response ${opKey}`));
      }
    }
  }
  return breaks;
}
