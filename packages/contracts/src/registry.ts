import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";

export const Health = endpoint({
  method: "GET",
  path: "/health",
  auth: Auth.public(),
  response: Schema.Struct({ status: Schema.Literal("ok") }),
});

/** The sole source consumed by every generated HTTP artifact. */
export const endpoints = [Health] as const;
