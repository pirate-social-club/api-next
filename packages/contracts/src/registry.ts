import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";

export const Health = endpoint({
  method: "GET",
  path: "/health",
  auth: Auth.public(),
  response: Schema.Struct({ status: Schema.Literal("ok") }),
});

import * as money from "./community-purchase-funding.ts";
/** Named registry; the client generator references these exports by name. */
import * as v1 from "./v1.ts";
import * as verification from "./verification.ts";

export const registry = { Health, ...v1, ...verification, ...money } as const;

/** The sole source consumed by every generated HTTP artifact. */
import type { EndpointDefinition } from "./endpoint.ts";

export const endpoints: readonly EndpointDefinition[] = Object.values(registry);
