import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";

/**
 * The verifier's read of an hns-txt-import-v1 publication authorization.
 *
 * `authorize_hns_root_import_publication_poll_v1` returns a row only when the
 * actor, community, canonical root, namespace session, upstream session
 * reference, challenge digest and plan digest all match the immutable
 * authorization written with the plan, the lifecycle generation is current,
 * the phase permits a publication check, and database time is before both the
 * snapshotted and the current publication deadline. Anything else is a denial.
 */
export type HnsImportPublicationAuthorizationInput = Readonly<{
  readonly actor_id: string;
  readonly community_id: string;
  readonly root_label: string;
  readonly namespace_session_id: string;
  readonly upstream_session_ref: string;
  readonly challenge_value_sha256: string;
  readonly publish_plan_sha256: string;
}>;

export type HnsImportPublicationAuthorization = Readonly<{
  readonly root_import_session_id: string;
  readonly root_label: string;
  readonly valid_until: string;
}>;

export class HnsImportPublicationAuthorizationUnavailable extends Error {
  override readonly name = "HnsImportPublicationAuthorizationUnavailable";
}

function instant(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

export function makeControlPlaneHnsImportPublicationAuthorizer(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): (
  input: HnsImportPublicationAuthorizationInput,
) => Promise<HnsImportPublicationAuthorization | null> {
  return (input) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Record<string, unknown>>({
          label: "hns.import-publication.authorize-poll",
          text: `SELECT root_import_session_id, root_label, valid_until
                   FROM authorize_hns_root_import_publication_poll_v1($1,$2,$3,$4,$5,$6,$7)`,
          values: [
            input.actor_id,
            input.community_id,
            input.root_label,
            input.namespace_session_id,
            input.upstream_session_ref,
            input.challenge_value_sha256,
            input.publish_plan_sha256,
          ],
          readonly: true,
        });
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        const validUntil = instant(row?.valid_until);
        if (
          result.rows.length !== 1 ||
          typeof row?.root_import_session_id !== "string" ||
          typeof row.root_label !== "string" ||
          validUntil === null
        ) {
          return yield* Effect.fail(new HnsImportPublicationAuthorizationUnavailable());
        }
        return {
          root_import_session_id: row.root_import_session_id,
          root_label: row.root_label,
          valid_until: validUntil,
        };
      }).pipe(
        Effect.provide(runtime),
        Effect.mapError(() => new HnsImportPublicationAuthorizationUnavailable()),
      ),
    );
}
