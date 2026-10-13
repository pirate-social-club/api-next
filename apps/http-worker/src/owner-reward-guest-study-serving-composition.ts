// Dedicated119 financial Guest graph. No default Worker selection/activation.
// The actual maintained native readiness verifier remains mandatory and must
// receive Root's COMPLETE accepted financial candidate/profile successor; the
// historical learning-only candidate refuses this graph's new financial phase.
import {
  type Clock,
  type ControlPlaneDb,
  type ControlPlaneError,
  type IdGen,
  makeOwnerGuestStudyService,
  makeOwnerSpokenSuccessProtocol,
} from "@pirate/application/use-cases/guest-learning";
import { guestParticipationRegistry } from "@pirate/contracts";
import { makeControlPlaneOwnerGuestParticipationReadStore } from "@pirate/platform-cf/owner-participation-read-store";
import { makeControlPlanePreparedGuestRewardContentStore } from "@pirate/platform-cf/guest-reward-prepared-content-store";
import { makeControlPlaneGuestRewardStudyContinuations,composeGuestRewardStudyMutationMethods } from "@pirate/platform-cf/owner-reward-study-continuation";
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
import { makeControlPlaneOwnerSpokenCapturedContinuationStore, makeControlPlaneOwnerStudyMutations } from "@pirate/platform-cf/owner-study-mutations";
import { makeControlPlaneOwnerStudyStarter } from "@pirate/platform-cf/owner-study-starter";
import { composeOwnerAwareStudyV2Store } from "@pirate/platform-cf/owner-study-store-composition";
import type { SessionTokenVerifier } from "@pirate/platform-cf/session-tokens";
import { makeControlPlaneStudyV2Store } from "@pirate/platform-cf/study-v2-repository";
import type { Layer } from "effect";
import {
  guestAccountingNames,
  guestLearningNames,
  makeGuestAuthorityComposition,
} from "./guest-authority-controller-composition.ts";
import type { GuestAuthorityControllerName } from "./guest-authority-controllers.ts";
import { makeOwnerRewardGuestLearningComposition } from "./owner-reward-guest-controller-composition.ts";
import type { OwnerRewardGuestLearningControllerName } from "./owner-reward-guest-controllers.ts";
import { readGuestStudyRuntimeConfiguration } from "./guest-study-runtime-configuration.ts";

export type OwnerRewardGuestStudyServingName = GuestAuthorityControllerName | OwnerRewardGuestLearningControllerName;
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
export function isOwnerRewardGuestStudyServingName(name: string): name is OwnerRewardGuestStudyServingName {
  return name === "GetPublicGuestStudyPreparedContentV2" || (guestLearningNames as readonly string[]).includes(name);
}
function isAuthorityName(name: OwnerRewardGuestStudyServingName): name is GuestAuthorityControllerName {
  return authorityNames.includes(name);
}
type Runtime = Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
type Archive = Parameters<typeof makeOwnerSpokenFencedArchiveStage>;
/** Process-owned dependencies only. Never decoded from a Request or inferred from
 * an ordinary principal. Admission must check actual native role/phase/storage
 * evidence; a client SQL GUC, claimed boolean, or stored configuration is no proof.
 * The deployment binding implementation is a separately reviewed prerequisite.
 */
export interface OwnerRewardGuestStudyManagedRuntime {
  readonly learning: Runtime;
  /** Explicit trusted server configuration, never request/body/hash-derived. */
  readonly purchaseSafetyMarginSeconds: unknown;
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
export interface OwnerRewardGuestStudyServingInputs {
  readonly environment: string;
  readonly enabledBinding?: string;
  readonly configurationBinding?: string;
  readonly managed?: OwnerRewardGuestStudyManagedRuntime;
  readonly accountVerifier: SessionTokenVerifier;
  readonly ordinarySessionScope: string;
  readonly hnsProtectedIngressOrigin?: string;
  readonly workerLearnerAudioBinding?: object;
}
export async function makeOwnerRewardGuestStudyServingComposition(input: OwnerRewardGuestStudyServingInputs) {
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
  // Root's COMPLETE financial assembly must retain the exact current metadata,
  // full native readiness/profile closure, and separately install actual accounting
  // handlers. This graph owns Guest Study only; it never dispatches accounting
  // names or changes their implementation declarations.
  for (const name of guestAccountingNames)
    if (!guestParticipationRegistry[name]) throw new Error("Accounting declaration missing");
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
  const starter = makeControlPlaneOwnerStudyStarter(m.learning, disclosure, policy,
    () => `guest_start_${crypto.randomUUID()}`,m.purchaseSafetyMarginSeconds);
  const ordinaryGuestMutations = makeControlPlaneOwnerStudyMutations(m.learning, {
    rawPolicy: policy,
    disclosureVersion: disclosure?.version ?? null,
    rerecordEnabled: m.rerecordEnabled,
    providerRetention: "stored",
  });
  const prepared = makeControlPlanePreparedGuestStudyContentStore(m.publicRead, disclosure);
  const rewardPrepared=makeControlPlanePreparedGuestRewardContentStore(m.publicRead,disclosure,m.purchaseSafetyMarginSeconds);
  const acceptedContinuation=makeControlPlaneOwnerSpokenCapturedContinuationStore(m.learning);
  const reward=makeControlPlaneGuestRewardStudyContinuations(m.learning,{
    submitAnswer:ordinaryGuestMutations.submitAnswer,...acceptedContinuation,
  });
  const mutations=composeGuestRewardStudyMutationMethods(ordinaryGuestMutations,reward);
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
  const learning = makeOwnerRewardGuestLearningComposition({
    authority,
    services: {
      study,
      rewardPrepared,
      participations: makeControlPlaneOwnerGuestParticipationReadStore(m.learning),
      retention: recovery.retention,
      deletion: recovery.deletion,
      deletionIo: makeOwnerLearnerAudioDeletionIo(recovery.deletion, m.bucket),
      clock: m.clock,
      ids: m.ids,
      retryAfterSeconds: m.retryAfterSeconds,
    },
  });
  return Object.freeze({
    requestAuthentication: checkedAuthentication,
    // Cron remains a distinct role/graph owned by cron composition. No browser
    // handler receives its runtime or controlled closed-checkpoint leaves.
    async handle(
      input: Omit<Parameters<typeof authority.handleAuthorityOperation>[0], "name"> & {
        readonly name: OwnerRewardGuestStudyServingName;
      },
    ) {
      await readiness.verify();
      return isAuthorityName(input.name)
        ? authority.handleAuthorityOperation({ ...input, name: input.name })
        : learning.handleLearningOperation({ ...input, name: input.name });
    },
  });
}
export type OwnerRewardGuestStudyServingComposition = NonNullable<
  Awaited<ReturnType<typeof makeOwnerRewardGuestStudyServingComposition>>
>;
