import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AlertSink } from "@pirate/platform-cf";
import { Effect } from "effect";
import { parseJsonc } from "../../../scripts/secret-drift-audit.ts";
import type { JobsWorkerEnv } from "./index.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeScheduledJobDeclarations, makeHnsRouteRevalidationComposition } = await import(
  "./index.ts"
);
const { makeHnsRouteRevalidationJob } = await import("./hns-route-revalidation.ts");
const { buildJobRegistry } = await import("./registry.ts");

type Binding = Readonly<{ binding?: string; name?: string }>;
type Scope = Readonly<{
  vars?: Readonly<Record<string, string>>;
  hyperdrive?: readonly Binding[];
  r2_buckets?: readonly Binding[];
  services?: readonly Binding[];
  durable_objects?: Readonly<{ bindings?: readonly Binding[] }>;
  secrets?: Readonly<{ required?: readonly string[] }>;
}>;
type Config = Scope & Readonly<{ env?: Readonly<Record<string, Scope>> }>;

const config = parseJsonc<Config>(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const sink: AlertSink = {
  log: () => undefined,
  delivery: { markSent: () => Effect.succeed(true), compensate: () => Effect.void },
};
const unreachable = () => {
  throw new Error("composition must not reach a binding");
};

/** Placeholder secret values of the shape the configuration validators accept. */
function secretValue(name: string): string {
  if (name.endsWith("_PRIVATE_KEY")) return `0x${(name.length % 9).toString().repeat(64)}`;
  if (name.endsWith("_URL") || name.endsWith("_ORIGIN")) return "https://configuration.invalid/";
  return `test-${name.toLowerCase()}`;
}

/** The bindings one environment gives the Worker. Wrangler does not inherit
 * vars or bindings from the top level into a named environment. */
function environmentFor(scope: Scope): JobsWorkerEnv {
  const env: Record<string, unknown> = { ...scope.vars };
  for (const name of scope.secrets?.required ?? []) env[name] = secretValue(name);
  for (const { binding } of scope.hyperdrive ?? []) {
    // Each Hyperdrive resource is distinct; the funding login refuses an alias.
    if (binding !== undefined)
      env[binding] = { connectionString: `postgres://test@127.0.0.1:1/${binding.toLowerCase()}` };
  }
  for (const { binding } of scope.r2_buckets ?? []) {
    if (binding !== undefined) env[binding] = { get: unreachable, put: unreachable };
  }
  for (const { binding } of scope.services ?? []) {
    if (binding !== undefined) env[binding] = { fetch: unreachable };
  }
  for (const { name } of scope.durable_objects?.bindings ?? []) {
    if (name !== undefined) env[name] = { getByName: unreachable, idFromName: unreachable };
  }
  env.CF_VERSION_METADATA = { id: "test-version", tag: "", timestamp: "" };
  return env as unknown as JobsWorkerEnv;
}

const scopes: readonly (readonly [string, Scope])[] = [
  ["top-level", config],
  ...Object.entries(config.env ?? {}),
];

describe("scheduled registry for every shipped jobs-worker environment", () => {
  test("covers the top level and the staging and production environments", () => {
    expect(scopes.map(([name]) => name)).toEqual(
      expect.arrayContaining(["top-level", "staging", "production"]),
    );
  });

  for (const [name, scope] of scopes) {
    test(`${name} composes a registry with no unpartitioned shared writer`, async () => {
      const { declarations } = makeScheduledJobDeclarations(environmentFor(scope), () => sink);
      const registry = await Effect.runPromise(buildJobRegistry(declarations));
      expect(registry.declarations.length).toBe(declarations.length);
    });
  }

  test("staging registers the shared writers that previously collided", () => {
    const staging = config.env?.staging;
    if (staging === undefined) throw new Error("staging configuration missing");
    const names = makeScheduledJobDeclarations(
      environmentFor(staging),
      () => sink,
    ).declarations.map((declaration) => declaration.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "hns-active-lease-renewal.poll",
        "spaces-native.route-renewal",
        "spaces-native.root-observation",
      ]),
    );
    expect(names).not.toContain("hns-route-revalidation.poll");
  });

  test("staging fails under the one-writer-per-table rule shipped in fb588f17", async () => {
    const staging = config.env?.staging;
    if (staging === undefined) throw new Error("staging configuration missing");
    const { declarations } = makeScheduledJobDeclarations(environmentFor(staging), () => sink);
    const error = await Effect.runPromise(Effect.flip(buildJobRegistry(declarations, {})));
    expect(error).toMatchObject({
      _tag: "RegistryConfigurationError",
      reason: "duplicate-table-writer",
    });
  });

  test("active-lease renewal beside HNS route revalidation is still a writer conflict", async () => {
    const staging = config.env?.staging;
    if (staging === undefined) throw new Error("staging configuration missing");
    const env = environmentFor(staging);
    const { declarations } = makeScheduledJobDeclarations(env, () => sink);
    const hns = makeHnsRouteRevalidationComposition({ ...env, HNS_OWNERSHIP_ENABLED: "true" });
    if (!hns.enabled) throw new Error("HNS route revalidation did not compose");
    const revalidation = makeHnsRouteRevalidationJob({
      sink,
      provider: hns.provider,
      configuration: hns.configuration,
      force: hns.force,
      environment: "staging",
    });
    const error = await Effect.runPromise(
      Effect.flip(buildJobRegistry([...declarations, revalidation])),
    );
    expect(error).toMatchObject({ reason: "duplicate-table-writer" });
  });
});
