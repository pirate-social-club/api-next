#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { Effect, Schema } from "effect";
import { ControlPlaneDb } from "../packages/application/src/index.ts";
import { makeReadOnlyPostgresControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";
import { inspectStreamReconciliation } from "../packages/platform-cf/src/video-stream-reconciliation-inspect.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";

const account = "08a4c22cf52e2ecae883e36f80a33f4a";
const Verification = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    status: Schema.Literal("active"),
    id: Schema.String,
    expires_on: Schema.optionalKey(Schema.String),
    not_before: Schema.optionalKey(Schema.String),
  }),
});

/** Read-only, accepted-master scope. No copy, claim, adoption or terminal-write port. */
export async function main(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: { operation: { type: "string" } },
  });
  if (!values.operation || !/^media-operation-[a-f0-9-]{36}$/u.test(values.operation))
    throw new Error("exact operation required");
  const raw = process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  const token = process.env.VIDEO_STREAM_API_TOKEN;
  if (!raw || !token || /\s/u.test(token)) throw new Error("scoped staging credentials required");
  const runtime = makeReadOnlyPostgresControlPlaneLayer(normalizePostgresConnectionString(raw), {
    logger: { info: () => {}, error: () => {} },
  });
  const readAuthority = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const session = yield* db.execute<{ role: string; schema: string; read_only: string }>({
          label: "video-cleanup.stream-staging-role",
          readonly: true,
          values: [],
          text: `SELECT current_user AS role,current_schema() AS schema,
        current_setting('transaction_read_only') AS read_only`,
        });
        if (
          session.rows[0]?.role !== "pscale_api_gy9lze83nr29" ||
          session.rows[0]?.schema !== "api_next" ||
          session.rows[0]?.read_only !== "on"
        )
          throw new Error("read-only staging role/schema refused");
        const result = yield* db.execute({
          label: "video-cleanup.stream-accepted-master-authority",
          readonly: true,
          values: [values.operation],
          text: `SELECT
        o.operation_id AS "operationId",o.submission_id AS "submissionId",o.post_id AS "postId",
        o.effect_identity AS "effectIdentity",s.creator_marker AS creator,
        m.master_sha256 AS "sourceSha256",s.ingest_revision::float8 AS "ingestRevision",
        s.claim_fence::float8 AS "claimFence",s.state,s.failure_reason AS reason,
        o.state AS "enrichmentState",
        encode(sha256(convert_to(jsonb_build_array(to_jsonb(o),to_jsonb(s),to_jsonb(p),
            to_jsonb(r),to_jsonb(a),to_jsonb(m),(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.capability_sha256)
            FROM media_video_source_grants g WHERE g.request_id=o.operation_id AND g.consumer='stream'))::text,
          'UTF8')),'hex') AS "authoritySha256"
        FROM media_video_enrichment_outbox o
        JOIN media_video_stream_ingests s ON s.operation_id=o.operation_id
        JOIN media_publication_projections p ON p.operation_id=o.operation_id
          AND p.submission_id=o.submission_id AND p.post_id=o.post_id AND p.media_kind='video'
        JOIN media_video_rights r ON r.submission_id=p.submission_id AND r.rights_basis='derivative'
        JOIN media_song_video_accepted_masters a ON a.plan_id=p.song_video_plan_id
          AND a.master_revision_id=p.song_video_master_revision_id
        JOIN media_song_video_masters m ON m.master_revision_id=a.master_revision_id
          AND m.plan_id=a.plan_id AND m.verified_object_key=p.video_asset_ref
          AND m.master_sha256=p.canonical_video_sha256 AND s.source_sha256=m.master_sha256
        WHERE o.operation_id=$1 AND o.enrichment_kind='stream' AND s.provider_video_id IS NULL`,
        });
        if (result.rows.length !== 1) throw new Error("exact accepted-master authority refused");
        return result.rows[0];
      }).pipe(Effect.provide(runtime)),
    );
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (response.status !== 200 || !response.body) throw new Error("provider GET unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 2097152) throw new Error("provider body bound refused");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  // Refuse the exact database authority before contacting the provider.
  await readAuthority();
  const verified = Schema.decodeUnknownSync(Verification)(await get("/tokens/verify")).result;
  for (const [date, before] of [
    [verified.not_before, true],
    [verified.expires_on, false],
  ] as const) {
    if (date === undefined) continue;
    const parsed = Date.parse(date);
    if (!Number.isFinite(parsed) || (before ? parsed > Date.now() : parsed <= Date.now()))
      throw new Error("active provider credential window refused");
  }
  const result = await inspectStreamReconciliation({ readAuthority, get });
  console.log(
    JSON.stringify({
      account,
      observed_at: new Date().toISOString(),
      token: {
        status: verified.status,
        id: verified.id,
        expires_on: verified.expires_on,
        not_before: verified.not_before,
        fingerprint_sha256: createHash("sha256").update(token).digest("hex"),
      },
      ...result,
    }),
  );
}
if (import.meta.main)
  main(process.argv.slice(2)).catch(() => {
    console.error(
      JSON.stringify({ outcome: "inspection_refused_or_unavailable", mutation: false }),
    );
    process.exitCode = 1;
  });
