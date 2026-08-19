import {
  admitCommunityPurchaseFunding,
  type CommunityPurchaseFundingAdmissionStore,
} from "@pirate/application/use-cases/community-purchase-funding-admission";
import type { CommunityPurchaseFundingObservationUseCase } from "@pirate/application/use-cases/community-purchase-funding-observation";
import {
  type CommunityPurchaseFundingQueryStore,
  getCommunityPurchaseFundingForActor,
} from "@pirate/application/use-cases/community-purchase-funding-query";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RetryableConflict,
} from "@pirate/contracts";
import type { Bytes32, CommunityPurchaseOperationId } from "@pirate/domain";
import { Effect } from "effect";
import type { EndpointHandler, Principal } from "./transport.ts";
import { withEndpointResult } from "./transport.ts";

export interface CommunityPurchaseFundingHandlerServices {
  readonly admission: CommunityPurchaseFundingAdmissionStore;
  readonly observation: CommunityPurchaseFundingObservationUseCase;
  readonly query: CommunityPurchaseFundingQueryStore;
}

type FundingHandlers = Readonly<{
  readonly BeginCommunityPurchaseFunding: EndpointHandler;
  readonly ObserveCommunityPurchaseFunding: EndpointHandler;
  readonly GetCommunityPurchaseFundingStatus: EndpointHandler;
}>;

type FundingObservationHandlers = Readonly<
  Pick<FundingHandlers, "ObserveCommunityPurchaseFunding" | "GetCommunityPurchaseFundingStatus">
>;

type FundingObservationHandlerServices = Omit<CommunityPurchaseFundingHandlerServices, "admission">;

function user(principal: Principal | null): { readonly actorId: string; readonly wallet: string } {
  if (principal === null || principal.kind !== "user") {
    throw new AuthError({ message: "Authentication required" });
  }
  if (principal.walletAddress === undefined) {
    throw new AuthError({ message: "Wallet-authenticated session required" });
  }
  return { actorId: principal.subject, wallet: principal.walletAddress };
}

function actor(principal: Principal | null): string {
  if (principal === null || principal.kind !== "user") {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
}

function wireFailure(error: unknown): Error {
  const tagged = error as { readonly _tag?: string; readonly reason?: string };
  if (tagged._tag === "CommunityPurchaseFundingAdmissionRejected") {
    if (tagged.reason === "plan-not-found")
      return new NotFound({ message: "Funding plan not found" });
    if (tagged.reason === "plan-expired" || tagged.reason === "plan-cancelled") {
      return new Conflict({ message: "Funding plan cannot be used" });
    }
    if (tagged.reason === "request-conflict" || tagged.reason === "operation-conflict") {
      return new Conflict({ message: "Funding request conflicts with its durable identity" });
    }
    if (tagged.reason === "actor-mismatch" || tagged.reason === "wallet-mismatch") {
      return new NotFound({ message: "Funding plan not found" });
    }
    return new BadRequest({ message: "Invalid funding request" });
  }
  if (tagged._tag === "CommunityPurchaseFundingQueryRejected") {
    return tagged.reason === "not-found"
      ? new NotFound({ message: "Funding operation not found" })
      : new BadRequest({ message: "Invalid funding operation" });
  }
  if (tagged._tag === "CommunityPurchaseFundingChainReadFailed") {
    return tagged.reason === "not-found"
      ? new NotFound({ message: "Funding transaction not found" })
      : new ProviderUnavailable({ message: "Funding chain observation is unavailable" });
  }
  if (tagged._tag === "CommunityPurchaseFundingRejected") {
    if (tagged.reason === "not-found")
      return new NotFound({ message: "Funding operation not found" });
    if (tagged.reason === "lease-busy" || tagged.reason === "lease-lost") {
      return new RetryableConflict({ message: "Funding observation is already in progress" });
    }
    if (tagged.reason === "version-conflict") {
      return new RetryableConflict({ message: "Funding operation advanced concurrently" });
    }
    if (tagged.reason === "invalid-input")
      return new BadRequest({ message: "Invalid funding observation" });
    return new Conflict({ message: "Funding observation conflicts with durable state" });
  }
  return new InternalError({ message: "Funding operation failed" });
}

function status(entry: {
  readonly status: string;
  readonly version: number;
  readonly state: { readonly operationId: string };
}) {
  return {
    operation_ref: entry.state.operationId,
    status: entry.status,
    version: entry.version,
  };
}

export function makeCommunityPurchaseFundingHandlers(
  services: CommunityPurchaseFundingHandlerServices,
): FundingHandlers {
  return {
    BeginCommunityPurchaseFunding: async (request) => {
      const session = user(request.principal);
      const body = request.body as { readonly quote_id: string; readonly client_nonce: string };
      const result = await Effect.runPromise(
        admitCommunityPurchaseFunding(
          {
            actorId: session.actorId,
            authenticatedWalletAddress: session.wallet,
            quoteId: body.quote_id,
            clientNonce: body.client_nonce,
          },
          services.admission,
        ).pipe(Effect.mapError(wireFailure)),
      );
      const expected = result.entry.state.expected;
      return withEndpointResult(
        {
          ...status(result.entry),
          replayed: result.replayed,
          funding: {
            chain_id: expected.chainId,
            token_contract: expected.tokenContract,
            token_decimals: expected.tokenDecimals,
            sender: expected.sender,
            recipient: expected.recipient,
            amount_atomic: expected.amountAtomic.toString(),
            required_confirmations: expected.requiredConfirmations,
          },
        },
        result.replayed ? 200 : 201,
      );
    },
    ...makeCommunityPurchaseFundingObservationHandlers(services),
  };
}

/**
 * Production composition may expose observation and status only. Admission
 * stays private until the target-owned commerce plan producer is ratified.
 */
export function makeCommunityPurchaseFundingObservationHandlers(
  services: FundingObservationHandlerServices,
): FundingObservationHandlers {
  return {
    ObserveCommunityPurchaseFunding: async (request) => {
      const actorId = actor(request.principal);
      const path = request.params as { readonly operationRef: string };
      const body = request.body as { readonly transaction_hash: string };
      await Effect.runPromise(
        getCommunityPurchaseFundingForActor(
          { operationId: path.operationRef, actorId },
          services.query,
        ).pipe(Effect.mapError(wireFailure)),
      );
      const result = await Effect.runPromise(
        services.observation
          .observe({
            operationId: path.operationRef as CommunityPurchaseOperationId,
            transactionHash: body.transaction_hash as Bytes32,
            ownerId: `http:${actorId}:${path.operationRef}:${body.transaction_hash}`,
            leaseMs: 30_000,
            source: "request",
          })
          .pipe(Effect.mapError(wireFailure)),
      );
      return { ...status(result.entry), replayed: result.replayed };
    },
    GetCommunityPurchaseFundingStatus: async (request) => {
      const actorId = actor(request.principal);
      const path = request.params as { readonly operationRef: string };
      const record = await Effect.runPromise(
        getCommunityPurchaseFundingForActor(
          { operationId: path.operationRef, actorId },
          services.query,
        ).pipe(Effect.mapError(wireFailure)),
      );
      return status(record.entry);
    },
  };
}
