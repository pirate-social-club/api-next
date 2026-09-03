import {
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  type PublicSongOwnerPolicyV1,
  type SongOwnerPolicyManagementV1,
  type UpdateSongOwnerPolicyV1,
} from "@pirate/contracts";
import { Context, Data, Effect, type Schema } from "effect";
import type { ControlPlaneError } from "./ports.ts";

export type SongOwnerPolicyManagement = Schema.Schema.Type<typeof SongOwnerPolicyManagementV1>;
export type PublicSongOwnerPolicy = Schema.Schema.Type<typeof PublicSongOwnerPolicyV1>;
export type SongOwnerPolicyUpdate = Schema.Schema.Type<typeof UpdateSongOwnerPolicyV1>;

export type SongOwnerPolicyStoreOperation = "get-management" | "update" | "get-public";
export type SongOwnerPolicyStoreReason =
  | "not-found"
  | "conflict"
  | "invalid-persona"
  | "invalid-row";

export class SongOwnerPolicyStoreError extends Data.TaggedError("SongOwnerPolicyStoreError")<{
  readonly operation: SongOwnerPolicyStoreOperation;
  readonly reason: SongOwnerPolicyStoreReason;
}> {}

export type SongOwnerPolicyStoreFailure = SongOwnerPolicyStoreError | ControlPlaneError;

export interface SongOwnerPolicyStoreService {
  readonly getManagement: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly accountId: string;
    readonly personaId: string;
  }) => Effect.Effect<SongOwnerPolicyManagement, SongOwnerPolicyStoreFailure>;
  readonly update: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly accountId: string;
    readonly update: SongOwnerPolicyUpdate;
  }) => Effect.Effect<SongOwnerPolicyManagement, SongOwnerPolicyStoreFailure>;
  readonly getPublic: (input: {
    readonly communityId: string;
    readonly postId: string;
    readonly accountId: string | null;
    readonly personaId: string | null;
  }) => Effect.Effect<PublicSongOwnerPolicy, SongOwnerPolicyStoreFailure>;
}

export class SongOwnerPolicyStore extends Context.Service<
  SongOwnerPolicyStore,
  SongOwnerPolicyStoreService
>()("SongOwnerPolicyStore") {}

const validIdentifier = (value: string): boolean =>
  value.length > 0 && value.length <= 128 && value === value.trim() && !value.includes("\u0000");

const mapFailure = (
  failure: SongOwnerPolicyStoreFailure,
  operation: SongOwnerPolicyStoreOperation,
): BadRequest | Conflict | InternalError | NotFound => {
  if (!(failure instanceof SongOwnerPolicyStoreError)) {
    return new InternalError({ message: "Song owner policy store operation failed" });
  }
  switch (failure.reason) {
    case "not-found":
    case "invalid-persona":
      return new NotFound({ message: "Song owner policy not found" });
    case "conflict":
      return new Conflict({
        message: "Song owner policy has changed",
        details: { reason_code: "owner_policy_revision_stale" },
      });
    case "invalid-row":
      return new InternalError({
        message: `Song owner policy ${operation} returned an invalid row`,
      });
  }
};

export const getSongOwnerPolicy = Effect.fn("getSongOwnerPolicy")(function* (
  input: Readonly<{
    readonly communityId: string;
    readonly postId: string;
    readonly accountId: string;
    readonly personaId: string;
  }>,
  services: { readonly store: SongOwnerPolicyStoreService },
) {
  if (
    !validIdentifier(input.communityId) ||
    !validIdentifier(input.postId) ||
    !validIdentifier(input.accountId) ||
    !validIdentifier(input.personaId)
  ) {
    return yield* new BadRequest({ message: "Invalid song owner policy request" });
  }
  return yield* services.store
    .getManagement(input)
    .pipe(Effect.mapError((failure) => mapFailure(failure, "get-management")));
});

export const updateSongOwnerPolicy = Effect.fn("updateSongOwnerPolicy")(function* (
  input: Readonly<{
    readonly communityId: string;
    readonly postId: string;
    readonly accountId: string;
    readonly update: SongOwnerPolicyUpdate;
  }>,
  services: { readonly store: SongOwnerPolicyStoreService },
) {
  if (
    !validIdentifier(input.communityId) ||
    !validIdentifier(input.postId) ||
    !validIdentifier(input.accountId)
  ) {
    return yield* new BadRequest({ message: "Invalid song owner policy request" });
  }
  return yield* services.store
    .update(input)
    .pipe(Effect.mapError((failure) => mapFailure(failure, "update")));
});

export const getPublicSongOwnerPolicy = Effect.fn("getPublicSongOwnerPolicy")(function* (
  input: Readonly<{
    readonly communityId: string;
    readonly postId: string;
    readonly accountId: string | null;
    readonly personaId: string | null;
  }>,
  services: { readonly store: SongOwnerPolicyStoreService },
) {
  if (!validIdentifier(input.communityId) || !validIdentifier(input.postId)) {
    return yield* new BadRequest({ message: "Invalid song owner policy request" });
  }
  if (
    (input.accountId !== null && !validIdentifier(input.accountId)) ||
    (input.personaId !== null && !validIdentifier(input.personaId))
  ) {
    return yield* new BadRequest({ message: "Invalid song owner policy request" });
  }
  return yield* services.store
    .getPublic(input)
    .pipe(Effect.mapError((failure) => mapFailure(failure, "get-public")));
});

export type GetSongOwnerPolicyInput = Parameters<typeof getSongOwnerPolicy>[0];
export type GetSongOwnerPolicyResponse = Schema.Schema.Type<typeof SongOwnerPolicyManagementV1>;
export type GetPublicSongOwnerPolicyResponse = Schema.Schema.Type<typeof PublicSongOwnerPolicyV1>;
export type UpdateSongOwnerPolicyResponse = Schema.Schema.Type<typeof SongOwnerPolicyManagementV1>;
