import {
  getPublicPostBySlug,
  getPublicPostCanonicalRouteById,
  getPublicPostSitemap,
  type PublicPostRouteServices,
} from "@pirate/application/use-cases/content/public-post-routes";
import { AuthError } from "@pirate/contracts";
import { Effect } from "effect";
import type { DecodedRequest, EndpointHandler, Principal } from "./transport.ts";

export type PublicPostRouteHandlers = Readonly<{
  readonly GetPublicPostBySlug: EndpointHandler;
  readonly GetPublicPostCanonicalRouteById: EndpointHandler;
  readonly GetPublicPostSitemap: EndpointHandler;
}>;

const optionalViewerUserId = (principal: Principal | null): string | undefined => {
  if (principal === null) return undefined;
  if (principal.kind !== "user" && principal.kind !== "admin") {
    throw new AuthError({ message: "Authorization failed" });
  }
  return principal.subject;
};

export function makePublicPostRouteHandlers(
  services: PublicPostRouteServices,
): PublicPostRouteHandlers {
  return {
    GetPublicPostBySlug: async (request: DecodedRequest) => {
      const query = (request.query ?? {}) as { readonly slug: string; readonly locale?: string };
      const viewerUserId = optionalViewerUserId(request.principal);
      return await Effect.runPromise(
        getPublicPostBySlug(
          {
            slug: query.slug,
            ...(query.locale === undefined ? {} : { locale: query.locale }),
            ...(viewerUserId === undefined ? {} : { viewerUserId }),
          },
          services,
        ),
      );
    },
    GetPublicPostCanonicalRouteById: async (request: DecodedRequest) => {
      const path = request.params as { readonly postId: string };
      const query = (request.query ?? {}) as { readonly locale?: string };
      const viewerUserId = optionalViewerUserId(request.principal);
      return await Effect.runPromise(
        getPublicPostCanonicalRouteById(
          {
            postId: path.postId,
            ...(query.locale === undefined ? {} : { locale: query.locale }),
            ...(viewerUserId === undefined ? {} : { viewerUserId }),
          },
          services,
        ),
      );
    },
    GetPublicPostSitemap: (request: DecodedRequest) =>
      Effect.runPromise(
        getPublicPostSitemap(
          (request.query ?? {}) as { readonly cursor?: string; readonly limit?: string },
          services,
        ),
      ),
  };
}
