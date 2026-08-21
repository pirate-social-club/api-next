import {
  decodeHnsOwnerResponseBytes,
  HNS_OWNER_MANIFEST_VERSION,
  HNS_OWNER_PROTOCOL_VERSION,
  HNS_OWNER_PROVIDER_ID,
  type HnsOwnerRawResponse,
  hnsOwnerChallengeValue,
  type NamespaceOwnershipProviderAdapter,
  type NamespaceOwnershipProviderCompleteInput,
  type NamespaceOwnershipProviderCompleteResult,
  NamespaceOwnershipProviderInvalidResponse,
  NamespaceOwnershipProviderManifest,
  NamespaceOwnershipProviderObservationRejected,
  type NamespaceOwnershipProviderPlanInput,
  type NamespaceOwnershipProviderPlanResult,
  NamespaceOwnershipProviderRejected,
  type NamespaceOwnershipProviderStartInput,
  type NamespaceOwnershipProviderStartResult,
  NamespaceOwnershipProviderUnavailable,
  NamespaceOwnershipProviderUnboundRejected,
  type NamespaceOwnershipSession,
  NamespaceOwnershipUpstreamSessionReference,
} from "@pirate/application";
import { ProviderPresentation } from "@pirate/contracts";
import { ProviderConfigurationRef } from "@pirate/domain/verification";
import { Effect, Option, Schema } from "effect";

const exactParseOptions = { onExcessProperty: "error" } as const;

export type HnsOwnerTransport = Readonly<{
  readonly start: (
    input: NamespaceOwnershipProviderStartInput,
  ) => Effect.Effect<HnsOwnerTransportStartResult, HnsOwnerTransportFailure>;
  readonly poll: (
    input: Readonly<{
      readonly session: NamespaceOwnershipSession;
      readonly payload: unknown;
    }>,
  ) => Effect.Effect<Uint8Array, HnsOwnerTransportFailure>;
}>;

export type HnsOwnerTransportStartResult = Readonly<{
  readonly upstream_session_ref: string;
  readonly expires_at: string;
  readonly presentation: unknown;
}>;

export type HnsOwnerTransportFailure =
  | NamespaceOwnershipProviderUnavailable
  | NamespaceOwnershipProviderRejected
  | NamespaceOwnershipProviderUnboundRejected
  | NamespaceOwnershipProviderObservationRejected
  | NamespaceOwnershipProviderInvalidResponse;

export type HnsOwnerAdapterOptions = Readonly<{
  readonly transport: HnsOwnerTransport;
  readonly provider_configuration: ProviderConfigurationRef;
  readonly environments: readonly string[];
  readonly operation_deadlines?: Readonly<{
    readonly plan_ms: number;
    readonly start_ms: number;
    readonly complete_ms: number;
  }>;
  readonly now?: () => number;
}>;

const HnsTransportStart = Schema.Struct({
  upstream_session_ref: NamespaceOwnershipUpstreamSessionReference,
  expires_at: Schema.String,
  presentation: Schema.Unknown,
});

function invalid(operation: "plan" | "start" | "complete") {
  return new NamespaceOwnershipProviderInvalidResponse({
    provider_id: HNS_OWNER_PROVIDER_ID,
    operation,
  });
}

function observationRejected() {
  return new NamespaceOwnershipProviderObservationRejected({
    provider_id: HNS_OWNER_PROVIDER_ID,
    operation: "complete",
  });
}

function unboundRejected(operation: "plan" | "start" | "complete") {
  return new NamespaceOwnershipProviderUnboundRejected({
    provider_id: HNS_OWNER_PROVIDER_ID,
    operation,
  });
}

function sameConfiguration(left: ProviderConfigurationRef, right: ProviderConfigurationRef) {
  return (
    left.kind === right.kind && left.reference === right.reference && left.version === right.version
  );
}

function isCanonicalInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sessionMatchesConfiguration(
  session: NamespaceOwnershipSession,
  provider_configuration: ProviderConfigurationRef,
  environments: readonly string[],
): boolean {
  return (
    session.provider_id === HNS_OWNER_PROVIDER_ID &&
    session.route.family === "hns" &&
    session.route.app_host === null &&
    sameConfiguration(session.provider_configuration, provider_configuration) &&
    session.protocol_version === HNS_OWNER_PROTOCOL_VERSION &&
    environments.includes(session.environment)
  );
}

/**
 * Target-owned HNS adapter. It has no fetch fallback: all network behavior is
 * supplied by the injected, server-authenticated transport.
 */
