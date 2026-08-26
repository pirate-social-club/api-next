import type {
  CommunityHandleOfferingV2,
  HandleClaimV2,
  HandleCuratedQualificationPolicyRefV1,
  HandleGrantPrivateV2,
  HandleOfferingTermsCommandV2,
  HandleQuoteV2,
  HandleReservationV2,
  HandleSafeReasonV2,
  PublicHandleGrantV3,
  PublicPersonaProfileV1,
  SaleNamespaceActivationV1,
} from "@pirate/contracts";
import { Context, Data, Effect } from "effect";
import { IdGen } from "../ports.ts";

export { IdGen };

export class HandleSalesRejected extends Data.TaggedError("HandleSalesRejected")<{
  readonly reason: HandleSafeReasonV2;
  readonly retryable: boolean;
  readonly effectiveOfferingId?: string;
}> {}

export class HandleDirectGrantRecipientUnavailable extends Data.TaggedError(
  "HandleDirectGrantRecipientUnavailable",
)<Record<string, never>> {}

export class HandleSalesStorageFailed extends Data.TaggedError("HandleSalesStorageFailed")<{
  readonly reason: "constraint" | "invalid-row" | "outcome-unknown" | "unavailable";
}> {}

export class HandleSalesPageRejected extends Data.TaggedError("HandleSalesPageRejected")<{
  readonly reason: "invalid_cursor" | "invalid_limit";
}> {}

export class HandleRecipientTokenCryptoFailed extends Data.TaggedError(
  "HandleRecipientTokenCryptoFailed",
)<{
  readonly reason: "configuration" | "crypto" | "invalid-ciphertext";
}> {}

export type HandleSalesFailure =
  | HandleDirectGrantRecipientUnavailable
  | HandleRecipientTokenCryptoFailed
  | HandleSalesPageRejected
  | HandleSalesRejected
  | HandleSalesStorageFailed;

export type HandleRecipientTokenLookupV1 = Readonly<{
  keyVersion: string;
  digest: string;
}>;

export type HandleRecipientTokenSealedV1 = Readonly<{
  keyVersion: string;
  ciphertext: Uint8Array;
}>;

export class HandleRecipientTokenVault extends Context.Service<
  HandleRecipientTokenVault,
  {
    readonly mint: Effect.Effect<string, HandleRecipientTokenCryptoFailed>;
    readonly lookupCandidates: (
      token: string,
    ) => Effect.Effect<readonly HandleRecipientTokenLookupV1[], HandleRecipientTokenCryptoFailed>;
    readonly seal: (
      token: string,
      associatedData: string,
    ) => Effect.Effect<HandleRecipientTokenSealedV1, HandleRecipientTokenCryptoFailed>;
    readonly reveal: (
      sealed: HandleRecipientTokenSealedV1,
      associatedData: string,
    ) => Effect.Effect<string, HandleRecipientTokenCryptoFailed>;
  }
>()("HandleRecipientTokenVault") {}

export type PageInput = Readonly<{ limit?: number; cursor?: string }>;
export type PageResult<A> = Readonly<{ items: readonly A[]; next_cursor: string | null }>;

export type HandleSaleNamespaceAuthorityInput = Readonly<{
  namespaceAuthorityReference: string;
  expectedNamespaceAuthorityGeneration: number;
  dnsZoneActivationId: string;
  expectedDnsZoneActivationGeneration: number;
  dedicatedRootReplacementConfirmed: true;
}>;

export type CreateHandleSaleNamespaceInput = HandleSaleNamespaceAuthorityInput &
  Readonly<{
    accountId: string;
    communityId: string;
    idempotencyKey: string;
  }>;

export type ReviseHandleSaleNamespaceInput = CreateHandleSaleNamespaceInput &
  Readonly<{
    activationId: string;
    expectedActivationHash: string;
    requestedStatus: "active" | "suspended" | "revoked";
  }>;

export type CreateHandleOfferingInput = Readonly<{
  accountId: string;
  communityId: string;
  idempotencyKey: string;
  terms: HandleOfferingTermsCommandV2;
}>;

