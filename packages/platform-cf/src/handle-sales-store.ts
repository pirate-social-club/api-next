import type { ControlPlaneDb, ControlPlaneError, HandleSalesStore } from "@pirate/application";
import { Effect, type Layer } from "effect";
import type { makeControlPlaneHandleSalesRepository } from "./handle-sales-repository.ts";

export function provideHandleSalesRepository(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  repository: ReturnType<typeof makeControlPlaneHandleSalesRepository>,
): HandleSalesStore {
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  const store = {
    createSaleNamespace: (input: Parameters<HandleSalesStore["createSaleNamespace"]>[0]) =>
      provide(repository.createSaleNamespace(input)),
    reviseSaleNamespace: (input: Parameters<HandleSalesStore["reviseSaleNamespace"]>[0]) =>
      provide(repository.reviseSaleNamespace(input)),
    listSaleNamespaces: (input: Parameters<HandleSalesStore["listSaleNamespaces"]>[0]) =>
      provide(repository.listSaleNamespaces(input)),
    createRecipientToken: (input: Parameters<HandleSalesStore["createRecipientToken"]>[0]) =>
      provide(repository.createRecipientToken(input)),
    createQualificationPolicy: (
      input: Parameters<HandleSalesStore["createQualificationPolicy"]>[0],
    ) => provide(repository.createQualificationPolicy(input)),
    createOffering: (input: Parameters<HandleSalesStore["createOffering"]>[0]) =>
      provide(repository.createOffering(input)),
    reviseOffering: (input: Parameters<HandleSalesStore["reviseOffering"]>[0]) =>
      provide(repository.reviseOffering(input)),
    listOfferings: (input: Parameters<HandleSalesStore["listOfferings"]>[0]) =>
      provide(repository.listOfferings(input)),
    getManagementContext: (input: Parameters<HandleSalesStore["getManagementContext"]>[0]) =>
      provide(repository.getManagementContext(input)),
    listManagementSaleNamespaces: (
      input: Parameters<HandleSalesStore["listManagementSaleNamespaces"]>[0],
    ) => provide(repository.listManagementSaleNamespaces(input)),
    listManagementOfferings: (input: Parameters<HandleSalesStore["listManagementOfferings"]>[0]) =>
      provide(repository.listManagementOfferings(input)),
    confirmPersonaReuse: (input: Parameters<HandleSalesStore["confirmPersonaReuse"]>[0]) =>
      provide(repository.confirmPersonaReuse(input)),
    createQuote: (input: Parameters<HandleSalesStore["createQuote"]>[0]) =>
      provide(repository.createQuote(input)),
    createReservation: (input: Parameters<HandleSalesStore["createReservation"]>[0]) =>
      provide(repository.createReservation(input)),
    submitFreeClaim: (input: Parameters<HandleSalesStore["submitFreeClaim"]>[0]) =>
      provide(repository.submitFreeClaim(input)),
    getClaim: (input: Parameters<HandleSalesStore["getClaim"]>[0]) =>
      provide(repository.getClaim(input)),
    listPersonaGrants: (input: Parameters<HandleSalesStore["listPersonaGrants"]>[0]) =>
      provide(repository.listPersonaGrants(input)),
    getPublicGrant: (input: Parameters<HandleSalesStore["getPublicGrant"]>[0]) =>
      provide(repository.getPublicGrant(input)),
    getPublicPersona: (input: Parameters<HandleSalesStore["getPublicPersona"]>[0]) =>
      provide(repository.getPublicPersona(input)),
  };
  // The repository maps every ControlPlaneError before this boundary. The
  // assertion hides only Effect's conservative union left by withTransaction.
  return store as unknown as HandleSalesStore;
}
