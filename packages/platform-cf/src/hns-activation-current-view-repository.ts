import {
  ControlPlaneDb,
  type ControlPlaneError,
  type HnsActivationCurrentViewIdentityV1,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

/**
 * The activation gatherer's database half: one read of the operation's
 * authoritative identity — root, revision, generation and the effective
 * generation-bound encoded-resource digest. It runs in its own scope and is
 * released before any chain read, so no transaction is held across a provider
 * call.
 */

type Row = Readonly<Record<string, unknown>>;

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function makeControlPlaneHnsActivationCurrentViewIdentityRead(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): (
  rootImportSessionId: string,
) => Effect.Effect<HnsActivationCurrentViewIdentityV1 | null, ControlPlaneError> {
  return (rootImportSessionId) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "hns.activation-current-view.identity",
        text: `SELECT root_label, revision, generation, plan_encoded_resource_sha256
                 FROM hns_root_import_lifecycle
                WHERE root_import_session_id=$1`,
        values: [rootImportSessionId],
        readonly: true,
      });
      const row = result.rows[0];
      if (result.rows.length !== 1 || row === undefined) return null;
      const revision = positiveInteger(row.revision);
      const generation = positiveInteger(row.generation);
      if (typeof row.root_label !== "string" || revision === null || generation === null) {
        throw new Error("HNS activation current-view identity is invalid");
      }
      const digest =
        typeof row.plan_encoded_resource_sha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(row.plan_encoded_resource_sha256)
          ? row.plan_encoded_resource_sha256
          : null;
      return {
        root_label: row.root_label,
        lifecycle_revision: revision,
        lifecycle_generation: generation,
        plan_encoded_resource_sha256: digest,
      };
    }).pipe(Effect.provide(runtime));
}
