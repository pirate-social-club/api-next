import type { Schema } from "effect";
import type { AuthPolicyApplication } from "./auth.ts";
import type { ApiError } from "./errors.ts";

/**
 * The endpoint-as-value shape (api-next 000 §5; 001 phase 0 step 3).
 *
 * Every route in api-next is declared as one of these values; the HTTP
 * adapter, OpenAPI document, and Solid client are generated from them. The
 * The shape amendment is coordinator-mediated: request locations and success
 * statuses are first-class so the generated adapter can enforce the frozen
 * wire boundary without exposing an untyped context escape hatch.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Wire representation used when an endpoint carries a request body. */
export type EndpointBodyEncoding = "json" | "raw-text";

/** Constructors from the wire-error catalog a handler may fail with. */
export type ApiErrorCtor = new (args: never) => ApiError;

/**
 * The independently decoded request locations. A request schema is
 * deliberately not a single body-shaped value: path and query data are part
 * of the contract and are decoded before a handler can see them.
 */
export interface EndpointRequest {
  readonly body?: Schema.Schema<unknown>;
  readonly bodyRequired?: boolean;
  /** Defaults to JSON; raw-text bodies are passed to handlers byte-for-byte. */
  readonly bodyEncoding?: EndpointBodyEncoding;
  /** Schema for the subset of incoming headers exposed to the handler. */
  readonly headers?: Schema.Schema<unknown>;
  readonly path?: Schema.Schema<unknown>;
  readonly query?: Schema.Schema<unknown>;
}

/** A successful response may have more than one status when the old wire
 * contract chooses the status from a typed result (for example 201/202 post
 * creation). */
export type SuccessStatus = number | readonly number[];

export interface EndpointDefinition {
  readonly method: HttpMethod;
  /** Path with `:param` placeholders; path params are schema-decoded. */
  readonly path: string;
  readonly auth: AuthPolicyApplication;
  /** Effect Schemas for body, path params, and query params. */
  readonly request?: EndpointRequest;
  /** Effect Schema for the exact success response envelope. */
  readonly response: Schema.Schema<unknown>;
  /** HTTP status emitted for a successful handler result; defaults to 200. */
  readonly successStatus?: SuccessStatus;
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
