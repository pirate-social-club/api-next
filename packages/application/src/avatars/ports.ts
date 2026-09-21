import type { AvatarContentType, AvatarPurpose, ReserveAvatarUpload } from "@pirate/contracts";
import { Data, type Effect, type Schema } from "effect";

export class AvatarFailure extends Data.TaggedError("AvatarFailure")<{
  readonly reason:
    | "invalid"
    | "not-found"
    | "conflict"
    | "rate-limited"
    | "unavailable"
    | "storage";
}> {}
export type AvatarReservation = Readonly<{
  assetId: string;
  ownerId: string;
  purpose: Schema.Schema.Type<typeof AvatarPurpose>;
  contentType: Schema.Schema.Type<typeof AvatarContentType>;
  byteLength: number;
  ingressKey: string;
  sealedKey: string;
  uploadExpiresAt: string;
}>;
export type AvatarUploadInput = Schema.Schema.Type<typeof ReserveAvatarUpload.request.body>;
export type NormalizedAvatar = Readonly<{
  digest: string;
  width: number;
  height: number;
  byteLength: number;
}>;
export interface AvatarStorage {
  readonly presign: (
    asset: AvatarReservation,
  ) => Effect.Effect<
    { url: string; requiredHeaders: readonly { name: string; value: string }[] },
    AvatarFailure
  >;
  readonly seal: (asset: AvatarReservation) => Effect.Effect<NormalizedAvatar, AvatarFailure>;
  readonly read: (key: string) => Effect.Effect<ReadableStream<Uint8Array> | null, AvatarFailure>;
  readonly delete: (key: string) => Effect.Effect<void, AvatarFailure>;
}
export interface AvatarStore {
  readonly reserve: (
    ownerId: string,
    input: AvatarUploadInput,
  ) => Effect.Effect<AvatarReservation, AvatarFailure>;
  /** Holds the row lock through sealing and readiness, serializing cleanup and retries. */
  readonly finalize: (
    ownerId: string,
    assetId: string,
    seal: AvatarStorage["seal"],
  ) => Effect.Effect<void, AvatarFailure>;
  readonly delivery: (
    assetId: string,
  ) => Effect.Effect<{ key: string; digest: string }, AvatarFailure>;
  readonly remove: (assetId: string) => Effect.Effect<void, AvatarFailure>;
  readonly cleanup: (
    deleteObject: AvatarStorage["delete"],
  ) => Effect.Effect<{ removed: number; failed: number }, AvatarFailure>;
}
