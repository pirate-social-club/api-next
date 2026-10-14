// Serving-capable source only. Absent managed admission is disabled; production is refused.
import {
  type Clock,
  type ControlPlaneDb,
  type ControlPlaneError,
  type IdGen,
  makeOwnerGuestStudyService,
  makeOwnerSpokenSuccessProtocol,
} from "@pirate/application/use-cases/guest-learning";
import {
  GetPublicGuestStudyPreparedContentV2,
  guestParticipationRegistry,
} from "@pirate/contracts";
import { makeControlPlaneGuestPracticeParticipationReadStore } from "@pirate/platform-cf/guest-practice-participation-read-store";
import { makeControlPlanePreparedGuestStudyContentStore } from "@pirate/platform-cf/guest-prepared-study-content-store";
import { makeGuestRecoveryAudioDeletionStores } from "@pirate/platform-cf/guest-recovery-deletion-store";
import { makeGuestStudyManagedReadiness } from "@pirate/platform-cf/guest-study-managed-readiness";
import { makeOriginalAccountStudySourceControl } from "@pirate/platform-cf/owner-account-source-control";
import { makeOwnerLearnerAudioDeletionIo } from "@pirate/platform-cf/owner-audio-deletion-io";
import { makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores } from "@pirate/platform-cf/owner-guest-spoken-checkpoint-recovery-store";
import { makeOwnerGuestSpokenDispatchContextStore } from "@pirate/platform-cf/owner-guest-spoken-dispatch-context";
import { makeOwnerGuestStudyPublicVisibilityStore } from "@pirate/platform-cf/owner-guest-study-public-visibility";
import { makeControlPlaneOwnerSpokenPreArchiveCheckpointStore } from "@pirate/platform-cf/owner-spoken-checkpoint-store";
import { makeOwnerSpokenFencedArchiveStage } from "@pirate/platform-cf/owner-spoken-fenced-archive";
import { makeOwnerElevenLabsStudyInvokingTranscriber } from "@pirate/platform-cf/owner-study-invoking-transcriber";
import { makeControlPlaneOwnerStudyMutations } from "@pirate/platform-cf/owner-study-mutations";
import { makeControlPlaneOwnerStudyStarter } from "@pirate/platform-cf/owner-study-starter";
import { composeOwnerAwareStudyV2Store } from "@pirate/platform-cf/owner-study-store-composition";
import type { SessionTokenVerifier } from "@pirate/platform-cf/session-tokens";
import { makeControlPlaneStudyV2Store } from "@pirate/platform-cf/study-v2-repository";
import { Effect, type Layer, Schema } from "effect";
import {
  guestLearningNames,
  makeGuestAuthorityComposition,
} from "./guest-authority-controller-composition.ts";
import type { GuestAuthorityControllerName } from "./guest-authority-controllers.ts";
import { makeGuestLearningComposition } from "./guest-learning-controller-composition.ts";
import type { GuestLearningControllerName } from "./guest-learning-controllers.ts";
import { projectPracticePreparedGuestStudyContentV2 } from "./guest-practice-prepared-v2.ts";
import { readGuestStudyRuntimeConfiguration } from "./guest-study-runtime-configuration.ts";
import { withEndpointResult } from "./transport.ts";

export type GuestStudyServingName =
  | GuestAuthorityControllerName
  | GuestLearningControllerName
  | "GetPublicGuestStudyPreparedContentV2";
const authorityNames: readonly string[] = [
  "GetGuestAuthorityV1",
  "IssueGuestBootstrapV1",
  "ConfirmGuestBootstrapV1",
  "RenewGuestAuthorityV1",
  "RotateGuestCredentialV1",
  "AcknowledgeGuestCredentialV1",
  "CleanupGuestBrowserProofV1",
  "CreateGuestAttachmentIntentV1",
];
export function isGuestStudyServingName(name: string): name is GuestStudyServingName {
  return (
    name === "GetPublicGuestStudyPreparedContentV2" ||
    (guestLearningNames as readonly string[]).includes(name)
  );
}
function isAuthorityName(name: GuestStudyServingName): name is GuestAuthorityControllerName {
  return authorityNames.includes(name);
}
type Runtime = Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
type Archive = Parameters<typeof makeOwnerSpokenFencedArchiveStage>;
/** Process-owned dependencies only. Never decoded from a Request or inferred from
 * an ordinary principal. Admission must check actual native role/phase/storage
 * evidence; a client SQL GUC, claimed boolean, or stored configuration is no proof.
 * The deployment binding implementation is a separately reviewed prerequisite.
 */
