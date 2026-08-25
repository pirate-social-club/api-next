import {
  HandleDirectGrantRecipientUnavailable as ApplicationRecipientUnavailable,
  HandleRecipientTokenVault,
  type HandleSalesFailure,
  HandleSalesPageRejected,
  HandleSalesStorageFailed,
  type HandleSalesStore,
  IdGen,
  makeHandleSalesService,
} from "@pirate/application/use-cases/handles/sales";
import {
  AuthError,
  BadRequest,
  DirectGrantRecipientUnavailable,
  HandleRequestRejected,
  InternalError,
  NotFound,
  RetryableHandleRequestRejected,
} from "@pirate/contracts";
import { Effect } from "effect";
import type { EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

export type HandleSalesHandlerServices = Readonly<{
  store: HandleSalesStore;
  ids: IdGen["Service"];
  tokenVault: HandleRecipientTokenVault["Service"];
}>;

const accountId = (principal: Principal | null): string => {
  if (principal === null || (principal.kind !== "user" && principal.kind !== "admin")) {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
};

const wireFailure = (failure: HandleSalesFailure) => {
  if (failure instanceof HandleSalesPageRejected) {
    return new BadRequest({ message: "Invalid handle page request" });
  }
  if (failure instanceof ApplicationRecipientUnavailable) {
    return new DirectGrantRecipientUnavailable({
      message: "Direct-grant recipient is unavailable",
    });
  }
  if (
    failure instanceof HandleSalesStorageFailed ||
    failure._tag === "HandleRecipientTokenCryptoFailed"
  ) {
    return new InternalError({ message: "Handle operation failed" });
  }
  const details = {
    reason: failure.reason,
    ...(failure.effectiveOfferingId === undefined
      ? {}
      : { effective_offering_id: failure.effectiveOfferingId }),
  };
  return failure.retryable
    ? new RetryableHandleRequestRejected({ message: "Handle request rejected", details })
    : new HandleRequestRejected({ message: "Handle request rejected", details });
};

const page = (query: unknown) => {
  const parsed = query as { readonly limit?: string; readonly cursor?: string };
  return {
    ...(parsed.limit === undefined ? {} : { limit: Number(parsed.limit) }),
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
  };
};

export function makeHandleSalesHandlers(
  services: HandleSalesHandlerServices,
): Readonly<Record<string, EndpointHandler>> {
  const sales = makeHandleSalesService(services.store);
  const run = <A, E>(effect: Effect.Effect<A, E, IdGen | HandleRecipientTokenVault>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(IdGen, services.ids),
        Effect.provideService(HandleRecipientTokenVault, services.tokenVault),
        Effect.mapError((error) => wireFailure(error as HandleSalesFailure)),
      ),
    );

  return {
    CreateHandleSaleNamespace: async (request) => {
      const path = request.params as { readonly communityId: string };
      const body = request.body as {
        readonly idempotency_key: string;
        readonly namespace_authority_reference: string;
        readonly expected_namespace_authority_generation: number;
        readonly dns_zone_activation_id: string;
        readonly expected_dns_zone_activation_generation: number;
        readonly dedicated_root_replacement_confirmed: true;
      };
      const result = await run(
        sales.createSaleNamespace({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          idempotencyKey: body.idempotency_key,
          namespaceAuthorityReference: body.namespace_authority_reference,
          expectedNamespaceAuthorityGeneration: body.expected_namespace_authority_generation,
          dnsZoneActivationId: body.dns_zone_activation_id,
          expectedDnsZoneActivationGeneration: body.expected_dns_zone_activation_generation,
          dedicatedRootReplacementConfirmed: body.dedicated_root_replacement_confirmed,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 201);
    },
    ReviseHandleSaleNamespace: async (request) => {
      const path = request.params as {
        readonly communityId: string;
        readonly activationId: string;
      };
      const body = request.body as {
        readonly idempotency_key: string;
        readonly expected_sale_namespace_activation_hash: string;
        readonly requested_status: "active" | "suspended" | "revoked";
        readonly namespace_authority_reference: string;
        readonly expected_namespace_authority_generation: number;
        readonly dns_zone_activation_id: string;
        readonly expected_dns_zone_activation_generation: number;
        readonly dedicated_root_replacement_confirmed: true;
      };
      const result = await run(
        sales.reviseSaleNamespace({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          activationId: path.activationId,
          idempotencyKey: body.idempotency_key,
          expectedActivationHash: body.expected_sale_namespace_activation_hash,
          requestedStatus: body.requested_status,
          namespaceAuthorityReference: body.namespace_authority_reference,
          expectedNamespaceAuthorityGeneration: body.expected_namespace_authority_generation,
          dnsZoneActivationId: body.dns_zone_activation_id,
          expectedDnsZoneActivationGeneration: body.expected_dns_zone_activation_generation,
          dedicatedRootReplacementConfirmed: body.dedicated_root_replacement_confirmed,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 201);
    },
    ListHandleSaleNamespaces: (request) => {
      const path = request.params as { readonly communityId: string };
      return run(
        sales.listSaleNamespaces({ communityId: path.communityId, ...page(request.query) }),
      );
    },
    CreateHandleDirectGrantRecipientToken: async (request) => {
      const path = request.params as { readonly communityId: string };
      const body = request.body as { readonly idempotency_key: string };
      const result = await run(
        sales.createRecipientToken({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          idempotencyKey: body.idempotency_key,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 201);
    },
    CreateHandleQualificationPolicy: async (request) => {
      const path = request.params as { readonly communityId: string };
      const body = request.body as {
        readonly idempotency_key: string;
        readonly requirement: {
          readonly kind: "account_allowlist_v1";
          readonly recipient_token: string;
        };
        readonly expected_account_directory_binding_version: string;
      };
      const result = await run(
        sales.createQualificationPolicy({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          idempotencyKey: body.idempotency_key,
          recipientToken: body.requirement.recipient_token,
          expectedAccountDirectoryBindingVersion: body.expected_account_directory_binding_version,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 201);
    },
    CreateCommunityHandleOffering: async (request) => {
      const path = request.params as { readonly communityId: string };
      const body = request.body as Parameters<typeof sales.createOffering>[0] extends infer _
        ? {
            readonly idempotency_key: string;
            readonly terms: Parameters<typeof sales.createOffering>[0]["terms"];
          }
        : never;
      const result = await run(
        sales.createOffering({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          idempotencyKey: body.idempotency_key,
          terms: body.terms,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 201);
    },
    ReviseCommunityHandleOffering: async (request) => {
      const path = request.params as { readonly communityId: string; readonly offeringId: string };
      const body = request.body as {
        readonly idempotency_key: string;
        readonly expected_offering_hash: string;
        readonly requested_status: "active" | "paused" | "retired";
        readonly terms: Parameters<typeof sales.reviseOffering>[0]["terms"];
      };
      const result = await run(
        sales.reviseOffering({
          accountId: accountId(request.principal),
          communityId: path.communityId,
          offeringId: path.offeringId,
          idempotencyKey: body.idempotency_key,
          expectedOfferingHash: body.expected_offering_hash,
          requestedStatus: body.requested_status,
          terms: body.terms,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 201);
    },
    ListCommunityHandleOfferings: (request) => {
      const path = request.params as { readonly communityId: string };
      return run(sales.listOfferings({ communityId: path.communityId, ...page(request.query) }));
    },
    ConfirmHandlePersonaReuse: async (request) => {
      const body = request.body as {
        readonly idempotency_key: string;
        readonly persona_id: string;
        readonly offering_id: string;
      };
      const result = await run(
        sales.confirmPersonaReuse({
          accountId: accountId(request.principal),
          personaId: body.persona_id,
          offeringId: body.offering_id,
          idempotencyKey: body.idempotency_key,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 201);
    },
    CreateHandleQuote: async (request) => {
      const body = request.body as {
        readonly idempotency_key: string;
        readonly persona_id: string;
        readonly offering_id: string;
        readonly desired_label: string;
      };
      const result = await run(
        sales.createQuote({
          accountId: accountId(request.principal),
          personaId: body.persona_id,
          offeringId: body.offering_id,
          desiredLabel: body.desired_label,
          idempotencyKey: body.idempotency_key,
        }),
      );
      const replayed = result.kind === "quoted" && result.replayed;
      return withEndpointResult(result, replayed ? 200 : 201);
    },
    CreateHandleReservation: async (request) => {
      const body = request.body as {
        readonly idempotency_key: string;
        readonly persona_id: string;
        readonly quote_id: string;
        readonly expected_quote_hash: string;
      };
      const result = await run(
        sales.createReservation({
          accountId: accountId(request.principal),
          personaId: body.persona_id,
          quoteId: body.quote_id,
          expectedQuoteHash: body.expected_quote_hash,
          idempotencyKey: body.idempotency_key,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 201);
    },
    SubmitFreeHandleClaim: async (request) => {
      const body = request.body as {
        readonly idempotency_key: string;
        readonly persona_id: string;
        readonly reservation_id: string;
        readonly expected_reservation_hash: string;
      };
      const result = await run(
        sales.submitFreeClaim({
          accountId: accountId(request.principal),
          personaId: body.persona_id,
          reservationId: body.reservation_id,
          expectedReservationHash: body.expected_reservation_hash,
          idempotencyKey: body.idempotency_key,
        }),
      );
      return withEndpointResult(result, result.replayed ? 200 : 201);
    },
    GetHandleClaim: async (request) => {
      const path = request.params as { readonly claimId: string };
      const claim = await run(
        sales.getClaim({ accountId: accountId(request.principal), claimId: path.claimId }),
      );
      if (claim === null) throw new NotFound({ message: "Handle claim not found" });
      return claim;
    },
    ListPersonaHandleGrants: (request) => {
      const path = request.params as { readonly personaId: string };
      return run(sales.listPersonaGrants({ personaId: path.personaId, ...page(request.query) }));
    },
    GetPublicHandleGrant: async (request) => {
      const path = request.params as {
        readonly family: "hns" | "spaces";
        readonly namespaceRoot: string;
        readonly handleLabel: string;
      };
      const grant = await run(
        sales.getPublicGrant({
          family: path.family,
          namespaceRoot: path.namespaceRoot,
          handleLabel: path.handleLabel,
        }),
      );
      if (grant === null) throw new NotFound({ message: "Handle grant not found" });
      return grant;
    },
  };
}
