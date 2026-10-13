// Serving-capable source only. Absent managed admission is disabled; production is refused.
import {
  type Clock,
  type ControlPlaneDb,
  type ControlPlaneError,
  type IdGen,
  makeOwnerGuestStudyService,
  makeOwnerSpokenSuccessProtocol,
} from "@pirate/application";
import { guestParticipationRegistry } from "@pirate/contracts";
import type { SessionTokenVerifier } from "@pirate/platform-cf/session-tokens";
import { makeControlPlanePreparedGuestStudyContentStore } from "@pirate/platform-cf/guest-prepared-study-content-store";
import { makeControlPlaneGuestPracticeParticipationReadStore } from "@pirate/platform-cf/guest-practice-participation-read-store";
import { makeGuestRecoveryAudioDeletionStores } from "@pirate/platform-cf/guest-recovery-deletion-store";
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
import { makeControlPlaneStudyV2Store } from "@pirate/platform-cf/study-v2-repository";
import type { Layer } from "effect";
import {
  guestAccountingNames,
  guestLearningNames,
  makeGuestAuthorityComposition,
} from "./guest-authority-controller-composition.ts";
import type { GuestAuthorityControllerName } from "./guest-authority-controllers.ts";
import type { GuestLearningControllerName } from "./guest-learning-controllers.ts";
import { makeGuestLearningComposition } from "./guest-learning-controller-composition.ts";
import { readGuestStudyRuntimeConfiguration } from "./guest-study-runtime-configuration.ts";

export type GuestStudyServingName = GuestAuthorityControllerName | GuestLearningControllerName;
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
  return (guestLearningNames as readonly string[]).includes(name);
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
  /** Fail closed unless three DISTINCT real LOGIN roles satisfy the reviewed
   * exact catalogue-column / controlled-leaf / closed-cron ACL contracts and
   * current positive native phase + schema ledger + original storage producer closure.
   * Must not install grants, apply migrations, probe provider billing, or mutate files.
   */
  readonly verifyReadiness: () => Promise<void>;
}
export interface GuestStudyServingInputs {
  readonly environment: string;
  readonly enabledBinding?: string;
  readonly configurationBinding?: string;
  readonly managed?: GuestStudyManagedRuntime;
  readonly accountVerifier: SessionTokenVerifier;
  readonly ordinarySessionScope: string;
  readonly hnsProtectedIngressOrigin?: string;
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
  for (const name of guestAccountingNames)
    if (guestParticipationRegistry[name].implementation !== "disabled")
      throw new Error("Guest accounting declarations must remain disabled");
  const m = input.managed;
  await m.verifyReadiness();
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
    requestAuthentication: authority.requestAuthentication,
    // Cron remains a distinct role/graph owned by cron composition. No browser
    // handler receives its runtime or controlled closed-checkpoint leaves.
    async handle(
      input: Omit<Parameters<typeof authority.handleAuthorityOperation>[0], "name"> & {
        readonly name: GuestStudyServingName;
      },
    ) {
      return isAuthorityName(input.name)
        ? authority.handleAuthorityOperation({ ...input, name: input.name })
        : learning.handleLearningOperation({ ...input, name: input.name });
    },
  });
}
export type GuestStudyServingComposition = NonNullable<
  Awaited<ReturnType<typeof makeGuestStudyServingComposition>>
>;
