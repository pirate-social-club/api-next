import type {
  DanceReferenceAuthoringAuthorityResolver,
  DanceReferenceServices,
  DanceReferenceStore,
} from "@pirate/application/use-cases/dance/reference-services";

/**
 * Production stays closed until the generic sealed-video lane explicitly
 * supplies its reviewed authority resolver. There is no implicit adapter.
 */
export function makeProductionDanceReferenceServices(
  store: DanceReferenceStore,
  authority?: DanceReferenceAuthoringAuthorityResolver,
): DanceReferenceServices {
  return { store, authority: authority ?? null };
}
