// Canonical controller graph. Construction never installs or enables a route.
import type {
  ControlPlaneDb,
  ControlPlaneError,
  GuestResourceAdmissionPolicy,
} from "@pirate/application/use-cases/guest-learning";
import { GuestStudyPreparedContentV1, guestParticipationRegistry } from "@pirate/contracts";
import { makeControlPlaneGuestAttachmentPreparation } from "@pirate/platform-cf/guest-attachment-preparation-store";
import { makeControlPlaneGuestAuthorityTransitions } from "@pirate/platform-cf/guest-authority-store";
import { makeControlPlaneGuestProofAuthority } from "@pirate/platform-cf/guest-proof-verifier";
import type { SessionTokenVerifier } from "@pirate/platform-cf/session-tokens";
import { type Layer, Schema } from "effect";
import {
  type GuestAuthorityControllerName,
  makeGuestAuthorityControllers,
} from "./guest-authority-controllers.ts";
import { makeGuestBrowserRequestAuthenticator } from "./guest-browser-request-authentication.ts";
import type { VerifiedHnsCommunityAppApiRequest } from "./hns-community-app-api-transport.ts";
import type { DecodedRequest, EndpointHandlerResult } from "./transport.ts";

export const guestLearningNames = [
  "GetPublicStudyPreparedContentV1",
  "GetGuestAuthorityV1",
  "IssueGuestBootstrapV1",
  "ConfirmGuestBootstrapV1",
  "RenewGuestAuthorityV1",
  "RotateGuestCredentialV1",
  "AcknowledgeGuestCredentialV1",
  "CleanupGuestBrowserProofV1",
  "StartGuestStudySessionV1",
  "GetGuestStudyStartOperationV1",
  "GetGuestStudySessionV1",
  "SubmitGuestStudyAnswerV1",
  "ListGuestParticipationsV1",
  "SetGuestLearningRetentionV1",
  "DeleteGuestLearnerAudioV1",
  "CreateGuestAttachmentIntentV1",
] as const satisfies readonly (keyof typeof guestParticipationRegistry)[];
export const guestAccountingNames = [
  "PrepareGuestAttachmentTargetV1",
  "ConfirmGuestAttachmentTargetV1",
  "GetMySuccessfulGuestAttachmentV1",
  "SelectOwnerRewardCreditRecipientV1",
  "ClaimOwnerRewardCreditV1",
] as const;

export interface GuestAuthorityCompositionDependencies {
  readonly controlPlane: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
  readonly accountVerifier: SessionTokenVerifier;
  readonly ordinarySessionScope: string;
  readonly ordinaryProductOrigin: string;
  readonly hnsProtectedIngressOrigin?: string;
  readonly nowMilliseconds: () => number;
  readonly retryAfterSeconds: number;
  /** Explicit current reviewed policy; absent policy supplies no paid capability. */
  readonly currentResourcePolicy: GuestResourceAdmissionPolicy | null;
  readonly disclosure: GuestStudyPreparedContentV1["disclosure"] | null;
  /** Trusted ingress adapter, never a raw body/header supplied privilege flag. */
  readonly trustedEdgeForRequest: (
    request: Request,
  ) => Promise<Readonly<{ kind: "trusted_edge"; fingerprint: string }> | null>;
}

export function makeGuestAuthorityComposition(dependencies: GuestAuthorityCompositionDependencies) {
  if (dependencies.disclosure !== null)
    Schema.decodeUnknownSync(GuestStudyPreparedContentV1.fields.disclosure, {
      onExcessProperty: "error",
    })(dependencies.disclosure);
  const proof = makeControlPlaneGuestProofAuthority(dependencies.controlPlane);
  const authority = makeControlPlaneGuestAuthorityTransitions(dependencies.controlPlane);
  const attachment = makeControlPlaneGuestAttachmentPreparation(dependencies.controlPlane);
  const requestAuthentication = makeGuestBrowserRequestAuthenticator({
    verifier: proof.verifier,
    isLearningLeaseActive: proof.isLearningLeaseActive,
    accountVerifier: dependencies.accountVerifier,
    ordinarySessionScope: dependencies.ordinarySessionScope,
    ordinaryProductOrigin: dependencies.ordinaryProductOrigin,
    ...(dependencies.hnsProtectedIngressOrigin === undefined
      ? {}
      : { hnsProtectedIngressOrigin: dependencies.hnsProtectedIngressOrigin }),
  });
  const controllers = makeGuestAuthorityControllers({
    authority,
    intent: { createIntent: attachment.createIntent }, // Target prepare/confirm stays unexposed.
    nowMilliseconds: dependencies.nowMilliseconds,
    retryAfterSeconds: dependencies.retryAfterSeconds,
  });
  return Object.freeze({
    requestAuthentication,
    controllers,
    /** Private integration seam only. The Worker installs no route for it.
     * The existing exact endpoint decoder callback must enforce body/header/path
     * bounds and is invoked only after authentication. Raw headers stay local.
     */
    async handleAuthorityOperation(
      input: Readonly<{
        name: GuestAuthorityControllerName;
        request: Request;
        verifiedHns?: VerifiedHnsCommunityAppApiRequest;
        decodeRequestLocations: () => Promise<
          Omit<DecodedRequest, "principal" | "browserParticipation">
        >;
      }>,
    ): Promise<EndpointHandlerResult> {
      const originalHeaders = new Headers(input.request.headers);
      const policy = guestParticipationRegistry[input.name].auth.policy;
      if (policy.kind !== "browserParticipation")
        throw new Error("Guest controller policy differs");
      const context = await requestAuthentication.authenticate({
        request: input.request,
        policy,
        ...(input.verifiedHns === undefined ? {} : { verifiedHns: input.verifiedHns }),
      });
      const decoded = await input.decodeRequestLocations();
      const plan = await controllers.dispatch(input.name, {
        ...decoded,
        principal: null,
        browserParticipation: context,
      });
      return plan.finalize(originalHeaders);
    },
  });
}