export type ReviseHandleOfferingInput = CreateHandleOfferingInput &
  Readonly<{
    offeringId: string;
    expectedOfferingHash: string;
    requestedStatus: "active" | "paused" | "retired";
  }>;

export type HandlePersonaLinkConfirmationV1 = Readonly<{
  confirmation_id: string;
  confirmation_hash: string;
  persona_id: string;
  offering_id: string;
  target_community_id: string;
  family: "hns" | "spaces";
  namespace_root: string;
  public_linkage_generation: number;
  persona_public_identity_digest: string;
  status: "available" | "consumed" | "expired";
  confirmed_at: string;
  expires_at: string;
  replayed: boolean;
}>;

export type CreateHandleQuoteResultV2 =
  | Readonly<{ kind: "quoted"; quote: HandleQuoteV2; replayed: boolean }>
  | Readonly<{
      kind: "eligibility_required";
      offering_id: string;
      owner_persona_id: string;
      reason: "evidence_required" | "qualification_unsatisfied";
    }>;

export type HandleRecipientTokenPersistenceResultV1 = Readonly<{
  sealed: HandleRecipientTokenSealedV1;
  associatedData: string;
  expiresAt: string;
  replayed: boolean;
}>;

export type HandleQualificationPolicyAuthoringResultV2 = Readonly<{
  kind: "account_allowlist_policy_authored_v2";
  request_hash: string;
  qualification_policy: HandleCuratedQualificationPolicyRefV1;
  created_at: string;
  replayed: boolean;
}>;

