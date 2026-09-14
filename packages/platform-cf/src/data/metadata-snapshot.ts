import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";

export type MetadataDocuments = Readonly<{
  schemaRevision: "pirate-data-metadata-v1" | "pirate-data-metadata-v2";
  ipMetadata: string;
  nftMetadata: string;
}>;
type MetadataPreparation = Readonly<{
  operationId: string;
  current: MetadataDocuments;
  legacy: MetadataDocuments;
}>;
export type MetadataSnapshotResolver = (input: MetadataPreparation) => Promise<MetadataDocuments>;

type Row = Readonly<Record<string, unknown>>;
const digest = async (document: string) => {
  const bytes = new TextEncoder().encode(document);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return {
    hash: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(""),
    length: bytes.length,
  };
};
const read = (row: Row): MetadataDocuments => {
  if (
    (row.schema_revision !== "pirate-data-metadata-v1" &&
      row.schema_revision !== "pirate-data-metadata-v2") ||
    typeof row.ip_metadata !== "string" ||
    typeof row.nft_metadata !== "string"
  ) {
    throw new Error("invalid DATA metadata preparation");
  }
  return {
    schemaRevision: row.schema_revision,
    ipMetadata: row.ip_metadata,
    nftMetadata: row.nft_metadata,
  };
};

/** One immutable pair, including when workers race or only one old artifact exists. */
export const makePostgresMetadataSnapshotResolver =
  (runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>): MetadataSnapshotResolver =>
  async (input) => {
    const current = {
      ip_metadata: await digest(input.current.ipMetadata),
      nft_metadata: await digest(input.current.nftMetadata),
    };
    const legacy = {
      ip_metadata: await digest(input.legacy.ipMetadata),
      nft_metadata: await digest(input.legacy.nftMetadata),
    };
    return Effect.runPromise(
      Effect.provide(runtime)(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction((tx) =>
            Effect.gen(function* () {
              yield* tx.execute({
                label: "data.metadata.lock",
                readonly: false,
                text: "SELECT pg_advisory_xact_lock(hashtextextended('data-metadata:' || $1,0))",
                values: [input.operationId],
              });
              const existing = yield* tx.execute<Row>({
                label: "data.metadata.read",
                readonly: true,
                text: `SELECT schema_revision,convert_from(ip_metadata_bytes,'UTF8') AS ip_metadata,
          convert_from(nft_metadata_bytes,'UTF8') AS nft_metadata FROM data_registration_metadata_snapshots
          WHERE registration_operation_id=$1`,
                values: [input.operationId],
              });
              const snapshot = existing.rows[0];
              if (snapshot !== undefined)
                return yield* Effect.try({
                  try: () => read(snapshot),
                  catch: () => new Error("invalid DATA metadata preparation"),
                });
              const artifacts = yield* tx.execute<Row>({
                label: "data.metadata.retained-artifacts",
                readonly: true,
                text: `SELECT artifact_kind,canonical_sha256,byte_length FROM data_registration_artifacts
          WHERE registration_operation_id=$1 AND artifact_kind IN ('ip_metadata','nft_metadata')`,
                values: [input.operationId],
              });
              const matches = (candidate: typeof current) =>
                artifacts.rows.every((row) => {
                  if (row.artifact_kind !== "ip_metadata" && row.artifact_kind !== "nft_metadata")
                    return false;
                  const value = candidate[row.artifact_kind];
                  return (
                    value.hash === row.canonical_sha256 &&
                    String(value.length) === String(row.byte_length)
                  );
                });
              let selected = input.current;
              if (artifacts.rows.length > 0) {
                if (matches(legacy)) selected = input.legacy;
                else if (!matches(current))
                  return yield* Effect.fail(
                    new Error("retained DATA metadata cannot be reconstructed"),
                  );
              }
              yield* tx.execute({
                label: "data.metadata.pin",
                readonly: false,
                text: `INSERT INTO data_registration_metadata_snapshots
          (registration_operation_id,schema_revision,ip_metadata_bytes,nft_metadata_bytes)
          VALUES ($1,$2,convert_to($3,'UTF8'),convert_to($4,'UTF8'))`,
                values: [
                  input.operationId,
                  selected.schemaRevision,
                  selected.ipMetadata,
                  selected.nftMetadata,
                ],
              });
              return selected;
            }),
          );
        }),
      ),
    );
  };
