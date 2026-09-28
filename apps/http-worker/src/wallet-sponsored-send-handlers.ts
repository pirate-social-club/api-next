import { AuthError, BadRequest, Conflict, NotFound, ProviderUnavailable } from "@pirate/contracts";
import { SponsoredSendRefused } from "@pirate/platform-cf/wallet-sponsored-send-repository";
import {
  type makeWalletSponsoredSendService,
  SponsoredSendUnavailable,
  type SponsoredSendView,
} from "@pirate/platform-cf/wallet-sponsored-send-service";
import type { EndpointHandler, Principal } from "./transport.ts";

type Service = ReturnType<typeof makeWalletSponsoredSendService>;

function accountId(principal: Principal | null): string {
  if (principal === null || principal.kind !== "user") {
    throw new AuthError({ message: "Authentication required" });
  }
  return principal.subject;
}

function failure(error: unknown): Error {
  if (error instanceof SponsoredSendRefused) {
    if (error.reason === "not-found") return new NotFound({ message: "Send unavailable" });
    if (error.reason === "limit") return new Conflict({ message: "Sponsorship limit reached" });
    if (error.reason === "ineligible") return new BadRequest({ message: "Send unavailable" });
    return new Conflict({ message: "Send cannot be repeated" });
  }
  if (error instanceof SponsoredSendUnavailable) {
    return new ProviderUnavailable({ message: "Wallet sponsorship is unavailable" });
  }
  return new ProviderUnavailable({ message: "Sponsored send outcome is pending" });
}

function response(view: SponsoredSendView) {
  return {
    object: "wallet_sponsored_send" as const,
    send_id: view.record.sendId,
    persona_id: view.record.personaId,
    status: view.record.status,
    chain_id: view.record.chainId,
    token_address: view.record.tokenAddress,
    sender_address: view.record.senderAddress,
    recipient_address: view.record.recipientAddress,
    amount_atomic: view.record.amountAtomic.toString(),
    transaction_hash: view.record.transactionHash,
    authorization:
      view.authorization === null
        ? null
        : {
            wallet_id: view.authorization.walletId,
            payload_base64: view.authorization.payloadBase64,
          },
  };
}

export type WalletSponsoredSendHandlers = Readonly<{
  CreateWalletSponsoredSend: EndpointHandler;
  SubmitWalletSponsoredSend: EndpointHandler;
  GetWalletSponsoredSend: EndpointHandler;
  GetWalletSponsoredSendForPersona: EndpointHandler;
}>;

export function makeWalletSponsoredSendHandlers(
  service: Service | null,
): WalletSponsoredSendHandlers {
  const requireService = () => {
    if (service === null)
      throw new ProviderUnavailable({ message: "Wallet sponsorship is unavailable" });
    return service;
  };
  return {
    CreateWalletSponsoredSend: async (request) => {
      const account = accountId(request.principal);
      const path = request.params as { readonly personaId: string };
      const body = request.body as {
        readonly chain_id: 8453 | 84532;
        readonly recipient: string;
        readonly amount_atomic: string;
        readonly idempotency_key: string;
      };
      try {
        return response(
          await requireService().reserve({
            accountId: account,
            personaId: path.personaId,
            chainId: body.chain_id,
            recipientAddress: body.recipient,
            amountAtomic: BigInt(body.amount_atomic),
            idempotencyKey: body.idempotency_key,
          }),
        );
      } catch (error) {
        throw failure(error);
      }
    },
    SubmitWalletSponsoredSend: async (request) => {
      const account = accountId(request.principal);
      const path = request.params as { readonly sendId: string };
      const body = request.body as { readonly authorization_signature: string };
      try {
        return response(
          await requireService().submit({
            accountId: account,
            sendId: path.sendId,
            signature: body.authorization_signature,
          }),
        );
      } catch (error) {
        throw failure(error);
      }
    },
    GetWalletSponsoredSend: async (request) => {
      const account = accountId(request.principal);
      const path = request.params as { readonly sendId: string };
      try {
        return response(await requireService().get({ accountId: account, sendId: path.sendId }));
      } catch (error) {
        throw failure(error);
      }
    },
    GetWalletSponsoredSendForPersona: async (request) => {
      const account = accountId(request.principal);
      const path = request.params as { readonly personaId: string };
      try {
        return response(
          await requireService().getForPersona({ accountId: account, personaId: path.personaId }),
        );
      } catch (error) {
        throw failure(error);
      }
    },
  };
}
