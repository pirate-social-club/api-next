import { Effect } from "effect";
import type { AvatarStorage, AvatarStore, AvatarUploadInput } from "../avatars/ports.ts";

export function makeAvatarService(store: AvatarStore, storage: AvatarStorage) {
  return {
    reserve: Effect.fn("avatars.reserve")(function* (ownerId: string, input: AvatarUploadInput) {
      const asset = yield* store.reserve(ownerId, input);
      const upload = yield* storage.presign(asset);
      return {
        asset_id: asset.assetId,
        upload_url: upload.url,
        required_headers: upload.requiredHeaders,
        expires_at: asset.uploadExpiresAt,
      };
    }),
    finalize: Effect.fn("avatars.finalize")(function* (ownerId: string, assetId: string) {
      yield* store.finalize(ownerId, assetId, storage.seal);
      return { asset_id: assetId, status: "ready" as const };
    }),
    delivery: Effect.fn("avatars.delivery")(function* (assetId: string, etag?: string) {
      const asset = yield* store.delivery(assetId);
      const tag = `"${asset.digest}"`;
      if (etag === tag) return { status: 304 as const, body: null, etag: tag };
      const body = yield* storage.read(asset.key);
      return { status: 200 as const, body, etag: tag };
    }),
    remove: store.remove,
    cleanup: () => store.cleanup(storage.delete),
  };
}

export type { AvatarStorage, AvatarStore } from "../avatars/ports.ts";
export { AvatarFailure } from "../avatars/ports.ts";
