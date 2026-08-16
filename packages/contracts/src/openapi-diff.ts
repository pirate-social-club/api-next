import type { OpenApiDocument } from "./codegen.ts";

export type { OpenApiDocument };

/**
 * OpenAPI breaking-change detector (api-next 000 §5): contracts are
 * append-only within a major surface version; a breaking change requires a
 * new path or an explicit deprecation entry. The detector compares every
 * request location, recursively walks schemas, and checks every old response
 * status rather than assuming that only 200 carries a contract.
 */

type JsonSchema = Record<string, unknown>;
type Direction = "request" | "response";

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

function dereference(schema: JsonSchema, document: OpenApiDocument): JsonSchema {
  const reference = schema.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/")) return schema;

  let current: unknown = document as unknown;
  for (const segment of reference.slice(2).split("/")) {
    if (typeof current !== "object" || current === null) return schema;
    current = (current as Record<string, unknown>)[
      segment.replaceAll("~1", "/").replaceAll("~0", "~")
    ];
  }
  return typeof current === "object" && current !== null ? (current as JsonSchema) : schema;
}

function alternatives(schema: JsonSchema): readonly JsonSchema[] | undefined {
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) return anyOf as JsonSchema[];
  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf)) return oneOf as JsonSchema[];
  return undefined;
}

function valueEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shorter(left: readonly string[], right: readonly string[]): readonly string[] {
  return left.length <= right.length ? left : right;
}

function compareAlternativeSets(
  oldSchema: JsonSchema,
  newSchema: JsonSchema,
  where: string,
  direction: Direction,
  oldDocument: OpenApiDocument,
  newDocument: OpenApiDocument,
  propertyPath: string,
  seen: Set<string>,
): string[] {
  const oldAlternatives = alternatives(oldSchema) ?? [oldSchema];
  const newAlternatives = alternatives(newSchema) ?? [newSchema];

  // A request union may grow, but every old input must still match at least
  // one new alternative. A response union may narrow, but every new output
  // must still match at least one old alternative. Matching each branch
  // independently prevents a structurally similar sibling from producing a
  // false removal for a valid union member.
  const source = direction === "request" ? oldAlternatives : newAlternatives;
  const target = direction === "request" ? newAlternatives : oldAlternatives;
  const breaks: string[] = [];
  for (const sourceAlternative of source) {
    let best: readonly string[] | undefined;
    for (const targetAlternative of target) {
      const result =
        direction === "request"
          ? compareSchema(
              sourceAlternative,
              targetAlternative,
              where,
              direction,
              oldDocument,
              newDocument,
              propertyPath,
              new Set(seen),
            )
          : compareSchema(
              targetAlternative,
              sourceAlternative,
              where,
              direction,
              oldDocument,
              newDocument,
              propertyPath,
              new Set(seen),
            );
      best = best === undefined ? result : shorter(best, result);
      if (result.length === 0) break;
    }
    if (best !== undefined && best.length > 0) breaks.push(...best);
  }
  return [...new Set(breaks)];
}

