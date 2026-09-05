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
export type EndpointBodyEncoding = "json" | "exact-json" | "raw-bytes" | "raw-text";

/** Closed response-header contract carried by a declared retryable error. */
export interface RetryAfterHeaderContract {
  readonly minimumSeconds: number;
  readonly maximumSeconds: number;
  /** Canonical decimal representation accepted on the wire. */
  readonly pattern: string;
  /** When present, the header must equal this integer member of error.details. */
  readonly detailsKey?: string;
}

/** Constructors from the wire-error catalog a handler may fail with. */
export type ApiErrorCtor = (new (
  args: never,
) => ApiError) & {
  /** Optional closed details schema for generated wire-error declarations. */
  readonly detailsSchema?: Schema.Schema<unknown>;
  /** Whether the declared details member is required on the wire. */
  readonly detailsRequired?: boolean;
  /** Optional required Retry-After response-header contract. */
  readonly retryAfterHeader?: RetryAfterHeaderContract;
};

/**
 * The independently decoded request locations. A request schema is
 * deliberately not a single body-shaped value: path and query data are part
 * of the contract and are decoded before a handler can see them.
 */
export interface EndpointRequest {
  readonly body?: Schema.Schema<unknown>;
  readonly bodyRequired?: boolean;
  /** Defaults to JSON; raw encodings are passed to handlers without JSON parsing. */
  readonly bodyEncoding?: EndpointBodyEncoding;
  /** Maximum request-body size in UTF-8 bytes; defaults to the transport cap. */
  readonly maxBodyBytes?: number;
  /** Exact media types that carry raw bytes on an otherwise JSON endpoint. */
  readonly rawBodyContentTypes?: readonly string[];
  /** Raw-variant ceiling; defaults to maxBodyBytes. */
  readonly rawBodyMaxBytes?: number;
  /** Schema for the subset of incoming headers exposed to the handler. */
  readonly headers?: Schema.Schema<unknown>;
  readonly path?: Schema.Schema<unknown>;
  /**
   * Path parameters whose raw request-target segment must byte-match the
   * framework-decoded value. This rejects percent-encoded aliases before a
   * handler or cache can treat them as another spelling of one authority.
   */
  readonly exactRawPathParameters?: readonly string[];
  readonly query?: Schema.Schema<unknown>;
}

/** A successful response may have more than one status when the old wire
 * contract chooses the status from a typed result (for example 201/202 post
 * creation). */
export type SuccessStatus = number | readonly number[];

/** Initial closed binary representation. Conditional evaluation belongs to the
 * authorized handler, never a cache or middleware short circuit. Errors remain JSON.
 */
export interface BinaryResponseRepresentation {
  readonly kind: "binary";
  readonly contentType: "image/jpeg";
  readonly cacheControl: "private, no-cache";
  readonly conditional: "authorized-etag";
}

export interface EndpointDefinition {
  readonly method: HttpMethod;
  /** Path with `:param` placeholders; path params are schema-decoded. */
  readonly path: string;
  readonly auth: AuthPolicyApplication;
  /** Effect Schemas for body, path params, and query params. */
  readonly request?: EndpointRequest;
  /** Effect Schema for the exact success response envelope. */
  readonly response: Schema.Schema<unknown>;
  /** Omitted means the existing JSON representation. For binary responses the
   * response schema is not used to encode bytes; status/body/headers are closed
   * by this representation. Declare successStatus [200, 304] explicitly.
   */
  readonly responseRepresentation?: BinaryResponseRepresentation;
  /** HTTP status emitted for a successful handler result; defaults to 200. */
  readonly successStatus?: SuccessStatus;
  /** Closed error union, drawn from the frozen catalog. */
  readonly errors?: readonly ApiErrorCtor[];
}

/**
 * Validates the closed binary representation; the returned value retains its type. Lane A
 * may extend the returned type with derived metadata (OpenAPI annotations,
 * route-table keys) — the input shape stays frozen.
 */
export function endpoint<const E extends EndpointDefinition>(def: E): E {
  if (def.responseRepresentation !== undefined) {
    const representation = def.responseRepresentation;
    const statuses = Array.isArray(def.successStatus) ? def.successStatus : [];
    if (
      def.method !== "GET" ||
      representation.kind !== "binary" ||
      representation.contentType !== "image/jpeg" ||
      representation.cacheControl !== "private, no-cache" ||
      representation.conditional !== "authorized-etag" ||
      statuses.length !== 2 ||
      !statuses.includes(200) ||
      !statuses.includes(304)
    )
      throw new Error("Invalid binary response contract");
  }
  return def;
}
