import { Schema } from "effect";
import { endpoint } from "./endpoint.ts";
import * as hns from "./handle-sales.ts";
import {
  BoundedIdentifier,
  IdempotencyKey,
  PositiveInteger,
  Sha256Hex,
} from "./handle-sales-scalars.ts";
import {
  CommunityHandleOfferingManagementItemV3,
  CommunityHandleOfferingV4,
  CreateHandleQuoteResultV4,
  CreateSpacesSaleNamespaceActivationV1,
  HandleClaimV3,
  HandleReservationV3,
  HandleSaleNamespaceManagementItemV2,
  HandleSalesManagementContextV2,
  PublicHandleGrantV4,
  PublicPersonaProfileV2,
  SaleNamespaceActivationV2,
  SpacesCanonicalRootV1,
  SpacesSubspaceLabelV1,
} from "./handle-sales-spaces.ts";

const page = <T>(item: Schema.Schema<T>) =>
  Schema.Struct({ items: Schema.Array(item), next_cursor: Schema.NullOr(BoundedIdentifier) });

export const HandleSpacesOfferingTermsCommandV1 = Schema.Struct({
  ...hns.CreateCommunityHandleOffering.request.body.fields.terms.fields,
  label_scope: Schema.Struct({
    kind: Schema.Literal("label_rule_v2"),
    label_grammar_id: Schema.Literal("spaces_subspace_label_v1"),
    reserved_labels_id: BoundedIdentifier,
    expected_reserved_labels_revision: PositiveInteger,
    availability: hns.HandleAvailabilityRuleV1,
  }),
  allocation_kind: Schema.Literal("first_come_v1"),
  fulfillment_kind: Schema.Literal("spaces_native_v1"),
});

export const HandleOfferingTermsCommandV3 = Schema.Union([
  Schema.Struct({
    ...hns.CreateCommunityHandleOffering.request.body.fields.terms.fields,
    fulfillment_kind: Schema.Literals(["hosted_persona_v1", "delegated_zone_v1"]),
  }),
  HandleSpacesOfferingTermsCommandV1,
]);
export type HandleOfferingTermsCommandV3 = Schema.Schema.Type<typeof HandleOfferingTermsCommandV3>;

const spacesRevisionBody = Schema.Struct({
  ...CreateSpacesSaleNamespaceActivationV1.fields,
  expected_sale_namespace_activation_hash: Sha256Hex,
  requested_status: Schema.Literals(["active", "suspended", "revoked"]),
});

const CreateHandleSaleNamespace = endpoint({
  ...hns.CreateHandleSaleNamespace,
  request: {
    ...hns.CreateHandleSaleNamespace.request,
    body: Schema.Union([
      hns.CreateHandleSaleNamespace.request.body,
      CreateSpacesSaleNamespaceActivationV1,
    ]),
  },
  response: Schema.Struct({ activation: SaleNamespaceActivationV2, replayed: Schema.Boolean }),
});

const ReviseHandleSaleNamespace = endpoint({
  ...hns.ReviseHandleSaleNamespace,
  request: {
    ...hns.ReviseHandleSaleNamespace.request,
    body: Schema.Union([hns.ReviseHandleSaleNamespace.request.body, spacesRevisionBody]),
  },
  response: Schema.Struct({ activation: SaleNamespaceActivationV2, replayed: Schema.Boolean }),
});

const ListHandleSaleNamespaces = endpoint({
  ...hns.ListHandleSaleNamespaces,
  response: page(SaleNamespaceActivationV2),
});

const CreateCommunityHandleOffering = endpoint({
  ...hns.CreateCommunityHandleOffering,
  request: {
    ...hns.CreateCommunityHandleOffering.request,
    body: Schema.Struct({ idempotency_key: IdempotencyKey, terms: HandleOfferingTermsCommandV3 }),
  },
  response: Schema.Struct({ offering: CommunityHandleOfferingV4, replayed: Schema.Boolean }),
});

const ReviseCommunityHandleOffering = endpoint({
  ...hns.ReviseCommunityHandleOffering,
  request: {
    ...hns.ReviseCommunityHandleOffering.request,
    body: Schema.Struct({
      idempotency_key: IdempotencyKey,
      expected_offering_hash: Sha256Hex,
      requested_status: Schema.Literals(["active", "paused", "retired"]),
      terms: HandleOfferingTermsCommandV3,
    }),
  },
  response: Schema.Struct({ offering: CommunityHandleOfferingV4, replayed: Schema.Boolean }),
});

const ListCommunityHandleOfferings = endpoint({
  ...hns.ListCommunityHandleOfferings,
  response: page(CommunityHandleOfferingV4),
});

const GetHandleSalesManagement = endpoint({
  ...hns.GetHandleSalesManagement,
  response: HandleSalesManagementContextV2,
});

const ListHandleSaleNamespaceManagement = endpoint({
  ...hns.ListHandleSaleNamespaceManagement,
  response: page(HandleSaleNamespaceManagementItemV2),
});

const ListCommunityHandleOfferingManagement = endpoint({
  ...hns.ListCommunityHandleOfferingManagement,
  response: page(CommunityHandleOfferingManagementItemV3),
});

const CreateHandleQuote = endpoint({
  ...hns.CreateHandleQuote,
  response: CreateHandleQuoteResultV4,
});

const CreateHandleReservation = endpoint({
  ...hns.CreateHandleReservation,
  response: Schema.Struct({ reservation: HandleReservationV3, replayed: Schema.Boolean }),
});

const SubmitFreeHandleClaim = endpoint({
  ...hns.SubmitFreeHandleClaim,
  response: Schema.Struct({ claim: HandleClaimV3, replayed: Schema.Boolean }),
});

const GetHandleClaim = endpoint({
  ...hns.GetHandleClaim,
  response: HandleClaimV3,
});

const ListPersonaHandleGrants = endpoint({
  ...hns.ListPersonaHandleGrants,
  response: page(PublicHandleGrantV4),
});

const GetPublicHandleGrant = endpoint({
  ...hns.GetPublicHandleGrant,
  request: {
    ...hns.GetPublicHandleGrant.request,
    path: Schema.Union([
      Schema.Struct({
        ...hns.GetPublicHandleGrant.request.path.fields,
        family: Schema.Literal("hns"),
      }),
      Schema.Struct({
        family: Schema.Literal("spaces"),
        namespaceRoot: SpacesCanonicalRootV1,
        handleLabel: SpacesSubspaceLabelV1,
      }),
    ]),
  },
  response: PublicHandleGrantV4,
});

const GetPublicPersona = endpoint({
  ...hns.GetPublicPersona,
  response: PublicPersonaProfileV2,
});

/** The shared public API uses successor schemas without changing route IDs. */
export const handleSalesSpacesRegistry = {
  ...hns.handleSalesRegistry,
  CreateHandleSaleNamespace,
  ReviseHandleSaleNamespace,
  ListHandleSaleNamespaces,
  CreateCommunityHandleOffering,
  ReviseCommunityHandleOffering,
  ListCommunityHandleOfferings,
  GetHandleSalesManagement,
  ListHandleSaleNamespaceManagement,
  ListCommunityHandleOfferingManagement,
  CreateHandleQuote,
  CreateHandleReservation,
  SubmitFreeHandleClaim,
  GetHandleClaim,
  ListPersonaHandleGrants,
  GetPublicHandleGrant,
  GetPublicPersona,
} as const;
