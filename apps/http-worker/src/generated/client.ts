// GENERATED FILE. DO NOT EDIT. Regenerate with bun run generate:contracts.
import type { Schema } from "effect";
import {
  Health,
  Echo,
} from "@pirate/contracts";

type ClientInput<E> = E extends { readonly request: Schema.Schema<infer I> } ? I : undefined;
type ClientOutput<E> = E extends { readonly response: Schema.Schema<infer A> } ? A : never;

export interface PirateApiClient {
  get_health: (input: ClientInput<typeof Health>) => Promise<ClientOutput<typeof Health>>;
  post_echoMessage: (input: ClientInput<typeof Echo>) => Promise<ClientOutput<typeof Echo>>;
}

export function createPirateApiClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): PirateApiClient {
  const request = async <T>(method: string, path: string, input: unknown): Promise<T> => {
    const url = Object.entries((input ?? {}) as Record<string, unknown>).reduce(
      (u, [key, value]) => u.replaceAll(`:${key}`, encodeURIComponent(String(value))),
      path,
    );
    const response = await fetchImpl(new URL(url, baseUrl), {
      method,
      headers: { "content-type": "application/json" },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    if (!response.ok) throw await response.json();
    return response.json() as Promise<T>;
  };
  return {
  get_health: (input) => request("GET", "/health", input),
  post_echoMessage: (input) => request("POST", "/echo/:message", input),
  };
}
