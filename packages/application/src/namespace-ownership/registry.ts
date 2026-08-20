import type { CommunityRouteFamilyV1 } from "@pirate/contracts";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import {
  type NamespaceOwnershipProviderAdapter,
  NamespaceOwnershipProviderCompleteInput,
  NamespaceOwnershipProviderCompleteResult,
  type NamespaceOwnershipProviderFailure,
  NamespaceOwnershipProviderInvalidResponse,
  NamespaceOwnershipProviderManifest,
  NamespaceOwnershipProviderMisconfigured,
  type NamespaceOwnershipProviderOperation,
  NamespaceOwnershipProviderPlanInput,
  NamespaceOwnershipProviderPlanResult,
  NamespaceOwnershipProviderRejected,
  NamespaceOwnershipProviderStartInput,
  NamespaceOwnershipProviderStartResult,
  NamespaceOwnershipProviderUnavailable,
} from "./adapter.ts";

type Manifest = Schema.Schema.Type<typeof NamespaceOwnershipProviderManifest>;

export class NamespaceOwnershipProviderManifestInvalid extends Data.TaggedError(
  "NamespaceOwnershipProviderManifestInvalid",
)<{ readonly provider_id: string }> {}

export class NamespaceOwnershipProviderDuplicate extends Data.TaggedError(
  "NamespaceOwnershipProviderDuplicate",
)<{
  readonly family: CommunityRouteFamilyV1;
  readonly provider_id: string;
}> {}

export class NamespaceOwnershipProviderUnknown extends Data.TaggedError(
  "NamespaceOwnershipProviderUnknown",
)<{ readonly family: CommunityRouteFamilyV1 }> {}

export type NamespaceOwnershipProviderRegistryError =
  | NamespaceOwnershipProviderManifestInvalid
  | NamespaceOwnershipProviderDuplicate;

const exactParseOptions = { onExcessProperty: "error" } as const;

function providerHint(value: unknown): string {
  if (value !== null && typeof value === "object" && "provider_id" in value) {
    const providerId = (value as { readonly provider_id?: unknown }).provider_id;
    if (typeof providerId === "string" && providerId.length > 0) return providerId;
  }
  return "unknown";
}

function invalidResponse(
  provider_id: string,
  operation: NamespaceOwnershipProviderOperation,
): NamespaceOwnershipProviderInvalidResponse {
  return new NamespaceOwnershipProviderInvalidResponse({ provider_id, operation });
}

function rejected(
  provider_id: string,
  operation: NamespaceOwnershipProviderOperation,
): NamespaceOwnershipProviderRejected {
  return new NamespaceOwnershipProviderRejected({ provider_id, operation });
}

function unavailable(
  provider_id: string,
  operation: NamespaceOwnershipProviderOperation,
): NamespaceOwnershipProviderUnavailable {
  return new NamespaceOwnershipProviderUnavailable({ provider_id, operation });
}

function safeFailure(
  provider_id: string,
  operation: NamespaceOwnershipProviderOperation,
  error: NamespaceOwnershipProviderFailure,
): NamespaceOwnershipProviderFailure {
  if (
    (error instanceof NamespaceOwnershipProviderUnavailable ||
      error instanceof NamespaceOwnershipProviderRejected ||
      error instanceof NamespaceOwnershipProviderInvalidResponse ||
      error instanceof NamespaceOwnershipProviderMisconfigured) &&
    error.provider_id === provider_id &&
    error.operation === operation
  ) {
    return error;
  }
  return invalidResponse(provider_id, operation);
}

function sameConfiguration(
  left: Schema.Schema.Type<typeof NamespaceOwnershipProviderStartInput>["provider_configuration"],
  right: Schema.Schema.Type<typeof NamespaceOwnershipProviderStartInput>["provider_configuration"],
): boolean {
  return (
    left.kind === right.kind && left.reference === right.reference && left.version === right.version
  );
}

function sameRoute(
  left: Schema.Schema.Type<typeof NamespaceOwnershipProviderStartInput>["route"],
  right: Schema.Schema.Type<typeof NamespaceOwnershipProviderStartInput>["route"],
): boolean {
  return (
    left.family === right.family &&
    left.root_label === right.root_label &&
    left.root_label_display === right.root_label_display &&
    left.path_segment === right.path_segment &&
    left.href === right.href &&
    left.app_host === right.app_host
  );
}

function inputSupported(
  manifest: Manifest,
  input: { readonly route: { readonly family: string }; readonly environment: string },
): boolean {
  return (
    manifest.supported_families.includes(input.route.family as CommunityRouteFamilyV1) &&
    manifest.environments.includes(input.environment)
  );
}

