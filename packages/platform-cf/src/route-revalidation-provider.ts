import { decodeStrictHnsJsonBytes } from "@pirate/application/namespace-ownership";
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
): HnsRouteRevalidationStartProvider {
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

  return { start };
}
