import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import {
  type HnsCommunityPublicationQueue,
  HnsCommunityRootImportStorageFailed,
} from "@pirate/application/namespace-ownership";
import { Effect, type Layer, Option, Schema } from "effect";

const Claim = Schema.Struct({
  actor_id: Schema.String,
  community_id: Schema.String,
  root_import_session_id: Schema.String,
  idempotency_key: Schema.String,
  expected_revision: Schema.Number,
  fence: Schema.Number,
  authorized: Schema.Boolean,
});
export function makeHnsCommunityPublicationQueue(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): HnsCommunityPublicationQueue {
  const provide = <A>(effect: Effect.Effect<A, unknown, ControlPlaneDb>) =>
    effect.pipe(
      Effect.provide(runtime),
      // Same reason as the root-import store: keep the control-plane error so
      // the boundary can name the statement that failed.
      Effect.mapError((error) => new HnsCommunityRootImportStorageFailed({ cause: error })),
    );
  return {
    enqueue: (input) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              const allowed = yield* tx.execute({
                label: "hns.publication.authorize",
                text: `SELECT s.root_import_session_id FROM hns_root_import_sessions s
            JOIN communities c ON c.community_id=s.community_id
            JOIN users u ON u.user_id=s.actor_id
            WHERE s.root_import_session_id=$1 AND s.actor_id=$2 AND s.community_id=$3
              AND s.revision=$4 AND s.status='awaiting_owner_update'
              AND s.expires_at>clock_timestamp() AND s.origin_kind='community_attachment'
              AND c.status='active' AND u.status='active'
              AND has_community_route_authority(s.community_id,s.actor_id)
            FOR UPDATE OF s`,
                values: [
                  input.root_import_session_id,
                  input.actor_id,
                  input.community_id,
                  input.expected_revision,
                ],
                readonly: false,
              });
              if (allowed.rowCount !== 1) return false;
              yield* tx.execute({
                label: "hns.publication.enqueue",
                text: `INSERT INTO hns_community_publication_jobs
            (root_import_session_id,actor_id,community_id,expected_revision,idempotency_key)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
                values: [
                  input.root_import_session_id,
                  input.actor_id,
                  input.community_id,
                  input.expected_revision,
                  input.idempotency_key,
                ],
                readonly: false,
              });
              const retained = yield* tx.execute({
                label: "hns.publication.replay",
                text: `SELECT root_import_session_id FROM hns_community_publication_jobs
            WHERE root_import_session_id=$1 AND actor_id=$2 AND community_id=$3
              AND expected_revision=$4 AND state IN ('pending','leased')`,
                values: [
                  input.root_import_session_id,
                  input.actor_id,
                  input.community_id,
                  input.expected_revision,
                ],
                readonly: true,
              });
              return retained.rowCount === 1;
            }),
          );
        }),
      ),
    claim: () =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const rows = yield* db.execute({
            label: "hns.publication.claim",
            text: `WITH due AS (
          SELECT root_import_session_id FROM hns_community_publication_jobs
          WHERE (state='pending' AND next_attempt_at<=clock_timestamp())
             OR (state='leased' AND lease_expires_at<=clock_timestamp())
          ORDER BY next_attempt_at,root_import_session_id FOR UPDATE SKIP LOCKED LIMIT 1
        ), leased AS (
          UPDATE hns_community_publication_jobs j SET state='leased',fence_token=fence_token+1,
            lease_expires_at=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp()
          FROM due WHERE j.root_import_session_id=due.root_import_session_id RETURNING j.*
        ) SELECT j.actor_id,j.community_id,j.root_import_session_id,j.idempotency_key,
          j.expected_revision::integer,j.fence_token::integer AS fence,
          (s.expires_at>clock_timestamp() AND c.status='active' AND u.status='active'
            AND has_community_route_authority(j.community_id,j.actor_id)) AS authorized
          FROM leased j JOIN hns_root_import_sessions s USING(root_import_session_id)
          JOIN communities c ON c.community_id=j.community_id JOIN users u ON u.user_id=j.actor_id`,
            values: [],
            readonly: false,
          });
          if (rows.rows.length === 0) return null;
          const decoded = Schema.decodeUnknownOption(Claim)(rows.rows[0]);
          if (Option.isNone(decoded)) return yield* new HnsCommunityRootImportStorageFailed({});
          const { fence, authorized, ...input } = decoded.value;
          return { input, fence, authorized };
        }),
      ),
    settle: (claim, state, failure) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.execute({
            label: "hns.publication.settle",
            text: `UPDATE hns_community_publication_jobs SET state=$3,failure_code=$4,
          next_attempt_at=clock_timestamp()+interval '30 seconds',lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE root_import_session_id=$1 AND fence_token=$2 AND state='leased'
            AND lease_expires_at>clock_timestamp()`,
            values: [claim.input.root_import_session_id, claim.fence, state, failure],
            readonly: false,
          });
        }),
      ),
  };
}