function compareSchema(
  oldRaw: JsonSchema,
  newRaw: JsonSchema,
  where: string,
  direction: Direction,
  oldDocument: OpenApiDocument,
  newDocument: OpenApiDocument,
  propertyPath = "",
  seen = new Set<string>(),
): string[] {
  const oldSchema = dereference(oldRaw, oldDocument);
  const newSchema = dereference(newRaw, newDocument);
  const seenKey = `${JSON.stringify(oldSchema)}|${JSON.stringify(newSchema)}|${propertyPath}`;
  if (seen.has(seenKey)) return [];
  const nextSeen = new Set(seen).add(seenKey);

  if (alternatives(oldSchema) !== undefined || alternatives(newSchema) !== undefined) {
    return compareAlternativeSets(
      oldSchema,
      newSchema,
      where,
      direction,
      oldDocument,
      newDocument,
      propertyPath,
      nextSeen,
    );
  }

  const oldType = oldSchema.type;
  const newType = newSchema.type;
  if (!valueEquals(oldType, newType)) {
    const bothTyped = oldType !== undefined && newType !== undefined;
    const requestNarrowed =
      direction === "request" && oldType === undefined && newType !== undefined;
    const responseWidened =
      direction === "response" && oldType !== undefined && newType === undefined;
    if (bothTyped || requestNarrowed || responseWidened) {
      return [`${where}: type changed from ${String(oldType)} to ${String(newType)}`];
    }
  }
  if (!valueEquals(oldSchema.const, newSchema.const)) {
    const bothConstant = oldSchema.const !== undefined && newSchema.const !== undefined;
    const requestNarrowed =
      direction === "request" && oldSchema.const === undefined && newSchema.const !== undefined;
    const responseWidened =
      direction === "response" && oldSchema.const !== undefined && newSchema.const === undefined;
    if (bothConstant || requestNarrowed || responseWidened) {
      return [`${where}: const changed`];
    }
  }

  const oldEnum = Array.isArray(oldSchema.enum) ? oldSchema.enum : undefined;
  const newEnum = Array.isArray(newSchema.enum) ? newSchema.enum : undefined;
  if (oldEnum !== undefined && newEnum !== undefined) {
    const source = direction === "request" ? oldEnum : newEnum;
    const target = direction === "request" ? newEnum : oldEnum;
    for (const value of source) {
      if (!target.some((candidate) => valueEquals(value, candidate))) {
        const change = direction === "request" ? "removed" : "added";
        return [`${where}: enum value ${change}: ${JSON.stringify(value)}`];
      }
    }
  } else if (direction === "request" && oldEnum === undefined && newEnum !== undefined) {
    return [`${where}: enum constraint added`];
  } else if (direction === "response" && oldEnum !== undefined && newEnum === undefined) {
    return [`${where}: enum constraint removed`];
  }

  const oldProperties = (oldSchema.properties ?? {}) as Record<string, JsonSchema>;
  const newProperties = (newSchema.properties ?? {}) as Record<string, JsonSchema>;
  const breaks: string[] = [];
  for (const [name, oldProperty] of Object.entries(oldProperties)) {
    const newProperty = newProperties[name];
    const fullPath = propertyPath === "" ? name : `${propertyPath}.${name}`;
    if (newProperty === undefined) {
      breaks.push(`${where}: response/request property removed: ${fullPath}`);
      continue;
    }
    breaks.push(
      ...compareSchema(
        oldProperty,
        newProperty,
        where,
        direction,
        oldDocument,
        newDocument,
        fullPath,
        nextSeen,
      ),
    );
  }

  const oldRequired = new Set((oldSchema.required ?? []) as string[]);
  const newRequired = new Set((newSchema.required ?? []) as string[]);
  if (direction === "request") {
    for (const name of newRequired) {
      if (!oldRequired.has(name)) {
        breaks.push(`${where}: property became required: ${name}`);
      }
    }
  } else {
    for (const name of oldRequired) {
      if (!newRequired.has(name) && name in newProperties) {
        breaks.push(`${where}: response property became optional: ${name}`);
      }
    }
  }

  if (oldSchema.items !== undefined && newSchema.items !== undefined) {
    breaks.push(
      ...compareSchema(
        oldSchema.items as JsonSchema,
        newSchema.items as JsonSchema,
        where,
        direction,
        oldDocument,
        newDocument,
        propertyPath === "" ? "items" : `${propertyPath}.items`,
        nextSeen,
      ),
    );
  } else if (
    direction === "request" &&
    oldSchema.items === undefined &&
    newSchema.items !== undefined
  ) {
    breaks.push(`${where}: array item constraint added`);
  } else if (
    direction === "response" &&
    oldSchema.items !== undefined &&
    newSchema.items === undefined
  ) {
    breaks.push(`${where}: array item constraint removed`);
  }

  const bounds: readonly [
    string,
    (oldValue: number, newValue: number) => boolean,
    (oldValue: number, newValue: number) => boolean,
  ][] = [
    [
      "minimum",
      (oldValue, newValue) => newValue > oldValue,
      (oldValue, newValue) => newValue < oldValue,
    ],
    [
      "minLength",
      (oldValue, newValue) => newValue > oldValue,
      (oldValue, newValue) => newValue < oldValue,
    ],
    [
      "minItems",
      (oldValue, newValue) => newValue > oldValue,
      (oldValue, newValue) => newValue < oldValue,
    ],
    [
      "maximum",
      (oldValue, newValue) => newValue < oldValue,
      (oldValue, newValue) => newValue > oldValue,
    ],
    [
      "maxLength",
      (oldValue, newValue) => newValue < oldValue,
      (oldValue, newValue) => newValue > oldValue,
    ],
    [
      "maxItems",
      (oldValue, newValue) => newValue < oldValue,
      (oldValue, newValue) => newValue > oldValue,
    ],
  ];
  for (const [name, requestNarrowed, responseWidened] of bounds) {
    const oldValue = oldSchema[name];
    const newValue = newSchema[name];
    if (typeof oldValue === "number" && typeof newValue === "number") {
      if (direction === "request" && requestNarrowed(oldValue, newValue)) {
        breaks.push(`${where}: property ${name} narrowed`);
      }
      if (direction === "response" && responseWidened(oldValue, newValue)) {
        breaks.push(`${where}: response property ${name} widened`);
      }
    } else if (direction === "request" && oldValue === undefined && typeof newValue === "number") {
      breaks.push(`${where}: property ${name} constraint added`);
    } else if (direction === "response" && typeof oldValue === "number" && newValue === undefined) {
      breaks.push(`${where}: response property ${name} constraint removed`);
    }
  }

  const oldAllowsAdditional = oldSchema.additionalProperties !== false;
  const newAllowsAdditional = newSchema.additionalProperties !== false;
  if (direction === "request" && oldAllowsAdditional && !newAllowsAdditional) {
    breaks.push(`${where}: additional properties became forbidden`);
  }
  if (direction === "response" && !oldAllowsAdditional && newAllowsAdditional) {
    breaks.push(`${where}: response additional properties became allowed`);
  }
  return breaks;
}

