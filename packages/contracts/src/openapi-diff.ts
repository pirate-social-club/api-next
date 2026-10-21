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

export interface DiffBreakingOptions {
  /** Tooling-only ownership for retained output of the former inline generator.
   * Never applies to the candidate, nor makes historical pointers valid OpenAPI.
   */
  readonly oldSchemaReferences?: "embedded-definitions";
}

class SchemaContext {
  readonly identities = new Map<JsonSchema, number>();
  readonly owners = new Map<JsonSchema, JsonSchema>();
  steps = 0;

  constructor(
    readonly document: OpenApiDocument,
    readonly embeddedDefinitions = false,
  ) {
    const index = (value: unknown, owner?: JsonSchema): void => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Unsupported non-object OpenAPI schema");
      }
      const schema = value as JsonSchema;
      if (this.identities.has(schema)) return;
      this.identities.set(schema, this.identities.size);
      const root = embeddedDefinitions && schema.$defs !== undefined ? schema : owner;
      if (root !== undefined) this.owners.set(schema, root);
      for (const keyword of ["$id", "$anchor", "$dynamicAnchor", "$dynamicRef", "$recursiveRef"]) {
        if (schema[keyword] !== undefined) {
          throw new Error(`Unsupported OpenAPI reference keyword: ${keyword}`);
        }
      }
      for (const keyword of [
        "$defs",
        "definitions",
        "properties",
        "patternProperties",
        "dependentSchemas",
      ]) {
        const children = schema[keyword];
        if (typeof children === "object" && children !== null) {
          for (const child of Object.values(children)) index(child, root);
        }
      }
      for (const keyword of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
        const children = schema[keyword];
        if (Array.isArray(children)) for (const child of children) index(child, root);
      }
      for (const keyword of [
        "items",
        "additionalProperties",
        "contains",
        "not",
        "if",
        "then",
        "else",
        "propertyNames",
        "unevaluatedProperties",
        "unevaluatedItems",
        "contentSchema",
      ]) {
        const child = schema[keyword];
        if (typeof child === "object" && child !== null) index(child, root);
      }
    };
    // Stop at schema roots: examples/defaults/consts are data, not schemas.
    const roots = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) roots(child);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "schema") index(child);
        else if (key === "$ref") throw new Error("Unsupported OpenAPI non-schema reference");
        else roots(child);
      }
    };
    roots(document.paths);
    for (const schema of Object.values(document.components?.schemas ?? {})) index(schema);
    // Validate even new operations, unused definitions and unmatched branches.
    for (const schema of this.identities.keys()) this.dereference(schema);
  }

  dereference(schema: JsonSchema): JsonSchema {
    const chain = new Set<JsonSchema>();
    let current = schema;
    while (current.$ref !== undefined) {
      const reference = current.$ref;
      if (typeof reference !== "string" || !reference.startsWith("#/")) {
        throw new Error(`Unsupported OpenAPI schema reference: ${String(reference)}`);
      }
      if (chain.has(current)) throw new Error(`Unproductive OpenAPI reference cycle: ${reference}`);
      chain.add(current);
      for (const key of Object.keys(current)) {
        if (
          ![
            "$ref",
            "$defs",
            "title",
            "description",
            "$comment",
            "default",
            "examples",
            "deprecated",
            "readOnly",
            "writeOnly",
          ].includes(key)
        ) {
          throw new Error(`Unsupported OpenAPI $ref sibling: ${key}`);
        }
      }
      const owner =
        this.embeddedDefinitions && reference.startsWith("#/$defs/")
          ? this.owners.get(current)
          : undefined;
      let target: unknown = owner ?? this.document;
      let pointer: string;
      try {
        pointer = decodeURIComponent(reference.slice(2));
      } catch {
        throw new Error(`Invalid OpenAPI JSON Pointer: ${reference}`);
      }
      for (const token of pointer.split("/")) {
        if (/~(?:[^01]|$)/u.test(token))
          throw new Error(`Invalid OpenAPI JSON Pointer: ${reference}`);
        const segment = token.replaceAll("~1", "/").replaceAll("~0", "~");
        if (typeof target !== "object" || target === null || !Object.hasOwn(target, segment)) {
          throw new Error(`Unresolved OpenAPI schema reference: ${reference}`);
        }
        target = (target as JsonSchema)[segment];
      }
      if (
        typeof target !== "object" ||
        target === null ||
        !this.identities.has(target as JsonSchema)
      ) {
        throw new Error(`OpenAPI reference does not address a schema: ${reference}`);
      }
      current = target as JsonSchema;
    }
    return current;
  }
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

function unionLeaves(
  schema: JsonSchema,
  context: SchemaContext,
  active = new Set<JsonSchema>(),
): readonly JsonSchema[] {
  const resolved = context.dereference(schema);
  if (++context.steps > 100_000) throw new Error("OpenAPI schema comparison budget exceeded");
  const members = alternatives(resolved);
  if (members === undefined) return [resolved];
  if (active.has(resolved) || active.size > 128)
    throw new Error("Unproductive OpenAPI union cycle");
  const next = new Set(active).add(resolved);
  return members.flatMap((member) => unionLeaves(member, context, next));
}