function compatibleSession(
  manifest: Manifest,
  session: Schema.Schema.Type<typeof NamespaceOwnershipProviderStartResult>["session"],
  now: number,
): boolean {
  return (
    session.provider_id === manifest.provider_id &&
    inputSupported(manifest, session) &&
    manifest.protocol_versions.includes(session.protocol_version) &&
    Date.parse(session.expires_at) > now
  );
}

function immutableManifest(manifest: Manifest): Manifest {
  const supported_families = Object.freeze([
    ...manifest.supported_families,
  ]) as Manifest["supported_families"];
  const protocol_versions = Object.freeze([
    ...manifest.protocol_versions,
  ]) as Manifest["protocol_versions"];
  const environments = Object.freeze([...manifest.environments]) as Manifest["environments"];
  const submission_channels = Object.freeze([
    ...manifest.submission_channels,
  ]) as Manifest["submission_channels"];
  return Object.freeze({
    ...manifest,
    supported_families,
    protocol_versions,
    environments,
    submission_channels,
    operation_deadlines: Object.freeze({ ...manifest.operation_deadlines }),
  });
}

function guardAdapter(
  adapter: NamespaceOwnershipProviderAdapter,
  manifest: Manifest,
  now: () => number,
): NamespaceOwnershipProviderAdapter {
  return {
    manifest,
    plan: (untrustedInput) => {
      const input = Schema.decodeUnknownOption(
        NamespaceOwnershipProviderPlanInput,
        exactParseOptions,
      )(untrustedInput);
      if (Option.isNone(input) || !inputSupported(manifest, input.value)) {
        return Effect.fail(rejected(manifest.provider_id, "plan"));
      }
      return Effect.suspend(() => adapter.plan(input.value)).pipe(
        Effect.timeout(manifest.operation_deadlines.plan_ms),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(unavailable(manifest.provider_id, "plan")),
        ),
        Effect.mapError((error) => safeFailure(manifest.provider_id, "plan", error)),
        Effect.catchDefect(() => Effect.fail(invalidResponse(manifest.provider_id, "plan"))),
        Effect.flatMap((result) => {
          const decoded = Schema.decodeUnknownOption(
            NamespaceOwnershipProviderPlanResult,
            exactParseOptions,
          )(result);
          if (
            Option.isNone(decoded) ||
            (decoded.value.status === "supported" &&
              !manifest.protocol_versions.includes(decoded.value.protocol_version))
          ) {
            return Effect.fail(invalidResponse(manifest.provider_id, "plan"));
          }
          return Effect.succeed(decoded.value);
        }),
      );
    },
    start: (untrustedInput) => {
      const input = Schema.decodeUnknownOption(
        NamespaceOwnershipProviderStartInput,
        exactParseOptions,
      )(untrustedInput);
      if (
        Option.isNone(input) ||
        !inputSupported(manifest, input.value) ||
        !manifest.protocol_versions.includes(input.value.protocol_version)
      ) {
        return Effect.fail(rejected(manifest.provider_id, "start"));
      }
      return Effect.suspend(() => adapter.start(input.value)).pipe(
        Effect.timeout(manifest.operation_deadlines.start_ms),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(unavailable(manifest.provider_id, "start")),
        ),
        Effect.mapError((error) => safeFailure(manifest.provider_id, "start", error)),
        Effect.catchDefect(() => Effect.fail(invalidResponse(manifest.provider_id, "start"))),
        Effect.flatMap((result) => {
          const decoded = Schema.decodeUnknownOption(
            NamespaceOwnershipProviderStartResult,
            exactParseOptions,
          )(result);
          if (Option.isNone(decoded)) {
            return Effect.fail(invalidResponse(manifest.provider_id, "start"));
          }
          const session = decoded.value.session;
          if (
            session.actor_id !== input.value.actor_id ||
            session.creation_intent_id !== input.value.creation_intent_id ||
            session.ceremony_intent_id !== input.value.ceremony_intent_id ||
            session.requirement_hash !== input.value.requirement_hash ||
            session.generation !== input.value.generation ||
            session.request_hash !== input.value.request_hash ||
            session.provider_binding_hash !== input.value.provider_binding_hash ||
            session.protocol_version !== input.value.protocol_version ||
            session.environment !== input.value.environment ||
            !sameConfiguration(
              session.provider_configuration,
              input.value.provider_configuration,
            ) ||
            !sameRoute(session.route, input.value.route) ||
            !compatibleSession(manifest, session, now()) ||
            decoded.value.presentation.session_id !== session.upstream_session_ref
          ) {
            return Effect.fail(invalidResponse(manifest.provider_id, "start"));
          }
          return Effect.succeed(decoded.value);
        }),
      );
    },
    complete: (untrustedInput) => {
      const input = Schema.decodeUnknownOption(
        NamespaceOwnershipProviderCompleteInput,
        exactParseOptions,
      )(untrustedInput);
      if (
        Option.isNone(input) ||
        !compatibleSession(manifest, input.value.session, now()) ||
        !manifest.submission_channels.includes(input.value.submission.channel)
      ) {
        return Effect.fail(rejected(manifest.provider_id, "complete"));
      }
      return Effect.suspend(() => adapter.complete(input.value)).pipe(
        Effect.timeout(manifest.operation_deadlines.complete_ms),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(unavailable(manifest.provider_id, "complete")),
        ),
        Effect.mapError((error) => safeFailure(manifest.provider_id, "complete", error)),
        Effect.catchDefect(() => Effect.fail(invalidResponse(manifest.provider_id, "complete"))),
        Effect.flatMap((result) => {
          const currentTime = now();
          const decoded = Schema.decodeUnknownOption(
            NamespaceOwnershipProviderCompleteResult,
            exactParseOptions,
          )(result);
          if (
            Option.isNone(decoded) ||
            (decoded.value.status === "verified" &&
              (Date.parse(decoded.value.verified_at) > currentTime ||
                (decoded.value.expires_at !== null &&
                  Date.parse(decoded.value.expires_at) <= currentTime)))
          ) {
            return Effect.fail(invalidResponse(manifest.provider_id, "complete"));
          }
          return Effect.succeed(decoded.value);
        }),
      );
    },
  };
}

