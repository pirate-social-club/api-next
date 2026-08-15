import type { AuthPolicyApplication } from "./auth.ts";
import type { ApiError } from "./errors.ts";

/**
 * The endpoint-as-value shape (api-next 000 §5; 001 phase 0 step 3).
 *
 * Every route in api-next is declared as one of these values; the HTTP
 * adapter, OpenAPI document, and Solid client are generated from them. The
 * SHAPE is frozen at phase 0 — request/response carry Effect Schema values
 * whose precise typing lane A's DSL refines without changing this surface.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Constructors from the wire-error catalog a handler may fail with. */
export type ApiErrorCtor = new (args: never) => ApiError;

export interface EndpointDefinition {
  readonly method: HttpMethod;
  /** Path with `:param` placeholders; path params are schema-decoded. */
  readonly path: string;
  readonly auth: AuthPolicyApplication;
  /** Effect Schema for body + params + query; lane A types the composition. */
  readonly request?: unknown;
  readonly response: unknown;
  /** Closed error union, drawn from the frozen catalog. */
  readonly errors?: readonly ApiErrorCtor[];
}

/**
 * Identity at runtime; the type-level contract is the value itself. Lane A
 * may extend the returned type with derived metadata (OpenAPI annotations,
 * route-table keys) — the input shape stays frozen.
 */
export function endpoint<const E extends EndpointDefinition>(def: E): E {
  return def;
}
