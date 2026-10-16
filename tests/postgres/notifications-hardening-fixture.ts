import {
  ControlPlaneDb,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import { Client } from "pg";
import type { withInbox } from "../../packages/platform-cf/src/notifications.pg-fixture.ts";

export type InboxFixture = Parameters<Parameters<typeof withInbox>[0]>[0];
export const gate = () => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
export async function transactionClient(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(
    "BEGIN; SET LOCAL statement_timeout='8s'; SET LOCAL idle_in_transaction_session_timeout='10s'",
  );
  return client;
}
export function pinnedRuntime(
  client: Client,
  hook: (label: string) => Promise<void> = async () => undefined,
) {
  const execute: ControlPlaneDb["Service"]["execute"] = <Row>(statement: ControlPlaneStatement) =>
    Effect.tryPromise({
      try: async () => {
        await hook(statement.label);
        const result = await client.query(statement.text, [...statement.values]);
        return { rows: result.rows as readonly Row[], rowCount: result.rowCount ?? 0 };
      },
      catch: () =>
        new ControlPlaneStatementFailed({
          label: statement.label,
          sqlState: null,
          constraint: null,
          outcomeCertainty: "aborted",
        }),
    });
  return Layer.succeed(ControlPlaneDb, { execute, withTransaction: (use) => use({ execute }) });
}
export async function seedScaleHistory(f: InboxFixture, count: number) {
  // Plan-only population derives from a real publication, retains all guards,
  // and does not substitute for the real producer/replay acceptance tests.
  await f.publish("scale-template");
  await f.admin.query(
    "INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,body,created_at,updated_at) VALUES ('inbox-community','scale-other-post','inbox-other',$1,'text','published','public','Body',now(),now())",
    [f.personas["inbox-other"]],
  );
  await f.admin.query(
    "INSERT INTO post_slug_aliases(post_id,slug,slug_policy_version) VALUES ('scale-other-post','scale-other-post','post-slug-v1')",
  );
  const columns = (
    await f.admin.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='text_content_submissions' AND is_generated='NEVER' ORDER BY ordinal_position",
    )
  ).rows
    .map((row) => `"${row.column_name}"`)
    .join(",");
  await f.admin.query(
    `INSERT INTO comments(community_id,comment_id,post_id,author_user_id,author_persona_id,status,body,depth,created_at,updated_at)
    SELECT 'inbox-community','scale-comment-'||n,CASE WHEN n%2=0 THEN 'inbox-post' ELSE 'scale-other-post' END,'inbox-author',$1,'published','Scale body',0,
      '2026-10-01'::timestamptz+n*interval '1 second',now() FROM generate_series(1,$2::int) n`,
    [f.personas["inbox-author"], count],
  );
  await f.admin.query(
    `INSERT INTO text_content_submissions (${columns})
    SELECT ${columns
      .split(",")
      .map((column) => `record.${column}`)
      .join(",")} FROM text_content_submissions template CROSS JOIN generate_series(1,$1::int) n
    CROSS JOIN LATERAL (SELECT jsonb_build_object('submission_id','scale-submission-'||n,'operation_id','scale-operation-'||n,
      'idempotency_key','scale-key-'||n,'published_comment_id','scale-comment-'||n,'target_post_id',CASE WHEN n%2=0 THEN 'inbox-post' ELSE 'scale-other-post' END) AS replacement) x
    CROSS JOIN LATERAL jsonb_populate_record(NULL::text_content_submissions,to_jsonb(template)||x.replacement||
      jsonb_build_object('response_snapshot_bytes',to_jsonb(convert_to((convert_from(template.response_snapshot_bytes,'UTF8')::jsonb||x.replacement)::text,'UTF8')),
        'response_snapshot_sha256',encode(sha256(convert_to((convert_from(template.response_snapshot_bytes,'UTF8')::jsonb||x.replacement)::text,'UTF8')),'hex'))) record
    WHERE template.idempotency_key='scale-template'`,
    [count],
  );
  await f.admin.query(
    `INSERT INTO content_publication_outbox(outbox_event_id,community_id,submission_id,comment_id,event_type,effect_key,payload,created_at)
    SELECT 'scale-event-'||n,'inbox-community','scale-submission-'||n,'scale-comment-'||n,'comment_notification',
      'scale-submission-'||n||':comment_notification',jsonb_build_object('comment_id','scale-comment-'||n,'parent_comment_id',NULL),
      '2026-10-01'::timestamptz+n*interval '1 second' FROM generate_series(1,$1::int) n`,
    [count],
  );
}
