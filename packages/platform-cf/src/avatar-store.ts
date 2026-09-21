import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import {
  AvatarFailure,
  type AvatarReservation,
  type AvatarStore,
} from "@pirate/application/avatars/ports";
import { Effect, type Layer } from "effect";

type Row = {
  asset_id: string;
  owner_account_id: string;
  purpose: AvatarReservation["purpose"];
  content_type: AvatarReservation["contentType"];
  byte_length: number;
  ingress_key: string;
  sealed_key: string;
  upload_expires_at: Date;
  state: string;
  expired: boolean;
  digest: string;
  moderation_status: string;
};
const reservation = (row: Row): AvatarReservation => ({
  assetId: row.asset_id,
  ownerId: row.owner_account_id,
  purpose: row.purpose,
  contentType: row.content_type,
  byteLength: row.byte_length,
  ingressKey: row.ingress_key,
  sealedKey: row.sealed_key,
  uploadExpiresAt: row.upload_expires_at.toISOString(),
});
const fail = (reason: AvatarFailure["reason"]) => new AvatarFailure({ reason });
const mapFailure = (error: unknown) => (error instanceof AvatarFailure ? error : fail("storage"));

export function makeAvatarStoreFromDb(db: ControlPlaneDb["Service"]): AvatarStore {
  return {
    reserve: (ownerId, input) =>
      db
        .withTransaction((transaction) =>
          Effect.gen(function* () {
            // Serialize each account's quota check and insertion, including different keys.
            yield* transaction.execute({
              label: "avatars.reserve.lock",
              text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 90194))",
              values: [ownerId],
              readonly: false,
            });
            const prior = yield* transaction.execute<Row>({
              label: "avatars.reserve.replay",
              text: "SELECT *, upload_expires_at <= clock_timestamp() AS expired FROM avatar_assets WHERE owner_account_id=$1 AND idempotency_key=$2 FOR UPDATE",
              values: [ownerId, input.idempotency_key],
              readonly: false,
            });
            const existing = prior.rows[0];
            if (existing) {
              if (
                existing.purpose !== input.purpose ||
                existing.content_type !== input.content_type ||
                existing.byte_length !== input.byte_length ||
                existing.state !== "reserved" ||
                existing.expired
              )
                return yield* fail("conflict");
              return reservation(existing);
            }
            const count = yield* transaction.execute<{ count: string }>({
              label: "avatars.reserve.quota",
              text: "SELECT count(*)::text AS count FROM avatar_assets WHERE owner_account_id=$1 AND created_at > clock_timestamp() - interval '24 hours'",
              values: [ownerId],
              readonly: true,
            });
            if (Number(count.rows[0]?.count ?? 20) >= 20) return yield* fail("rate-limited");
            const id = `avatar-${crypto.randomUUID()}`;
            const result = yield* transaction.execute<Row>({
              label: "avatars.reserve.insert",
              text: `INSERT INTO avatar_assets(asset_id, owner_account_id, purpose, idempotency_key, content_type, byte_length, ingress_key, sealed_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
              values: [
                id,
                ownerId,
                input.purpose,
                input.idempotency_key,
                input.content_type,
                input.byte_length,
                `ingress/${id}`,
                `sealed/${id}.jpg`,
              ],
              readonly: false,
            });
            const row = result.rows[0];
            if (!row) return yield* fail("storage");
            return reservation(row);
          }),
        )
        .pipe(Effect.mapError(mapFailure)),
    finalize: (ownerId, assetId, seal) =>
      db
        .withTransaction((transaction) =>
          Effect.gen(function* () {
            const result = yield* transaction.execute<Row>({
              label: "avatars.finalize.lock",
              text: "SELECT *, expires_at <= clock_timestamp() AS expired FROM avatar_assets WHERE asset_id=$1 AND owner_account_id=$2 FOR UPDATE",
              values: [assetId, ownerId],
              readonly: false,
            });
            const row = result.rows[0];
            if (!row) return yield* fail("not-found");
            if (row.moderation_status === "removed") return yield* fail("not-found");
            if (row.state === "ready" || row.state === "attached") return;
            if (row.state !== "reserved" || row.expired) return yield* fail("conflict");
            const image = yield* seal(reservation(row));
            const ready = yield* transaction.execute({
              label: "avatars.finalize.ready",
              text: "UPDATE avatar_assets SET state='ready', digest=$2, width=$3, height=$4, normalized_bytes=$5 WHERE asset_id=$1 AND expires_at > clock_timestamp()",
              values: [assetId, image.digest, image.width, image.height, image.byteLength],
              readonly: false,
            });
            if (ready.rowCount !== 1) return yield* fail("conflict");
          }),
        )
        .pipe(Effect.mapError(mapFailure)),
    delivery: (assetId) =>
      Effect.gen(function* () {
        const result = yield* db.execute<Row>({
          label: "avatars.delivery",
          text: "SELECT sealed_key, digest FROM avatar_assets WHERE asset_id=$1 AND state='attached' AND moderation_status='unscanned'",
          values: [assetId],
          readonly: true,
        });
        const row = result.rows[0];
        if (!row) return yield* fail("not-found");
        return { key: row.sealed_key, digest: row.digest };
      }).pipe(Effect.mapError(mapFailure)),
    remove: (assetId) =>
      Effect.gen(function* () {
        const result = yield* db.execute({
          label: "avatars.remove",
          text: "UPDATE avatar_assets SET moderation_status='removed', state='deleting', next_cleanup_at=GREATEST(clock_timestamp(),upload_expires_at + interval '1 minute') WHERE asset_id=$1 AND state <> 'removed'",
          values: [assetId],
          readonly: false,
        });
        if (result.rowCount === 0) {
          const prior = yield* db.execute({
            label: "avatars.remove.replay",
            text: "SELECT 1 FROM avatar_assets WHERE asset_id=$1 AND state='removed'",
            values: [assetId],
            readonly: true,
          });
          if (prior.rowCount === 0) return yield* fail("not-found");
        }
      }).pipe(Effect.mapError(mapFailure)),
    cleanup: (deleteObject) =>
      db
        .withTransaction((transaction) =>
          Effect.gen(function* () {
            const result = yield* transaction.execute<Row>({
              label: "avatars.cleanup.lock",
              text: `SELECT * FROM avatar_assets WHERE next_cleanup_at <= clock_timestamp() AND (state='deleting' OR (state IN ('reserved','ready') AND expires_at <= clock_timestamp()) OR state='attached') ORDER BY next_cleanup_at LIMIT 3 FOR UPDATE SKIP LOCKED`,
              values: [],
              readonly: false,
            });
            let completed = 0;
            for (const row of result.rows) {
              const deleted = yield* Effect.gen(function* () {
                yield* deleteObject(row.ingress_key);
                if (row.state !== "attached") yield* deleteObject(row.sealed_key);
                return true;
              }).pipe(Effect.catch(() => Effect.succeed(false)));
              yield* transaction.execute({
                label: "avatars.cleanup.result",
                text: `UPDATE avatar_assets SET state=CASE WHEN $2 AND state <> 'attached' THEN 'removed' ELSE state END, cleanup_attempts=cleanup_attempts+1, next_cleanup_at=CASE WHEN $2 THEN 'infinity'::timestamptz ELSE clock_timestamp()+interval '1 hour' END WHERE asset_id=$1`,
                values: [row.asset_id, deleted],
                readonly: false,
              });
              if (deleted) completed++;
            }
            return { removed: completed, failed: result.rows.length - completed };
          }),
        )
        .pipe(Effect.mapError(mapFailure)),
  };
}

export function makeAvatarStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
): AvatarStore {
  const use = <A>(run: (store: AvatarStore) => Effect.Effect<A, AvatarFailure>) =>
    Effect.gen(function* () {
      return yield* run(makeAvatarStoreFromDb(yield* ControlPlaneDb));
    }).pipe(Effect.provide(runtime), Effect.mapError(mapFailure));
  return {
    reserve: (owner, input) => use((store) => store.reserve(owner, input)),
    finalize: (owner, id, seal) => use((store) => store.finalize(owner, id, seal)),
    delivery: (id) => use((store) => store.delivery(id)),
    remove: (id) => use((store) => store.remove(id)),
    cleanup: (remove) => use((store) => store.cleanup(remove)),
  };
}