export interface NamespaceOwnershipProviderRegistryService {
  readonly list: () => readonly Manifest[];
  readonly resolve: (
    family: CommunityRouteFamilyV1,
  ) => Effect.Effect<NamespaceOwnershipProviderAdapter, NamespaceOwnershipProviderUnknown>;
}

export class NamespaceOwnershipProviderRegistry extends Context.Service<
  NamespaceOwnershipProviderRegistry,
  NamespaceOwnershipProviderRegistryService
>()("@pirate/application/namespace-ownership/NamespaceOwnershipProviderRegistry") {}

export type NamespaceOwnershipProviderRegistryOptions = Readonly<{
  readonly now?: () => number;
}>;

export function makeNamespaceOwnershipProviderRegistry(
  adapters: readonly NamespaceOwnershipProviderAdapter[],
  options: NamespaceOwnershipProviderRegistryOptions = {},
): Effect.Effect<
  NamespaceOwnershipProviderRegistryService,
  NamespaceOwnershipProviderRegistryError
> {
  return Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const providers = new Set<string>();
    const manifests: Manifest[] = [];
    const byFamily = new Map<CommunityRouteFamilyV1, NamespaceOwnershipProviderAdapter>();

    for (const adapter of adapters) {
      const decoded = Schema.decodeUnknownOption(
        NamespaceOwnershipProviderManifest,
        exactParseOptions,
      )(adapter.manifest);
      if (Option.isNone(decoded)) {
        return yield* new NamespaceOwnershipProviderManifestInvalid({
          provider_id: providerHint(adapter.manifest),
        });
      }
      const manifest = immutableManifest(decoded.value);
      if (providers.has(manifest.provider_id)) {
        return yield* new NamespaceOwnershipProviderDuplicate({
          family: manifest.supported_families[0],
          provider_id: manifest.provider_id,
        });
      }
      for (const family of manifest.supported_families) {
        if (byFamily.has(family)) {
          return yield* new NamespaceOwnershipProviderDuplicate({
            family,
            provider_id: manifest.provider_id,
          });
        }
      }
      providers.add(manifest.provider_id);
      manifests.push(manifest);
      const guarded = guardAdapter(adapter, manifest, now);
      for (const family of manifest.supported_families) byFamily.set(family, guarded);
    }

    const manifestList = Object.freeze([...manifests]);
    return {
      list: () => manifestList,
      resolve: (family) => {
        const adapter = byFamily.get(family);
        return adapter === undefined
          ? Effect.fail(new NamespaceOwnershipProviderUnknown({ family }))
          : Effect.succeed(adapter);
      },
    } satisfies NamespaceOwnershipProviderRegistryService;
  });
}

export function makeNamespaceOwnershipProviderRegistryLayer(
  adapters: readonly NamespaceOwnershipProviderAdapter[],
  options: NamespaceOwnershipProviderRegistryOptions = {},
): Layer.Layer<NamespaceOwnershipProviderRegistry, NamespaceOwnershipProviderRegistryError> {
  return Layer.effect(
    NamespaceOwnershipProviderRegistry,
    makeNamespaceOwnershipProviderRegistry(adapters, options),
  );
}
