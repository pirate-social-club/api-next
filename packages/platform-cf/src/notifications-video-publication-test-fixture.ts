/** Complete fail-fast service doubles plus an explicitly invoked persisted
 * reader fixture. Importing this module performs no database/provider work. */
import type {
  VideoPublicationServices,
  VideoPublicationStore,
} from "../../application/src/video/publication.ts";
import { consumeVideoStreamIngest } from "../../application/src/video/stream-ingest.ts";
import type { withInbox } from "./notifications.pg-fixture.ts";
import { makeVideoStreamIngestStore } from "./video-stream-ingest-repository.ts";

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

/** Real publication and Stream-ingest state transitions; only the external
 * transport observations are deterministic ports, never a provider proof. */
export async function readyNotificationVideoForReaders(
  f: Parameters<Parameters<typeof withInbox>[0]>[0],
  postId: string,
): Promise<void> {
  const publication = await f.admin.query<{ operation_id: string }>(
    "SELECT operation_id FROM media_publication_projections WHERE post_id=$1 AND media_kind='video'",
    [postId],
  );
  const operation = publication.rows[0]?.operation_id;
  if (publication.rows.length !== 1 || !operation)
    throw new Error("Real video publication required");
  let copies = 0;
  const now = Date.now();
  const result = await consumeVideoStreamIngest(`video-enrichment:${operation}:stream`, {
    store: makeVideoStreamIngestStore(f.runtime, {
      leaseOwner: "notification-reader-fixture",
      leaseMs: 60_000,
    }),
    nowMs: () => now,
    deadlines: (at) => ({ acceptanceDeadlineMs: at + 30_000, encodingDeadlineMs: at + 300_000 }),
    transport: {
      copy: async (input) => {
        if (!input.requireSignedURLs || input.downloadsEnabled)
          throw new Error("Unsafe fixture copy policy");
        copies += 1;
      },
      observe: async (identity) => [
        {
          ...identity,
          providerVideoId: "c".repeat(32),
          encoding: "ready",
          requireSignedURLs: true,
          downloadsEnabled: false,
        },
      ],
    },
  });
  if (result !== "ready" || copies !== 1)
    throw new Error("Real video ingest did not become ready once");
}