export interface HandleSalesStore {
  readonly createSaleNamespace: (
    input: CreateHandleSaleNamespaceInput & Readonly<{ activationId: string; actionId: string }>,
  ) => Effect.Effect<
    Readonly<{ activation: SaleNamespaceActivationV1; replayed: boolean }>,
    HandleSalesFailure
  >;
  readonly reviseSaleNamespace: (
    input: ReviseHandleSaleNamespaceInput & Readonly<{ actionId: string }>,
  ) => Effect.Effect<
    Readonly<{ activation: SaleNamespaceActivationV1; replayed: boolean }>,
    HandleSalesFailure
  >;
  readonly listSaleNamespaces: (
    input: Readonly<{ communityId: string }> & PageInput,
  ) => Effect.Effect<
    PageResult<SaleNamespaceActivationV1>,
    HandleSalesPageRejected | HandleSalesStorageFailed
  >;
  readonly createRecipientToken: (
    input: Readonly<{
      accountId: string;
      communityId: string;
      idempotencyKey: string;
      tokenId: string;
      actionId: string;
      rawToken: string;
      lookups: readonly HandleRecipientTokenLookupV1[];
      sealed: HandleRecipientTokenSealedV1;
    }>,
  ) => Effect.Effect<HandleRecipientTokenPersistenceResultV1, HandleSalesFailure>;
  readonly createQualificationPolicy: (
    input: Readonly<{
      accountId: string;
      communityId: string;
      idempotencyKey: string;
      recipientTokenLookups: readonly HandleRecipientTokenLookupV1[];
      expectedAccountDirectoryBindingVersion: string;
      policyId: string;
      requirementId: string;
      actionId: string;
    }>,
  ) => Effect.Effect<HandleQualificationPolicyAuthoringResultV2, HandleSalesFailure>;
  readonly createOffering: (
    input: CreateHandleOfferingInput & Readonly<{ offeringId: string; actionId: string }>,
  ) => Effect.Effect<
    Readonly<{ offering: CommunityHandleOfferingV2; replayed: boolean }>,
    HandleSalesFailure
  >;
  readonly reviseOffering: (
    input: ReviseHandleOfferingInput & Readonly<{ actionId: string }>,
  ) => Effect.Effect<
    Readonly<{ offering: CommunityHandleOfferingV2; replayed: boolean }>,
    HandleSalesFailure
  >;
  readonly listOfferings: (
    input: Readonly<{ communityId: string }> & PageInput,
  ) => Effect.Effect<
    PageResult<CommunityHandleOfferingV2>,
    HandleSalesPageRejected | HandleSalesStorageFailed
  >;
  readonly confirmPersonaReuse: (
    input: Readonly<{
      accountId: string;
      personaId: string;
      offeringId: string;
      idempotencyKey: string;
      confirmationId: string;
      actionId: string;
    }>,
  ) => Effect.Effect<HandlePersonaLinkConfirmationV1, HandleSalesFailure>;
  readonly createQuote: (
    input: Readonly<{
      accountId: string;
      personaId: string;
      offeringId: string;
      desiredLabel: string;
      idempotencyKey: string;
      quoteId: string;
      actionId: string;
    }>,
  ) => Effect.Effect<CreateHandleQuoteResultV2, HandleSalesFailure>;
  readonly createReservation: (
    input: Readonly<{
      accountId: string;
      personaId: string;
      quoteId: string;
      expectedQuoteHash: string;
      idempotencyKey: string;
      reservationId: string;
      actionId: string;
    }>,
  ) => Effect.Effect<
    Readonly<{ reservation: HandleReservationV2; replayed: boolean }>,
    HandleSalesFailure
  >;
  readonly submitFreeClaim: (
    input: Readonly<{
      accountId: string;
      personaId: string;
      reservationId: string;
      expectedReservationHash: string;
      idempotencyKey: string;
      claimId: string;
      grantId: string;
      issuanceOperationId: string;
      actionId: string;
    }>,
  ) => Effect.Effect<Readonly<{ claim: HandleClaimV2; replayed: boolean }>, HandleSalesFailure>;
  readonly getClaim: (input: {
    readonly accountId: string;
    readonly claimId: string;
  }) => Effect.Effect<HandleClaimV2 | null, HandleSalesStorageFailed>;
  readonly listPersonaGrants: (
    input: Readonly<{ personaId: string }> & PageInput,
  ) => Effect.Effect<
    PageResult<PublicHandleGrantV3>,
    HandleSalesPageRejected | HandleSalesStorageFailed
  >;
  readonly getPublicGrant: (input: {
    readonly family: "hns" | "spaces";
    readonly namespaceRoot: string;
    readonly handleLabel: string;
  }) => Effect.Effect<PublicHandleGrantV3 | null, HandleSalesStorageFailed>;
  readonly getPublicPersona: (input: {
    readonly personaId: string;
  }) => Effect.Effect<PublicPersonaProfileV1 | null, HandleSalesStorageFailed>;
}

const nextId = (prefix: string): Effect.Effect<string, never, IdGen> =>
  Effect.gen(function* () {
    const ids = yield* IdGen;
    return `${prefix}_${yield* ids.next}`;
  });

