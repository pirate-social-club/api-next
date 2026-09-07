import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import type { VideoSubmissionRecord } from "@pirate/application/video/publication";
import { Effect, type Layer } from "effect";

type SourceHead = Readonly<{
  etag: string;
  version: string;
  size: number;
  httpMetadata?: Readonly<{ contentType?: string }>;
  checksums?: Readonly<{ sha256?: ArrayBuffer }>;
}>;

/** The digest comes from the immutable seal; HEAD verifies that exact sealed object still exists. */
export function makeVideoSealedSourceVerifier(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  head: (reference: string) => Promise<SourceHead | null>,
) {
  return async (record: VideoSubmissionRecord): Promise<void> => {
    const source = record.state.video;
    if (source === null) throw new Error("video source is not sealed");
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.execute<{
          etag: string;
          object_version: string;
          canonical_sha256: string;
          size_bytes: number | string;
          content_type: string;
        }>({
          label: "video-source.verify-seal",
          readonly: true,
          text: `SELECT i.etag,i.object_version,i.canonical_sha256,i.size_bytes,i.content_type
          FROM media_video_revisions v JOIN media_immutable_objects i ON i.immutable_ref=v.immutable_ref
          WHERE v.submission_id=$1 AND v.operation_id=$2 AND v.video_revision=$3
            AND v.immutable_ref=$4 AND v.canonical_sha256=$5`,
          values: [
            record.state.submissionId,
            record.state.operationId,
            record.state.videoRevision,
            source.immutableRef,
            source.canonicalSha256,
          ],
        });
      }).pipe(Effect.provide(runtime)),
    );
    const seal = rows.rows[0];
    if (
      rows.rows.length !== 1 ||
      seal === undefined ||
      seal.canonical_sha256 !== source.canonicalSha256 ||
      Number(seal.size_bytes) !== source.sizeBytes ||
      seal.content_type !== source.contentType
    )
      throw new Error("video seal authority mismatch");
    const object = await head(source.immutableRef);
    if (
      object === null ||
      object.etag !== seal.etag ||
      object.version !== seal.object_version ||
      object.size !== source.sizeBytes ||
      object.httpMetadata?.contentType !== source.contentType
    )
      throw new Error("video sealed source identity mismatch");
    if (object.checksums?.sha256 !== undefined) {
      const digest = Array.from(new Uint8Array(object.checksums.sha256), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== source.canonicalSha256) throw new Error("video sealed source digest mismatch");
    }
  };
}