export interface GuestStudyManagedRuntime {
  readonly learning: Runtime;
  readonly publicRead: Runtime;
  readonly cron: Runtime;
  readonly bucket: Archive[1] & Parameters<typeof makeOwnerLearnerAudioDeletionIo>[1];
  readonly retainTask: Archive[2];
  readonly transcriber: Parameters<typeof makeOwnerElevenLabsStudyInvokingTranscriber>[0];
  readonly clock: Clock["Service"];
  readonly ids: IdGen["Service"];
  readonly nowMilliseconds: () => number;
  readonly retryAfterSeconds: number;
  readonly ordinaryProductOrigin: string;
  readonly rerecordEnabled: boolean;
  /** Actual observer checks three DISTINCT real LOGIN roles satisfy the reviewed
   * exact catalogue-column / controlled-leaf / closed-cron ACL contracts and
   * current positive native phase + schema ledger + original storage producer closure.
   * Native readonly adapter additionally derives the separate observer LOGIN.
   * No grants, migrations, provider calls or files are mutated by inspection.
   */
  readonly observer: Runtime;
  readonly schema: string;
}
export interface GuestStudyServingInputs {
  readonly environment: string;
  readonly enabledBinding?: string;
  readonly configurationBinding?: string;
  readonly managed?: GuestStudyManagedRuntime;
  readonly accountVerifier: SessionTokenVerifier;
  readonly ordinarySessionScope: string;
  readonly hnsProtectedIngressOrigin?: string;
  readonly workerLearnerAudioBinding?: object;
}
export async function makeGuestStudyServingComposition(input: GuestStudyServingInputs) {
  // No constructor, DB lookup, body allocation, provider or storage I/O on the inert path.
  if (input.enabledBinding === undefined || input.enabledBinding === "false") return null;
  if (
    input.enabledBinding !== "true" ||
    !["staging", "development", "test"].includes(input.environment)
  )
    throw new Error("Guest Study serving requires explicit nonproduction admission");
  if (input.managed === undefined) throw new Error("Managed Guest Study bindings unavailable");
  // Source acceptance and route activation are separate. Never override a frozen
  // declaration to make a test or deployment pass.
  for (const name of guestLearningNames)
    if (guestParticipationRegistry[name].implementation === "disabled")
      throw new Error("Guest Study implementation declarations remain disabled");
  // This graph never dispatches the five accounting operations. Their accepted
  // declaration metadata does not grant this practice role financial capability;
  // actual exact native ACL/profile verification below still refuses excess rights.
  const m = input.managed;
  const readiness = makeGuestStudyManagedReadiness({
    learning: m.learning,
    publicRead: m.publicRead,
    cron: m.cron,
    observer: m.observer,
    schema: m.schema,
    workerLearnerAudioBinding: input.workerLearnerAudioBinding,
    selectedLearnerAudioBinding: m.bucket,
  });
  await readiness.verify();
  const config = readGuestStudyRuntimeConfiguration(input.configurationBinding);
  const policy = config?.policy ?? null;
  const disclosure = config?.disclosure ?? null;
  const starter = makeControlPlaneOwnerStudyStarter(m.learning, disclosure, policy);
  const mutations = makeControlPlaneOwnerStudyMutations(m.learning, {
    rawPolicy: policy,
    disclosureVersion: disclosure?.version ?? null,
    rerecordEnabled: m.rerecordEnabled,
    providerRetention: "stored",
  });
  const prepared = makeControlPlanePreparedGuestStudyContentStore(m.publicRead, disclosure);
  const store = composeOwnerAwareStudyV2Store({
    starter,
    mutations,
    prepared,
    ordinary: makeControlPlaneStudyV2Store(m.learning),
    originalAccountSources: makeOriginalAccountStudySourceControl(m.learning),
    verifiedOrdinaryAccount: null,
  });
  const success = makeOwnerSpokenSuccessProtocol(
    makeControlPlaneOwnerSpokenPreArchiveCheckpointStore(m.learning),
    store,
    makeOwnerSpokenFencedArchiveStage(m.learning, m.bucket, m.retainTask),
  );
  const study = makeOwnerGuestStudyService({
    store,
    prepared,
    atomicStarter: starter,
    dispatchContext: makeOwnerGuestSpokenDispatchContextStore(m.learning),
    resourcePolicy: policy,
    recovery: makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores(m.learning).browser,
    visibility: makeOwnerGuestStudyPublicVisibilityStore(m.publicRead),
    success,
    rerecordEnabled: m.rerecordEnabled,
    transcriber: makeOwnerElevenLabsStudyInvokingTranscriber(m.transcriber),
  });
  const authority = makeGuestAuthorityComposition({
    controlPlane: m.learning,
    accountVerifier: input.accountVerifier,
    ordinarySessionScope: input.ordinarySessionScope,
    ordinaryProductOrigin: m.ordinaryProductOrigin,
    ...(input.hnsProtectedIngressOrigin === undefined
      ? {}
      : { hnsProtectedIngressOrigin: input.hnsProtectedIngressOrigin }),
    nowMilliseconds: m.nowMilliseconds,
    retryAfterSeconds: m.retryAfterSeconds,
    currentResourcePolicy: policy,
    disclosure,
    // Canonical learning controller uses verified context.origin + actual decoded
    // CF edge metadata. The old pending callback supplies no privilege.
    trustedEdgeForRequest: async () => null,
  });
  const recovery = makeGuestRecoveryAudioDeletionStores(m.learning);
  // No positive/negative cache. Each ordinary handler admits once before
  // native proof/decoder work; HNS also admits before its body MAC, then freshly
  // at route dispatch. Accepted asynchronous producer callbacks retain their
  // original source authority and are not interrupted by a later ingress check.
  const checkedAuthentication = Object.freeze({
    ...authority.requestAuthentication,
    async authenticate(args: Parameters<typeof authority.requestAuthentication.authenticate>[0]) {
      await readiness.verify();
      return authority.requestAuthentication.authenticate(args);
    },
    async precheckHnsBeforeBody(
      args: Parameters<typeof authority.requestAuthentication.precheckHnsBeforeBody>[0],
    ) {
      await readiness.verify();
      return authority.requestAuthentication.precheckHnsBeforeBody(args);
    },
  });
  const learning = makeGuestLearningComposition({
    authority,
    services: {
      study,
      participations: makeControlPlaneGuestPracticeParticipationReadStore(m.learning),
      retention: recovery.retention,
      deletion: recovery.deletion,
      deletionIo: makeOwnerLearnerAudioDeletionIo(recovery.deletion, m.bucket),
      clock: m.clock,
      ids: m.ids,
      retryAfterSeconds: m.retryAfterSeconds,
    },
  });
  return Object.freeze({
    mode: "practice" as const,
    requestAuthentication: checkedAuthentication,
    // Cron remains a distinct role/graph owned by cron composition. No browser
    // handler receives its runtime or controlled closed-checkpoint leaves.
    async handle(
      input: Omit<Parameters<typeof authority.handleAuthorityOperation>[0], "name"> & {
        readonly name: GuestStudyServingName;
      },
    ) {
      await readiness.verify();
      if (input.name === "GetPublicGuestStudyPreparedContentV2") {
        const locations = await input.decodeRequestLocations();
        const path = Schema.decodeUnknownSync(GetPublicGuestStudyPreparedContentV2.request.path, {
          onExcessProperty: "error",
        })(locations.params);
        const query = Schema.decodeUnknownSync(GetPublicGuestStudyPreparedContentV2.request.query, {
          onExcessProperty: "error",
        })(locations.query);
        const actual = await Effect.runPromise(
          prepared.get({
            communityId: path.communityId,
            postId: path.postId,
            targetLanguage: query.target_language ?? null,
            learnerBand: query.learner_band ?? null,
          }),
        );
        return withEndpointResult(projectPracticePreparedGuestStudyContentV2(actual), 200, {
          "Cache-Control": "private, no-store",
        });
      }
      return isAuthorityName(input.name)
        ? authority.handleAuthorityOperation({ ...input, name: input.name })
        : learning.handleLearningOperation({ ...input, name: input.name });
    },
  });
}
export type GuestStudyServingComposition = NonNullable<
  Awaited<ReturnType<typeof makeGuestStudyServingComposition>>
>;
