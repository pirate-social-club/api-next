/** Canonical source graph. Construction alone installs/enables no endpoint. */
import type { ControlPlaneDb, ControlPlaneError } from "@pirate/application/use-cases/guest-learning";
import { guestParticipationRegistry } from "@pirate/contracts";
import { makeControlPlaneGuestAttachmentPreparation } from "@pirate/platform-cf/guest-attachment-preparation-store";
import { makeControlPlaneOwnerRecipientStores } from "@pirate/platform-cf/owner-recipient-store";
import type { Layer } from "effect";
import {
  type GuestAccountingControllerName, makeGuestAccountingControllers,
} from "./guest-accounting-controllers.ts";
import type { makeGuestAuthorityComposition } from "./guest-authority-controller-composition.ts";
import type { VerifiedHnsCommunityAppApiRequest } from "./hns-community-app-api-transport.ts";
import type { DecodedRequest, EndpointHandlerResult } from "./transport.ts";

export { isGuestAccountingControllerName, type GuestAccountingControllerName } from "./guest-accounting-controllers.ts";
export function makeGuestAccountingComposition(dependencies: Readonly<{
  authority: ReturnType<typeof makeGuestAuthorityComposition>;
  controlPlane: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>;
  retryAfterSeconds: number;
}>) {
  const prepared = makeControlPlaneGuestAttachmentPreparation(dependencies.controlPlane);
  const stores = makeControlPlaneOwnerRecipientStores(dependencies.controlPlane);
  const controllers = makeGuestAccountingControllers({
    attachment: { prepareTarget: prepared.prepareTarget, confirm: stores.attachment.confirm,
      findBoundAttachment: stores.attachment.findBoundAttachment },
    credits: stores.credits, recipients: stores.recipients, claims: { claim: stores.claims.claim },
    retryAfterSeconds: dependencies.retryAfterSeconds,
  });
  return Object.freeze({
    controllers,
    async handleAccountingOperation(input: Readonly<{
      name: GuestAccountingControllerName; request: Request;
      verifiedHns?: VerifiedHnsCommunityAppApiRequest;
      decodeRequestLocations: () => Promise<Omit<DecodedRequest, "principal" | "browserParticipation">>;
    }>): Promise<EndpointHandlerResult> {
      const originalHeaders = new Headers(input.request.headers);
      const auth = dependencies.authority.requestAuthentication;
      const verified = input.verifiedHns === undefined ? {} : { verifiedHns: input.verifiedHns };
      // Actual purpose/proofs/Origin/both CSRF gates run BEFORE body decoder/hash/store.
      if (input.name === "PrepareGuestAttachmentTargetV1" || input.name === "ConfirmGuestAttachmentTargetV1") {
        const policy = guestParticipationRegistry[input.name].auth.policy;
        if (policy.kind !== "browserParticipation" || policy.authority !== "attachment")
          throw new Error("Accounting attachment policy differs");
        const context = await auth.authenticate({ request: input.request, policy, ...verified });
        const decoded = await input.decodeRequestLocations();
        return (await controllers.dispatch(input.name, { ...decoded, principal: null, browserParticipation: context })).finalize(originalHeaders);
      }
      // Successful original attachment recovery occurs without a Guest proof gate.
      const account = await auth.authenticateOrdinaryAccount({ request: input.request,
        purpose: input.name === "GetMySuccessfulGuestAttachmentV1" ? "successful_attachment" : "ordinary_account",
        unsafe: input.name !== "GetMySuccessfulGuestAttachmentV1", ...verified });
      const decoded = await input.decodeRequestLocations();
      return (await controllers.dispatch(input.name, { ...decoded, principal: null }, account)).finalize(originalHeaders);
    },
  });
}
