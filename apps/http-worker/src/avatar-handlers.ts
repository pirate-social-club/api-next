import type {
  AvatarFailure,
  AvatarStorage,
  AvatarStore,
} from "@pirate/application/use-cases/avatars";
import { makeAvatarService } from "@pirate/application/use-cases/avatars";
import {
  AuthError,
  BadRequest,
  Conflict,
  FinalizeAvatarUpload,
  GetAvatar,
  InternalError,
  NotFound,
  ProviderUnavailable,
  RateLimited,
  RemoveAvatar,
  ReserveAvatarUpload,
} from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { type EndpointHandler, type Principal, withEndpointResult } from "./transport.ts";

function actor(principal: Principal | null) {
  if (!principal || (principal.kind !== "user" && principal.kind !== "admin"))
    throw new AuthError({ message: "Authentication required" });
  return principal.subject;
}
const wire = (error: AvatarFailure) => {
  switch (error.reason) {
    case "invalid":
      return new BadRequest({
        message: "Choose a valid JPEG, PNG or WebP image within the avatar limits",
      });
    case "conflict":
      return new Conflict({ message: "Avatar reservation is no longer available" });
    case "not-found":
      return new NotFound({ message: "Avatar not found" });
    case "rate-limited":
      return new RateLimited({ message: "Avatar upload limit reached" });
    case "unavailable":
      return new ProviderUnavailable({ message: "Avatar storage is unavailable" });
    case "storage":
      return new InternalError({ message: "Avatar operation failed" });
  }
};
export function makeAvatarHandlers(
  store: AvatarStore,
  storage: AvatarStorage | null,
  authoring: boolean,
): Readonly<Record<string, EndpointHandler>> {
  const requireStorage = () => {
    if (!storage) throw new ProviderUnavailable({ message: "Avatar storage is unavailable" });
    return makeAvatarService(store, storage);
  };
  const requireAuthoring = () => {
    if (!authoring) throw new ProviderUnavailable({ message: "Avatar uploads are not enabled" });
    return requireStorage();
  };
  return {
    ReserveAvatarUpload: (request) =>
      Effect.runPromise(
        requireAuthoring()
          .reserve(
            actor(request.principal),
            Schema.decodeUnknownSync(ReserveAvatarUpload.request.body)(request.body),
          )
          .pipe(Effect.mapError(wire)),
      ),
    FinalizeAvatarUpload: (request) =>
      Effect.runPromise(
        requireAuthoring()
          .finalize(
            actor(request.principal),
            Schema.decodeUnknownSync(FinalizeAvatarUpload.request.path)(request.params).assetId,
          )
          .pipe(Effect.mapError(wire)),
      ),
    GetAvatar: async (request) => {
      const { assetId } = Schema.decodeUnknownSync(GetAvatar.request.path)(request.params);
      const headers = Schema.decodeUnknownSync(GetAvatar.request.headers)(request.headers ?? {});
      const result = await Effect.runPromise(
        requireStorage().delivery(assetId, headers["if-none-match"]).pipe(Effect.mapError(wire)),
      );
      if (result.status === 200 && !result.body)
        throw new NotFound({ message: "Avatar not found" });
      return withEndpointResult(result.body, result.status, {
        etag: result.etag,
        "content-type": "image/jpeg",
      });
    },
    RemoveAvatar: async (request) => {
      if (
        request.principal?.kind !== "admin" ||
        !request.principal.scopes?.includes("avatars:moderate")
      )
        throw new AuthError({ message: "Authorization failed" });
      const { assetId } = Schema.decodeUnknownSync(RemoveAvatar.request.path)(request.params);
      await Effect.runPromise(store.remove(assetId).pipe(Effect.mapError(wire)));
      return { removed: true };
    },
  };
}