function finiteValues(schema: JsonSchema): readonly unknown[] | undefined {
  return schema.const !== undefined
    ? [schema.const]
    : Array.isArray(schema.enum)
      ? schema.enum
      : undefined;
}

function discriminantsOverlap(
  left: JsonSchema,
  right: JsonSchema,
  leftContext: SchemaContext,
  rightContext: SchemaContext,
): boolean {
  const a = leftContext.dereference(left);
  const b = rightContext.dereference(right);
  if (a.type !== undefined && b.type !== undefined) {
    const at = Array.isArray(a.type) ? a.type : [a.type];
    const bt = Array.isArray(b.type) ? b.type : [b.type];
    if (!at.some((type) => bt.includes(type))) return false;
  }
  const ap = (a.properties ?? {}) as Record<string, JsonSchema>;
  const bp = (b.properties ?? {}) as Record<string, JsonSchema>;
  const ar = (a.required ?? []) as string[];
  const br = (b.required ?? []) as string[];
  for (const name of ar) {
    const x = ap[name];
    const y = bp[name];
    if (x === undefined || y === undefined || !br.includes(name)) continue;
    const av = finiteValues(leftContext.dereference(x));
    const bv = finiteValues(rightContext.dereference(y));
    if (av !== undefined && bv !== undefined && !av.some((v) => bv.some((w) => valueEquals(v, w))))
      return false;
  }
  return true;
}

function compareAlternativeSets(
  oldSchema: JsonSchema,
  newSchema: JsonSchema,
  where: string,
  direction: Direction,
  oldDocument: SchemaContext,
  newDocument: SchemaContext,
  propertyPath: string,
  seen: Set<string>,
): string[] {
  const oldAlternatives = unionLeaves(oldSchema, oldDocument);
  const newAlternatives = unionLeaves(newSchema, newDocument);

  // A request union may grow, but every old input must still match at least
  // one new alternative. A response union may narrow, but every new output
  // must still match at least one old alternative. Matching each branch
  // independently prevents a structurally similar sibling from producing a
  // false removal for a valid union member.
  const source = direction === "request" ? oldAlternatives : newAlternatives;
  const target = direction === "request" ? newAlternatives : oldAlternatives;
  const breaks: string[] = [];
  for (const sourceAlternative of source) {
    // Prefer a branch with compatible required tags. A one-error mismatch on
    // "age_locked" must not hide two field errors on the actual "content" arm.
    const matching = target.filter((candidate) =>
      direction === "request"
        ? discriminantsOverlap(sourceAlternative, candidate, oldDocument, newDocument)
        : discriminantsOverlap(candidate, sourceAlternative, oldDocument, newDocument),
    );
    let best: readonly string[] | undefined;
    for (const targetAlternative of matching.length > 0 ? matching : target) {
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
  oldDocument: SchemaContext,
  newDocument: SchemaContext,
  propertyPath = "",
  seen = new Set<string>(),
): string[] {
  const oldSchema = oldDocument.dereference(oldRaw);
  const newSchema = newDocument.dereference(newRaw);
  if (++oldDocument.steps > 100_000 || seen.size > 128) {
    throw new Error("OpenAPI schema comparison budget exceeded");
  }
  // Active schema pairs, independent of the growing diagnostic path, bound
  // productive recursion. Siblings/union trials keep independent active sets.
  const seenKey = `${oldDocument.identities.get(oldSchema)}|${newDocument.identities.get(newSchema)}`;
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

  const location = propertyPath === "" ? "" : ` at ${propertyPath}`;
  const oldType = oldSchema.type;
  const newType = newSchema.type;
  if (!valueEquals(oldType, newType)) {
    const bothTyped = oldType !== undefined && newType !== undefined;
    const requestNarrowed =
      direction === "request" && oldType === undefined && newType !== undefined;
    const responseWidened =
      direction === "response" && oldType !== undefined && newType === undefined;
    if (bothTyped || requestNarrowed || responseWidened) {
      return [`${where}: type changed from ${String(oldType)} to ${String(newType)}${location}`];
    }
  }
  const oldEnum = finiteValues(oldSchema);
  const newEnum = finiteValues(newSchema);
  if (oldEnum !== undefined && newEnum !== undefined) {
    const source = direction === "request" ? oldEnum : newEnum;
    const target = direction === "request" ? newEnum : oldEnum;
    for (const value of source) {
      if (!target.some((candidate) => valueEquals(value, candidate))) {
        const change = direction === "request" ? "removed" : "added";
        return [`${where}: enum value ${change}: ${JSON.stringify(value)}${location}`];
      }
    }
  } else if (direction === "request" && oldEnum === undefined && newEnum !== undefined) {
    return [`${where}: enum constraint added${location}`];
  } else if (direction === "response" && oldEnum !== undefined && newEnum === undefined) {
    return [`${where}: enum constraint removed${location}`];
  }

  const oldProperties = (oldSchema.properties ?? {}) as Record<string, JsonSchema>;
  const newProperties = (newSchema.properties ?? {}) as Record<string, JsonSchema>;
  const breaks: string[] = [];
  if (direction === "response" && oldSchema.additionalProperties === false) {
    for (const name of Object.keys(newProperties)) {
      if (!Object.hasOwn(oldProperties, name)) {
        const fullPath = propertyPath === "" ? name : `${propertyPath}.${name}`;
        breaks.push(`${where}: property added to closed response: ${fullPath}`);
      }
    }
  }
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
        breaks.push(
          `${where}: property became required: ${propertyPath === "" ? name : `${propertyPath}.${name}`}`,
        );
      }
    }
  } else {
    for (const name of oldRequired) {
      if (!newRequired.has(name) && name in newProperties) {
        breaks.push(
          `${where}: response property became optional: ${propertyPath === "" ? name : `${propertyPath}.${name}`}`,
        );
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
    breaks.push(`${where}: array item constraint added${location}`);
  } else if (
    direction === "response" &&
    oldSchema.items !== undefined &&
    newSchema.items === undefined
  ) {
    breaks.push(`${where}: array item constraint removed${location}`);
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
        breaks.push(`${where}: property ${name} narrowed${location}`);
      }
      if (direction === "response" && responseWidened(oldValue, newValue)) {
        breaks.push(`${where}: response property ${name} widened${location}`);
      }
    } else if (direction === "request" && oldValue === undefined && typeof newValue === "number") {
      breaks.push(`${where}: property ${name} constraint added${location}`);
    } else if (direction === "response" && typeof oldValue === "number" && newValue === undefined) {
      breaks.push(`${where}: response property ${name} constraint removed${location}`);
    }
  }

  const oldAllowsAdditional = oldSchema.additionalProperties !== false;
  const newAllowsAdditional = newSchema.additionalProperties !== false;
  if (direction === "request" && oldAllowsAdditional && !newAllowsAdditional) {
    breaks.push(`${where}: additional properties became forbidden${location}`);
  }
  if (direction === "response" && !oldAllowsAdditional && newAllowsAdditional) {
    breaks.push(`${where}: response additional properties became allowed${location}`);
  }
  return breaks;
}

