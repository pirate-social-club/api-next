/** Complete socket-free services; every unconfigured capability fails fast. */
import type {
  VideoPublicationServices,
  VideoPublicationStore,
} from "../../application/src/video/publication.ts";

function unexpected(method: string): never {
  throw new Error(`Unexpected video publication fixture call: ${method}`);
}

export function notificationsVideoPublicationStoreFixture(
  overrides: Partial<VideoPublicationStore> = {},
): VideoPublicationStore {
  return {
    replayReservation: () => unexpected("store.replayReservation"),
    createReservation: () => unexpected("store.createReservation"),
    getReservationForAuthor: () => unexpected("store.getReservationForAuthor"),
    getReservationForAccount: () => unexpected("store.getReservationForAccount"),
    getReservationSongPlan: () => unexpected("store.getReservationSongPlan"),
    renewParts: () => unexpected("store.renewParts"),
    createSubmission: () => unexpected("store.createSubmission"),
    replaySubmissionStart: () => unexpected("store.replaySubmissionStart"),
    getSubmissionForAccount: () => unexpected("store.getSubmissionForAccount"),
    getSubmissionByOperation: () => unexpected("store.getSubmissionByOperation"),
    getSubmissionForModerator: () => unexpected("store.getSubmissionForModerator"),
    replayCommand: () => unexpected("store.replayCommand"),
    beginFinalize: () => unexpected("store.beginFinalize"),
    recordMultipartCompleted: () => unexpected("store.recordMultipartCompleted"),
    abandonInvalidManifest: () => unexpected("store.abandonInvalidManifest"),
    finalizeSealed: () => unexpected("store.finalizeSealed"),
    abandonExpectationMismatch: () => unexpected("store.abandonExpectationMismatch"),
    commitAnalysisDecision: () => unexpected("store.commitAnalysisDecision"),
    recordProcessingFailure: () => unexpected("store.recordProcessingFailure"),
    publish: () => unexpected("store.publish"),
    observeSongReferencePolicy: () => unexpected("store.observeSongReferencePolicy"),
    attachSongVideoMaster: () => unexpected("store.attachSongVideoMaster"),
    publishSongReference: () => unexpected("store.publishSongReference"),
    retryPoster: () => unexpected("store.retryPoster"),
    retryTechnical: () => unexpected("store.retryTechnical"),
    cancel: () => unexpected("store.cancel"),
    moderate: () => unexpected("store.moderate"),
    ...overrides,
  };
}

export function notificationsVideoPublicationServicesFixture(
  overrides: Partial<VideoPublicationServices> = {},
): VideoPublicationServices {
  return {
    store: notificationsVideoPublicationStoreFixture(),
    multipart: {
      create: () => unexpected("multipart.create"),
      renew: () => unexpected("multipart.renew"),
      completeOrInspect: () => unexpected("multipart.completeOrInspect"),
      abort: () => unexpected("multipart.abort"),
    },
    sealer: {
      inspect: () => unexpected("sealer.inspect"),
      seal: () => unexpected("sealer.seal"),
    },
    personaServices: {
      personaStore: { findOwned: () => unexpected("personaStore.findOwned") },
      runEffect: () => unexpected("personaServices.runEffect"),
    },
    nowIso: () => unexpected("nowIso"),
    randomUuid: () => unexpected("randomUuid"),
    ...overrides,
  };
}
