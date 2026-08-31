import {
  decodeHnsOwnerResponseBytes,
  decodeHnsOwnerTargetObservationV3Bytes,
  decodeStrictHnsJsonBytes,
  HNS_OWNER_MANIFEST_VERSION,
  HNS_OWNER_PROTOCOL_VERSION,
  HNS_OWNER_PROVIDER_ID,
  type HnsOwnerRawResponse,
  hnsOwnerChallengeName,
  hnsOwnerChallengeValue,
  type NamespaceOwnershipProviderAdapter,
  type NamespaceOwnershipProviderCompleteContext,
  type NamespaceOwnershipProviderCompleteInput,
  type NamespaceOwnershipProviderCompleteResult,
  NamespaceOwnershipProviderInvalidResponse,
  NamespaceOwnershipProviderManifest,
  NamespaceOwnershipProviderObservationRejected,
  type NamespaceOwnershipProviderPlanInput,
  type NamespaceOwnershipProviderPlanResult,
  NamespaceOwnershipProviderRejected,
  type NamespaceOwnershipProviderStartContext,
  type NamespaceOwnershipProviderStartInput,
  type NamespaceOwnershipProviderStartResult,
  NamespaceOwnershipProviderUnavailable,
  NamespaceOwnershipProviderUnboundRejected,
  type NamespaceOwnershipSession,
  NamespaceOwnershipUpstreamSessionReference,
} from "@pirate/application";
import { HnsTxtChallengeV1 } from "@pirate/contracts";
import { ProviderConfigurationRef } from "@pirate/domain/verification";
import { Effect, Option, Schema } from "effect";

const exactParseOptions = { onExcessProperty: "error" } as const;

export type HnsOwnerTransport = Readonly<{
  readonly start: (
    input: Readonly<{
      readonly input: NamespaceOwnershipProviderStartInput;
      readonly context: NamespaceOwnershipProviderStartContext;
    }>,
  ) => Effect.Effect<HnsOwnerTransportStartResult, HnsOwnerTransportFailure>;
  readonly poll: (
    input: Readonly<{
      readonly session: NamespaceOwnershipSession;
      readonly payload: unknown;
      readonly context: NamespaceOwnershipProviderCompleteContext;
    }>,
  ) => Effect.Effect<Uint8Array, HnsOwnerTransportFailure>;
}>;

export type HnsOwnerTransportStartResult = Uint8Array;

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
  /** Version-closed target response selected by the owning composition. */
  readonly target_observation_contract?: "v2" | "v3";
}>;

const HnsStartPresentation = Schema.Struct({
  kind: Schema.Literal("embedded_sdk"),
  session_id: NamespaceOwnershipUpstreamSessionReference,
  protocol: Schema.Literal("hns-txt-challenge"),
  version: Schema.Literal("1"),
  payload: HnsTxtChallengeV1,
});