function requestBodySchema(operation: JsonSchema): JsonSchema | undefined {
  const body = operation.requestBody as JsonSchema | undefined;
  const content = body?.content as Record<string, { schema?: JsonSchema }> | undefined;
  return content?.["application/json"]?.schema;
}

function responseSchema(response: JsonSchema): JsonSchema | undefined {
  const content = response.content as Record<string, { schema?: JsonSchema }> | undefined;
  return content?.["application/json"]?.schema;
}

function parameters(operation: JsonSchema): Map<string, JsonSchema> {
  const result = new Map<string, JsonSchema>();
  for (const parameter of (operation.parameters ?? []) as JsonSchema[]) {
    const location = typeof parameter.in === "string" ? parameter.in : "unknown";
    const name = typeof parameter.name === "string" ? parameter.name : "unknown";
    result.set(`${location}:${name}`, parameter);
  }
  return result;
}

function compareParameters(
  oldOperation: JsonSchema,
  newOperation: JsonSchema,
  where: string,
  oldDocument: OpenApiDocument,
  newDocument: OpenApiDocument,
): string[] {
  const breaks: string[] = [];
  const oldParameters = parameters(oldOperation);
  const newParameters = parameters(newOperation);
  for (const [key, oldParameter] of oldParameters) {
    const newParameter = newParameters.get(key);
    if (newParameter === undefined) {
      breaks.push(`${where}: parameter removed: ${key}`);
      continue;
    }
    if (oldParameter.required !== true && newParameter.required === true) {
      breaks.push(`${where}: parameter became required: ${key}`);
    }
    const oldSchema = oldParameter.schema as JsonSchema | undefined;
    const newSchema = newParameter.schema as JsonSchema | undefined;
    if (oldSchema !== undefined && newSchema !== undefined) {
      breaks.push(
        ...compareSchema(
          oldSchema,
          newSchema,
          `${where} parameter ${key}`,
          "request",
          oldDocument,
          newDocument,
        ),
      );
    }
  }
  for (const [key, newParameter] of newParameters) {
    if (!oldParameters.has(key) && newParameter.required === true) {
      breaks.push(`${where}: required parameter added: ${key}`);
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

    breaks.push(
      ...compareParameters(oldOp.operation, newOp.operation, `request ${opKey}`, oldDoc, newDoc),
    );

    const oldBody = requestBodySchema(oldOp.operation);
    const newBody = requestBodySchema(newOp.operation);
    const oldRequestBody = oldOp.operation.requestBody as JsonSchema | undefined;
    const newRequestBody = newOp.operation.requestBody as JsonSchema | undefined;
    if (oldBody !== undefined && newBody === undefined) {
      breaks.push(`request body removed on ${opKey}`);
    } else if (oldBody !== undefined && newBody !== undefined) {
      if (oldRequestBody?.required !== true && newRequestBody?.required === true) {
        breaks.push(`request body became required on ${opKey}`);
      }
      breaks.push(
        ...compareSchema(oldBody, newBody, `request ${opKey}`, "request", oldDoc, newDoc),
      );
    } else if (
      oldBody === undefined &&
      newBody !== undefined &&
      newRequestBody?.required === true
    ) {
      breaks.push(`required request body added on ${opKey}`);
    }

    const oldResponses = (oldOp.operation.responses ?? {}) as Record<string, JsonSchema>;
    const newResponses = (newOp.operation.responses ?? {}) as Record<string, JsonSchema>;
    for (const [status, oldResponse] of Object.entries(oldResponses)) {
      const newResponse = newResponses[status];
      if (newResponse === undefined) {
        breaks.push(`response status removed on ${opKey}: ${status}`);
        continue;
      }
      const oldSchema = responseSchema(oldResponse);
      const newSchema = responseSchema(newResponse);
      if (oldSchema !== undefined && newSchema === undefined) {
        breaks.push(`response body removed on ${opKey} status ${status}`);
      } else if (oldSchema !== undefined && newSchema !== undefined) {
        const where = status === "200" ? `response ${opKey}` : `response ${opKey} status ${status}`;
        breaks.push(...compareSchema(oldSchema, newSchema, where, "response", oldDoc, newDoc));
      }
      const oldCodes = Array.isArray(oldResponse["x-error-codes"])
        ? (oldResponse["x-error-codes"] as unknown[])
        : [];
      const newCodes = Array.isArray(newResponse["x-error-codes"])
        ? (newResponse["x-error-codes"] as unknown[])
        : [];
      for (const code of oldCodes) {
        if (!newCodes.some((candidate) => valueEquals(candidate, code))) {
          breaks.push(`error code removed on ${opKey} status ${status}: ${String(code)}`);
        }
      }
    }
  }
  return [...new Set(breaks)];
}
