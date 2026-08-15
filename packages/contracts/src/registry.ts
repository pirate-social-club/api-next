import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { RateLimited } from "./errors.ts";

export const Health = endpoint({
  method: "GET",
  path: "/health",
  auth: Auth.public(),
  response: Schema.Struct({ status: Schema.Literal("ok") }),
});

export const Echo = endpoint({
  method: "POST",
  path: "/echo/:message",
  auth: Auth.user(),
  request: Schema.Struct({ uppercase: Schema.optional(Schema.Boolean) }),
  response: Schema.Struct({ message: Schema.String }),
  errors: [RateLimited],
});

/** Named registry; the client generator references these exports by name. */
export const registry = { Health, Echo } as const;

/** The sole source consumed by every generated HTTP artifact. */
import type { EndpointDefinition } from "./endpoint.ts";

export const endpoints: readonly EndpointDefinition[] = Object.values(registry);