export function makeHandleSalesService(store: HandleSalesStore) {
  return {
    createSaleNamespace: (input: CreateHandleSaleNamespaceInput) =>
      Effect.gen(function* () {
        return yield* store.createSaleNamespace({
          ...input,
          activationId: yield* nextId("sale_namespace_activation"),
          actionId: yield* nextId("handle_sale_activation_action"),
        });
      }),
    reviseSaleNamespace: (input: ReviseHandleSaleNamespaceInput) =>
      Effect.gen(function* () {
        return yield* store.reviseSaleNamespace({
          ...input,
          actionId: yield* nextId("handle_sale_activation_action"),
        });
      }),
    listSaleNamespaces: store.listSaleNamespaces,
    createRecipientToken: (input: {
      readonly accountId: string;
      readonly communityId: string;
      readonly idempotencyKey: string;
    }) =>
      Effect.gen(function* () {
        const vault = yield* HandleRecipientTokenVault;
        const rawToken = yield* vault.mint;
        const lookups = yield* vault.lookupCandidates(rawToken);
        const tokenId = yield* nextId("handle_recipient_token");
        const actionId = yield* nextId("handle_recipient_token_action");
        const associatedData = JSON.stringify([
          "pirate-handle-recipient-token-envelope-v1",
          input.accountId,
          input.communityId,
          input.idempotencyKey,
          tokenId,
        ]);
        const sealed = yield* vault.seal(rawToken, associatedData);
        const persisted = yield* store.createRecipientToken({
          ...input,
          actionId,
          tokenId,
          rawToken,
          lookups,
          sealed,
        });
        const recipientToken = yield* vault.reveal(persisted.sealed, persisted.associatedData);
        return {
          recipient_token: recipientToken,
          expires_at: persisted.expiresAt,
          replayed: persisted.replayed,
        };
      }),
    createQualificationPolicy: (input: {
      readonly accountId: string;
      readonly communityId: string;
      readonly idempotencyKey: string;
      readonly recipientToken: string;
      readonly expectedAccountDirectoryBindingVersion: string;
    }) =>
      Effect.gen(function* () {
        const vault = yield* HandleRecipientTokenVault;
        const recipientTokenLookups = yield* vault.lookupCandidates(input.recipientToken);
        return yield* store.createQualificationPolicy({
          ...input,
          recipientTokenLookups,
          policyId: yield* nextId("handle_qualification_policy"),
          requirementId: yield* nextId("handle_requirement"),
          actionId: yield* nextId("handle_qualification_policy_action"),
        });
      }),
    createOffering: (input: CreateHandleOfferingInput) =>
      Effect.gen(function* () {
        return yield* store.createOffering({
          ...input,
          offeringId: yield* nextId("handle_offering"),
          actionId: yield* nextId("handle_offering_action"),
        });
      }),
    reviseOffering: (input: ReviseHandleOfferingInput) =>
      Effect.gen(function* () {
        return yield* store.reviseOffering({
          ...input,
          actionId: yield* nextId("handle_offering_action"),
        });
      }),
    listOfferings: store.listOfferings,
    confirmPersonaReuse: (input: {
      readonly accountId: string;
      readonly personaId: string;
      readonly offeringId: string;
      readonly idempotencyKey: string;
    }) =>
      Effect.gen(function* () {
        return yield* store.confirmPersonaReuse({
          ...input,
          confirmationId: yield* nextId("handle_link_confirmation"),
          actionId: yield* nextId("handle_link_confirmation_action"),
        });
      }),
    createQuote: (input: {
      readonly accountId: string;
      readonly personaId: string;
      readonly offeringId: string;
      readonly desiredLabel: string;
      readonly idempotencyKey: string;
    }) =>
      Effect.gen(function* () {
        return yield* store.createQuote({
          ...input,
          quoteId: yield* nextId("handle_quote"),
          actionId: yield* nextId("handle_quote_action"),
        });
      }),
    createReservation: (input: {
      readonly accountId: string;
      readonly personaId: string;
      readonly quoteId: string;
      readonly expectedQuoteHash: string;
      readonly idempotencyKey: string;
    }) =>
      Effect.gen(function* () {
        return yield* store.createReservation({
          ...input,
          reservationId: yield* nextId("handle_reservation"),
          actionId: yield* nextId("handle_reservation_action"),
        });
      }),
    submitFreeClaim: (input: {
      readonly accountId: string;
      readonly personaId: string;
      readonly reservationId: string;
      readonly expectedReservationHash: string;
      readonly idempotencyKey: string;
    }) =>
      Effect.gen(function* () {
        const claimId = yield* nextId("handle_claim");
        return yield* store.submitFreeClaim({
          ...input,
          claimId,
          grantId: yield* nextId("handle_grant"),
          issuanceOperationId: `issuance:hns-hosted:${claimId}`,
          actionId: yield* nextId("handle_claim_action"),
        });
      }),
    getClaim: store.getClaim,
    listPersonaGrants: store.listPersonaGrants,
    getPublicGrant: store.getPublicGrant,
    getPublicPersona: store.getPublicPersona,
  } as const;
}

export type HandleGrantDocumentV2 = HandleGrantPrivateV2;