const HnsTransportStart = Schema.Struct({
  upstream_session_ref: NamespaceOwnershipUpstreamSessionReference,
  expires_at: Schema.String,
  presentation: HnsStartPresentation,
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

function targetV3Result(
  bytes: Uint8Array,
  input: NamespaceOwnershipProviderCompleteInput,
  now: number,
): Effect.Effect<
  NamespaceOwnershipProviderCompleteResult,
  NamespaceOwnershipProviderInvalidResponse | NamespaceOwnershipProviderObservationRejected
> {
  return Effect.tryPromise({
    try: () => decodeHnsOwnerTargetObservationV3Bytes(bytes),
    catch: () => invalid("complete"),
  }).pipe(
    Effect.flatMap(
      (
        decoded,
      ): Effect.Effect<
        NamespaceOwnershipProviderCompleteResult,
        NamespaceOwnershipProviderObservationRejected
      > => {
        const result = decoded.response;
        const common = {
          observation_contract_version: result.observation_contract_version,
          raw_response_bytes: decoded.response_bytes,
          provider_response_sha256: decoded.response_sha256,
          observation: result,
        } as const;
        if (result.status === "pending") {
          return Effect.succeed({ status: "pending" as const, ...common });
        }
        if (result.status === "rejected") {
          return Effect.succeed({ status: "rejected" as const, ...common });
        }
        if (result.status === "unavailable") {
          return Effect.succeed({
            status: "unavailable" as const,
            ...common,
            retry_after_seconds: result.retry_after_seconds,
          });
        }
        if (result.status === "ineligible") {
          return result.root_label === input.session.route.root_label
            ? Effect.succeed({ status: "ineligible" as const, ...common })
            : Effect.fail(observationRejected());
        }
        if (
          result.upstream_session_ref !== input.session.upstream_session_ref ||
          result.challenge_name !==
            hnsOwnerChallengeName(result.ownership_source, input.session.route.root_label) ||
          result.challenge_value !== hnsOwnerChallengeValue(input.session.upstream_session_ref) ||
          !isCanonicalInstant(result.observed_at) ||
          !isCanonicalInstant(result.expires_at) ||
          Date.parse(result.observed_at) > now ||
          Date.parse(result.expires_at) <= now ||
          Date.parse(result.expires_at) <= Date.parse(result.observed_at)
        ) {
          return Effect.fail(observationRejected());
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
      context: NamespaceOwnershipProviderStartContext,
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
      return options.transport.start({ input, context }).pipe(
        Effect.mapError((error) =>
          error instanceof NamespaceOwnershipProviderUnavailable ||
          error instanceof NamespaceOwnershipProviderRejected ||
          error instanceof NamespaceOwnershipProviderUnboundRejected ||
          error instanceof NamespaceOwnershipProviderInvalidResponse
            ? error
            : invalid("start"),
        ),
        Effect.flatMap((untrusted) => {
          let document: unknown;
          try {
            document = decodeStrictHnsJsonBytes(untrusted, 65_536);
          } catch {
            return Effect.fail(invalid("start"));
          }
          const decoded = Schema.decodeUnknownOption(
            HnsTransportStart,
            exactParseOptions,
          )(document);
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
          const presentation = decoded.value.presentation;
          if (
            presentation.session_id !== decoded.value.upstream_session_ref ||
            presentation.payload.expires_at !== decoded.value.expires_at ||
            presentation.payload.challenge_name !==
              hnsOwnerChallengeName(
                presentation.payload.ownership_source,
                input.route.root_label,
              ) ||
            presentation.payload.challenge_value !==
              hnsOwnerChallengeValue(decoded.value.upstream_session_ref)
          ) {
            return Effect.fail(invalid("start"));
          }
          return Effect.succeed({ session, presentation });
        }),
      );
    },
    complete: (
      input: NamespaceOwnershipProviderCompleteInput,
      context: NamespaceOwnershipProviderCompleteContext,
    ): Effect.Effect<NamespaceOwnershipProviderCompleteResult, HnsOwnerTransportFailure> => {
      if (
        input.submission.channel !== "poll_result" ||
        typeof input.submission.payload !== "object" ||
        input.submission.payload === null ||
        Array.isArray(input.submission.payload) ||
        Object.keys(input.submission.payload).length !== 0 ||
        !sessionMatchesConfiguration(input.session, provider_configuration, environments) ||
        Date.parse(input.session.expires_at) <= now()
      ) {
        return Effect.fail(unboundRejected("complete"));
      }
      return options.transport
        .poll({ session: input.session, payload: input.submission.payload, context })
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
              if (options.target_observation_contract === "v3") {
                return targetV3Result(bytes, input, now());
              }
              let decoded: HnsOwnerRawResponse;
              try {
                decoded = decodeHnsOwnerResponseBytes(bytes);
              } catch {
                return Effect.fail(invalid("complete"));
              }
              if (
                options.target_observation_contract === "v2" &&
                !("observation_contract_version" in decoded.response)
              ) {
                return Effect.fail(invalid("complete"));
              }
              if (decoded.response.status === "pending") {
                return Effect.succeed({ status: "pending" as const });
              }
              const result = decoded.response;
              if (
                result.upstream_session_ref !== input.session.upstream_session_ref ||
                result.challenge_name !==
                  hnsOwnerChallengeName(result.ownership_source, input.session.route.root_label) ||
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
