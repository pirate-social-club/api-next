// PRIVATE REVIEW PROPOSAL. No route installation or declaration activation.
import { guestParticipationRegistry } from "@pirate/contracts";
import type { makeGuestAuthorityPrivateComposition } from "./guest-authority-private-composition.ts";
import {
  type GuestLearningControllerName,
  type GuestLearningControllerServices,
  makeGuestLearningControllers,
} from "./guest-learning-controllers.ts";
import type { VerifiedHnsCommunityAppApiRequest } from "./hns-community-app-api-transport.ts";
import type { DecodedRequest, EndpointHandlerResult } from "./transport.ts";

type Authority = ReturnType<typeof makeGuestAuthorityPrivateComposition>;
export function makeGuestLearningPrivateComposition(
  dependencies: Readonly<{
    authority: Authority;
    services: GuestLearningControllerServices;
  }>,
) {
  for (const declaration of Object.values(guestParticipationRegistry))
    if (declaration.implementation !== "disabled")
      throw new Error("Private guest definitions must stay disabled");
  const controllers = makeGuestLearningControllers(dependencies.services);
  return Object.freeze({
    controllers,
    /** Request-scoped private seam. The maintained decoder callback owns path,
     * query/header, JSON4096/audio524288 bounds and trusted edgeClientIp capture.
     * Root binds this callback from its actual existing transport, never body IP
     * or a raw public request header. No Hono guest handler is installed here.
     */
    async handleLearningOperation(
      input: Readonly<{
        name: GuestLearningControllerName;
        request: Request;
        verifiedHns?: VerifiedHnsCommunityAppApiRequest;
        decodeRequestLocations: () => Promise<
          Omit<DecodedRequest, "principal" | "browserParticipation">
        >;
      }>,
    ): Promise<EndpointHandlerResult> {
      const policy = guestParticipationRegistry[input.name].auth.policy;
      if (input.name === "GetPublicStudyPreparedContentV1") {
        if (policy.kind !== "public") throw new Error("Prepared content policy differs");
        // Existing transport owns current public visibility/HNS host trust.
        // No account/guest proof lookup, owner creation, CSRF/cookie issuance,
        // generation or paid provider call is introduced by this reader.
        const locations = await input.decodeRequestLocations();
        return controllers.dispatch(input.name, { ...locations, principal: null });
      }
      if (policy.kind !== "browserParticipation") throw new Error("Guest learning policy differs");
      // Actual purpose verifier/origin/CSRF/cookie-cap/proof adapter BEFORE any
      // body allocation. VerifiedHns is the actual earlier Access+MAC output.
      const context = await dependencies.authority.requestAuthentication.authenticate({
        request: input.request,
        policy,
        ...(input.verifiedHns === undefined ? {} : { verifiedHns: input.verifiedHns }),
      });
      const locations = await input.decodeRequestLocations();
      return controllers.dispatch(input.name, {
        ...locations,
        principal: null,
        browserParticipation: context,
      });
    },
    disabledDefinitions: Object.freeze(
      Object.fromEntries(
        Object.keys(guestParticipationRegistry).map((name) => [name, "disabled" as const]),
      ),
    ),
  });
}
