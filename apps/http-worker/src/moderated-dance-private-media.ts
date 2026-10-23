import { InternalError } from "@pirate/contracts";
import { Schema } from "effect";
import { CreateModeratedDanceMediaAccess } from "../../../packages/contracts/src/dance-moderated-intake.ts";
import type { makeModeratedDanceMediaAccessStore } from "../../../packages/platform-cf/src/moderated-dance-media-access.ts";
import {
  makeVideoSourceGateway,
  type VideoSourceBucket,
} from "../../../packages/platform-cf/src/video-source-gateway.ts";
import {
  authenticatePrivateBrowserMedia,
  type createHttpWorker,
  type EndpointHandler,
  type HttpWorkerOptions,
} from "./transport.ts";

type Store = ReturnType<typeof makeModeratedDanceMediaAccessStore>;

export function makeModeratedDanceMediaLeaseHandler(
  forAccount: (account: string) => Store,
  available: boolean,
): EndpointHandler {
  return async (ctx) => {
    if (!available || ctx.principal?.kind !== "user")
      throw new InternalError({ message: "Private media unavailable" });
    const path = Schema.decodeUnknownSync(CreateModeratedDanceMediaAccess.request.path, {
        onExcessProperty: "error",
      })(ctx.params),
      body = Schema.decodeUnknownSync(CreateModeratedDanceMediaAccess.request.body, {
        onExcessProperty: "error",
      })(ctx.body);
    return forAccount(ctx.principal.subject).issue(
      path.communityId,
      path.reviewId,
      body.expected_review_revision,
      body.audience,
    );
  };
}

/** A private media resource, reached ONLY by the same-origin URL in the typed
 * lease response. It reuses the existing bounded Range/R2 identity interpreter.
 * It is intentionally outside the frozen JSON/JPEG endpoint representation;
 * it neither broadens that representation nor misdeclares MP4 as JSON/JPEG.
 */
export function installModeratedDancePrivateMedia(
  input: Readonly<{
    app: ReturnType<typeof createHttpWorker>;
    authenticate: HttpWorkerOptions["authenticate"];
    forAccount: (account: string) => Store;
    bucket: VideoSourceBucket;
  }>,
) {
  for (const prefix of ["", "/api"]) {
    input.app.on(
      ["GET", "HEAD"],
      `${prefix}/communities/:communityId/dance/reviews/:reviewId/media/:leaseId`,
      async (context) => {
        const url = new URL(context.req.raw.url),
          community = context.req.param("communityId"),
          review = context.req.param("reviewId"),
          lease = context.req.param("leaseId");
        if (
          url.search !== "" ||
          url.pathname.includes("%") ||
          url.pathname !==
            `${prefix}/communities/${community}/dance/reviews/${review}/media/${lease}` ||
          !/^[A-Za-z0-9_-]{43}$/u.test(lease)
        )
          return new Response(null, {
            status: 404,
            headers: { "cache-control": "private, no-store" },
          });
        const principal = await authenticatePrivateBrowserMedia(
            context,
            input.authenticate,
            CreateModeratedDanceMediaAccess,
          ),
          store = input.forAccount(principal.subject);
        const gateway = makeVideoSourceGateway({
          bucket: input.bucket,
          now: Date.now,
          grants: {
            resolve: async (token) =>
              token === lease ? store.resolve(community, review, token, true) : null,
          },
        });
        const headers = new Headers();
        const range = context.req.raw.headers.get("range");
        if (range !== null) headers.set("range", range);
        const request = new Request(
          `https://private.invalid/.well-known/pirate/video-source/v1/${lease}`,
          { method: context.req.method, headers, signal: context.req.raw.signal },
        );
        const response = await gateway(request);
        // Recheck after storage waits too. A former owner never gets a new response
        // merely because issuance, HEAD or an earlier Range request once succeeded.
        if (response.ok && (await store.resolve(community, review, lease, false)) === null) {
          await response.body?.cancel();
          return new Response(null, {
            status: 404,
            headers: { "cache-control": "private, no-store" },
          });
        }
        const finalHeaders = new Headers(response.headers);
        finalHeaders.set("cache-control", "private, no-store");
        finalHeaders.set("x-content-type-options", "nosniff");
        finalHeaders.set("cross-origin-resource-policy", "same-origin");
        finalHeaders.set("referrer-policy", "no-referrer");
        return new Response(response.body, { status: response.status, headers: finalHeaders });
      },
    );
  }
}