export function makeHnsOwnerAdapter(
  options: HnsOwnerAdapterOptions,
): NamespaceOwnershipProviderAdapter {
  const now = options.now ?? Date.now;
  const provider_configuration = Object.freeze(
    Schema.decodeUnknownSync(
      ProviderConfigurationRef,
      exactParseOptions,
    )(options.provider_configuration),
  );
  const environments = Object.freeze([...options.environments]);
  const operation_deadlines = options.operation_deadlines ?? {
    plan_ms: 1_000,
    start_ms: 5_000,
    complete_ms: 15_000,
  };
  const manifest = Schema.decodeUnknownSync(
    NamespaceOwnershipProviderManifest,
    exactParseOptions,
  )({
    provider_id: HNS_OWNER_PROVIDER_ID,
    manifest_version: HNS_OWNER_MANIFEST_VERSION,
    supported_families: ["hns"],
    protocol_versions: [HNS_OWNER_PROTOCOL_VERSION],
    environments: [...environments],
    submission_channels: ["poll_result"],
    operation_deadlines,
  });

  return {
    manifest,
    plan: (
      input: NamespaceOwnershipProviderPlanInput,
    ): Effect.Effect<NamespaceOwnershipProviderPlanResult, HnsOwnerTransportFailure> => {
      if (input.route.family !== "hns" || input.route.app_host !== null) {
        return Effect.fail(unboundRejected("plan"));
      }
      if (!environments.includes(input.environment)) {
        return Effect.succeed({ status: "unsupported" });
      }
      return Effect.succeed({
        status: "supported",
        provider_configuration,
        protocol_version: HNS_OWNER_PROTOCOL_VERSION,
      });
    },
    start: (
      input: NamespaceOwnershipProviderStartInput,
    ): Effect.Effect<NamespaceOwnershipProviderStartResult, HnsOwnerTransportFailure> => {
      if (
        input.route.family !== "hns" ||
        input.route.app_host !== null ||
        !environments.includes(input.environment) ||
        input.protocol_version !== HNS_OWNER_PROTOCOL_VERSION ||
        !sameConfiguration(input.provider_configuration, provider_configuration)
      ) {
        return Effect.fail(unboundRejected("start"));
      }
      return options.transport.start(input).pipe(
        Effect.mapError((error) =>
          error instanceof NamespaceOwnershipProviderUnavailable ||
          error instanceof NamespaceOwnershipProviderRejected ||
          error instanceof NamespaceOwnershipProviderUnboundRejected ||
          error instanceof NamespaceOwnershipProviderInvalidResponse
            ? error
            : invalid("start"),
        ),
        Effect.flatMap((untrusted) => {
          const decoded = Schema.decodeUnknownOption(
            HnsTransportStart,
            exactParseOptions,
          )(untrusted);
          if (Option.isNone(decoded)) return Effect.fail(invalid("start"));
          if (
            !isCanonicalInstant(decoded.value.expires_at) ||
            Date.parse(decoded.value.expires_at) <= now()
          ) {
            return Effect.fail(invalid("start"));
          }
          const session: NamespaceOwnershipSession = {
            ...input,
            provider_id: HNS_OWNER_PROVIDER_ID,
            upstream_session_ref: decoded.value.upstream_session_ref,
            expires_at: decoded.value.expires_at,
          };
          const presentation = Schema.decodeUnknownOption(
            ProviderPresentation,
            exactParseOptions,
          )(decoded.value.presentation);
          if (Option.isNone(presentation)) return Effect.fail(invalid("start"));
          if (presentation.value.session_id !== decoded.value.upstream_session_ref) {
            return Effect.fail(invalid("start"));
          }
          return Effect.succeed({ session, presentation: presentation.value });
        }),
      );
    },
    complete: (
      input: NamespaceOwnershipProviderCompleteInput,
    ): Effect.Effect<NamespaceOwnershipProviderCompleteResult, HnsOwnerTransportFailure> => {
      if (
        input.submission.channel !== "poll_result" ||
        !sessionMatchesConfiguration(input.session, provider_configuration, environments) ||
        Date.parse(input.session.expires_at) <= now()
      ) {
        return Effect.fail(unboundRejected("complete"));
      }
      return options.transport
        .poll({ session: input.session, payload: input.submission.payload })
        .pipe(
          Effect.mapError((error) =>
            error instanceof NamespaceOwnershipProviderUnavailable ||
            error instanceof NamespaceOwnershipProviderRejected ||
            error instanceof NamespaceOwnershipProviderUnboundRejected ||
            error instanceof NamespaceOwnershipProviderObservationRejected ||
            error instanceof NamespaceOwnershipProviderInvalidResponse
              ? error
              : invalid("complete"),
          ),
          Effect.flatMap(
            (
              bytes,
            ): Effect.Effect<
              NamespaceOwnershipProviderCompleteResult,
              | NamespaceOwnershipProviderInvalidResponse
              | NamespaceOwnershipProviderObservationRejected
            > => {
              let decoded: HnsOwnerRawResponse;
              try {
                decoded = decodeHnsOwnerResponseBytes(bytes);
              } catch {
                return Effect.fail(invalid("complete"));
              }
              if (decoded.response.status === "pending") return Effect.succeed(decoded.response);
              const result = decoded.response;
              if (
                result.upstream_session_ref !== input.session.upstream_session_ref ||
                result.challenge_name !== `_pirate.${input.session.route.root_label}` ||
                result.challenge_value !==
                  hnsOwnerChallengeValue(input.session.upstream_session_ref) ||
                result.root_exists !== true ||
                result.root_control_verified !== true ||
                result.expiry_horizon_sufficient !== true
              ) {
                return Effect.fail(observationRejected());
              }
              if (
                !isCanonicalInstant(result.observed_at) ||
                !isCanonicalInstant(result.expires_at) ||
                Date.parse(result.observed_at) > now() ||
                Date.parse(result.expires_at) <= now() ||
                Date.parse(result.expires_at) <= Date.parse(result.observed_at)
              ) {
                return Effect.fail(invalid("complete"));
              }
              return Effect.succeed({
                status: "verified" as const,
                evidence_kind: "raw_provider_response_v1" as const,
                provider_evidence_ref: result.provider_evidence_ref,
                raw_response_bytes: decoded.response_bytes,
                observation: result,
                observed_at: result.observed_at,
                expires_at: result.expires_at,
              });
            },
          ),
        );
    },
  };
}
