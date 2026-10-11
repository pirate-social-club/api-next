import { Schema } from "effect";

const Text = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,512}$/u));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Integer = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Authority = Schema.Struct({
  operationId: Text,
  submissionId: Text,
  postId: Text,
  effectIdentity: Text,
  creator: Digest,
  sourceSha256: Digest,
  ingestRevision: Integer,
  claimFence: Integer,
  state: Schema.Literal("reconciliation_required"),
  reason: Schema.Literal("acceptance_unknown"),
  enrichmentState: Schema.Literal("failed"),
  authoritySha256: Digest,
});
const Video = Schema.Struct({
  uid: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  creator: Schema.optionalKey(Schema.String),
  meta: Schema.optionalKey(Schema.Unknown),
});
const Metadata = Schema.Struct({
  operation_id: Schema.optionalKey(Schema.String),
  source_sha256: Schema.optionalKey(Schema.String),
});
const Counted = Schema.Struct({
  videos: Schema.Array(Video).check(Schema.isMaxLength(1000)),
  total: Integer,
  range: Integer,
});
const Response = Schema.Struct({ success: Schema.Literal(true), result: Schema.Unknown });

const marker = async (operation: string) => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`pirate-video-v1:${operation}`),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
/** Uses GET only. Empty current evidence never authorizes a copy or terminal write. */
export async function inspectStreamReconciliation(
  input: Readonly<{
    readAuthority(): Promise<unknown>;
    get(path: string): Promise<unknown>;
  }>,
) {
  const before = Schema.decodeUnknownSync(Authority, { onExcessProperty: "error" })(
    await input.readAuthority(),
  );
  if (
    before.effectIdentity !== `video-enrichment:${before.operationId}:stream` ||
    before.creator !== (await marker(before.operationId))
  )
    throw new Error("Stream operator identity refused");
  const query = async (path: string) => {
    const response = Schema.decodeUnknownSync(Response)(await input.get(path));
    // The live include_counts shape is result.{videos,total,range}.
    return Schema.decodeUnknownSync(Counted)(response.result);
  };
  const creator = await query(`/stream?creator=${before.creator}&limit=1000&include_counts=true`);
  if (creator.videos.some((video) => video.creator !== before.creator))
    throw new Error("Stream creator filter refused");
  const all = await query("/stream?limit=1000&include_counts=true");
  for (const listing of [creator, all])
    if (
      listing.total !== listing.videos.length ||
      listing.range !== listing.videos.length ||
      new Set(listing.videos.map((video) => video.uid)).size !== listing.videos.length ||
      listing.videos.length >= 1000
    )
      throw new Error("Stream complete current coverage refused");
  const matches = all.videos.flatMap((video) => {
    const metadata = Schema.decodeUnknownSync(Metadata)(video.meta ?? {});
    if (
      video.creator !== before.creator &&
      metadata.operation_id !== before.operationId &&
      metadata.source_sha256 !== before.sourceSha256
    )
      return [];
    return [
      {
        uid: video.uid,
        creator_matches: video.creator === before.creator,
        operation_matches: metadata.operation_id === before.operationId,
        source_matches: metadata.source_sha256 === before.sourceSha256,
      },
    ];
  });
  const creatorIds = creator.videos.map((video) => video.uid).sort();
  const allCreatorIds = all.videos
    .filter((video) => video.creator === before.creator)
    .map((video) => video.uid)
    .sort();
  if (JSON.stringify(creatorIds) !== JSON.stringify(allCreatorIds))
    throw new Error("Stream independent current searches disagree");
  const after = Schema.decodeUnknownSync(Authority, { onExcessProperty: "error" })(
    await input.readAuthority(),
  );
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("Stream reconciliation stale authority refused");
  return {
    outcome:
      matches.length === 0
        ? ("no_matching_current_asset" as const)
        : ("matching_current_assets_require_review" as const),
    authority: before,
    creator_result_count: creator.videos.length,
    account_result_count: all.videos.length,
    complete_current_coverage: true,
    relevant_matches: matches,
    mutation: false,
    copy_allowed: false,
    historical_noncreation_proved: false,
    terminal_failure_authorized: false,
  };
}
