import { decodeStrictHnsJsonBytes } from "@pirate/application/namespace-ownership";
import {
  type HnsRouteRevalidationCompletionProvider,
  type HnsRouteRevalidationCompletionProviderResult,
  HnsRouteRevalidationProviderResponse,
} from "@pirate/application/route-revalidation/completion";
import {
  HnsRouteRevalidationProviderFailed,
  HnsRouteRevalidationProviderStartResult,
  type HnsRouteRevalidationProviderStartResult as HnsRouteRevalidationProviderStartResultType,
  type HnsRouteRevalidationStartProvider,
} from "@pirate/application/route-revalidation/start";
import { Effect, Option, Schema } from "effect";
import type { HnsOwnerTransportFailure } from "./namespace-ownership/hns-owner.ts";
import type { HnsOwnerRouteRevalidationTransport } from "./namespace-ownership/hns-owner-service-binding.ts";

const exactParseOptions = { onExcessProperty: "error" } as const;

function mapFailure(error: HnsOwnerTransportFailure): HnsRouteRevalidationProviderFailed {
  if (error._tag === "NamespaceOwnershipProviderUnavailable") {
    return new HnsRouteRevalidationProviderFailed({ reason: "unavailable" });
  }
  if (error._tag === "NamespaceOwnershipProviderRejected") {
    return new HnsRouteRevalidationProviderFailed({ reason: "rejected" });
  }
  return new HnsRouteRevalidationProviderFailed({
    reason:
      error._tag === "NamespaceOwnershipProviderUnboundRejected"
        ? "misconfigured"
        : "invalid_response",
  });
}

/**
 * Guarded route-revalidation provider. It shares only the injected service
 * binding transport with creation ownership; its wire has no creation ids.
 */
export function makeHnsRouteRevalidationProvider(
  options: Readonly<{
    readonly transport: HnsOwnerRouteRevalidationTransport;
  }>,
): HnsRouteRevalidationStartProvider & HnsRouteRevalidationCompletionProvider {
  const start: HnsRouteRevalidationStartProvider["start"] = (wire) =>
    options.transport.start({ wire, revalidation_session_id: wire.revalidation_session_id }).pipe(
      Effect.mapError(mapFailure),
      Effect.catchDefect(() =>
        Effect.fail(new HnsRouteRevalidationProviderFailed({ reason: "invalid_response" })),
      ),
      Effect.flatMap((bytes) => {
        let decoded: unknown;
        try {
          decoded = decodeStrictHnsJsonBytes(bytes, 65_536);
        } catch {
          return Effect.fail(
            new HnsRouteRevalidationProviderFailed({ reason: "invalid_response" }),
          );
        }
        const result = Schema.decodeUnknownOption(
          HnsRouteRevalidationProviderStartResult,
          exactParseOptions,
        )(decoded);
        if (Option.isNone(result)) {
          return Effect.fail(
            new HnsRouteRevalidationProviderFailed({ reason: "invalid_response" }),
          );
        }
        const value: HnsRouteRevalidationProviderStartResultType = result.value;
        if (
          value.presentation.session_id !== value.upstream_session_ref ||
          value.presentation.payload.expires_at !== value.expires_at ||
          value.presentation.protocol !== "hns-txt-challenge" ||
          value.presentation.kind !== "embedded_sdk"
        ) {
          return Effect.fail(
            new HnsRouteRevalidationProviderFailed({ reason: "invalid_response" }),
          );
        }
        return Effect.succeed(value);
      }),
    );

  const complete: HnsRouteRevalidationCompletionProvider["complete"] = ({ session }) =>
    options.transport
      .complete({
        session,
        revalidation_session_id: session.revalidation_session_id,
      })
      .pipe(
        Effect.mapError(mapFailure),
        Effect.catchDefect(() =>
          Effect.fail(new HnsRouteRevalidationProviderFailed({ reason: "invalid_response" })),
        ),
        Effect.flatMap(
          (
            bytes,
          ): Effect.Effect<
            HnsRouteRevalidationCompletionProviderResult,
            HnsRouteRevalidationProviderFailed
          > => {
            let decoded: unknown;
            try {
              decoded = decodeStrictHnsJsonBytes(bytes, 1_048_576);
            } catch {
              return Effect.fail(
                new HnsRouteRevalidationProviderFailed({ reason: "invalid_response" }),
              );
            }
            const result = Schema.decodeUnknownOption(
              HnsRouteRevalidationProviderResponse,
              exactParseOptions,
            )(decoded);
            if (Option.isNone(result)) {
              return Effect.fail(
                new HnsRouteRevalidationProviderFailed({ reason: "invalid_response" }),
              );
            }
            if (result.value.status === "pending")
              return Effect.succeed({ status: "pending" as const });
            if (result.value.status === "rejected") {
              return Effect.succeed({
                status: "rejected" as const,
                reason_code: result.value.reason_code,
              });
            }
            const expectedChallengeName =
              result.value.observation.ownership_source === "hns_parent_chain_txt"
                ? session.authority.root_label
                : `_pirate.${session.authority.root_label}`;
            if (
              result.value.observation.challenge_name !== expectedChallengeName ||
              result.value.observation.challenge_value !==
                `pirate-verification=${session.upstream_session_ref}`
            ) {
              return Effect.fail(
                new HnsRouteRevalidationProviderFailed({ reason: "observation_rejected" }),
              );
            }
            return Effect.succeed({
              status: "verified" as const,
              observation: result.value.observation,
              raw_response_bytes: new Uint8Array(bytes),
            });
          },
        ),
      );

  return { start, complete };
}
