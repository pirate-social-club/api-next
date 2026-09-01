import type {
  DanceAttemptServices,
  DanceAttemptSessionAuthorityResolver,
  DanceAttemptStore,
  DanceAttemptUploadAuthority,
} from "@pirate/application/use-cases/dance/attempt-services";

/**
 * Production has persistence but no authority capable of creating a private
 * session or accepting an upload. Review and tests must inject both explicitly.
 */
export function makeProductionDanceAttemptServices(
  store: DanceAttemptStore,
  sessionAuthority?: DanceAttemptSessionAuthorityResolver,
  uploadAuthority?: DanceAttemptUploadAuthority,
): DanceAttemptServices {
  return {
    store,
    sessionAuthority: sessionAuthority ?? null,
    uploadAuthority: uploadAuthority ?? null,
  };
}