function requestBodySchema(operation: JsonSchema): JsonSchema | undefined {
  const body = operation.requestBody as JsonSchema | undefined;
  const content = body?.content as Record<string, { schema?: JsonSchema }> | undefined;
  return content?.["application/json"]?.schema;
}

function responseContent(response: JsonSchema): Record<string, { schema?: JsonSchema }> {
  return (response.content ?? {}) as Record<string, { schema?: JsonSchema }>;
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
  oldDocument: SchemaContext,
  newDocument: SchemaContext,
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

export function diffBreaking(
  oldDocument: OpenApiDocument,
  newDocument: OpenApiDocument,
  options: DiffBreakingOptions = {},
): readonly string[] {
  const oldDoc = new SchemaContext(
    oldDocument,
    options.oldSchemaReferences === "embedded-definitions",
  );
  const newDoc = new SchemaContext(newDocument);
  const breaks: string[] = [];
  const key = (op: Operation) => `${op.method.toUpperCase()} ${op.path}`;
  const oldOps = new Map<string, Operation>();
  for (const op of operations(oldDocument)) oldOps.set(key(op), op);
  const newOps = new Map<string, Operation>();
  for (const op of operations(newDocument)) newOps.set(key(op), op);

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
      const oldContent = responseContent(oldResponse);
      const newContent = responseContent(newResponse);
      for (const [mediaType, oldMedia] of Object.entries(oldContent)) {
        const newMedia = newContent[mediaType];
        if (
          newMedia === undefined ||
          (oldMedia.schema !== undefined && newMedia.schema === undefined)
        ) {
          breaks.push(`response body removed on ${opKey} status ${status}`);
        } else if (oldMedia.schema !== undefined && newMedia.schema !== undefined) {
          const where =
            status === "200" ? `response ${opKey}` : `response ${opKey} status ${status}`;
          breaks.push(
            ...compareSchema(oldMedia.schema, newMedia.schema, where, "response", oldDoc, newDoc),
          );
          if (oldMedia.schema.format === "binary" && newMedia.schema.format !== "binary") {
            breaks.push(`binary response representation changed on ${opKey} status ${status}`);
          }
        }
      }
      if (oldResponse["x-conditional-authorization"] !== undefined) {
        if (
          !valueEquals(
            oldResponse["x-conditional-authorization"],
            newResponse["x-conditional-authorization"],
          )
        ) {
          breaks.push(`conditional authorization changed on ${opKey} status ${status}`);
        }
        if (!valueEquals(oldResponse.headers, newResponse.headers)) {
          breaks.push(`conditional response headers changed on ${opKey} status ${status}`);
        }
        if (status === "304" && Object.keys(newContent).length !== 0) {
          breaks.push(`conditional response body added on ${opKey} status ${status}`);
        }
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
