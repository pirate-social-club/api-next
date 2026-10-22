import { expect } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import { Client } from "pg";
import type { withInbox } from "../../packages/platform-cf/src/notifications.pg-fixture.ts";

export type InboxFixture = Parameters<Parameters<typeof withInbox>[0]>[0];

/** A definer SQL function is opaque to outer EXPLAIN. Inspect its exact installed
 * body only in this owned schema, under the same owner and trusted search path.
 * Runtime callers still execute the bounded function, never this inspection. */
export async function installedNotificationRecoverySql(admin: Client, schema: string) {
  if (!/^api_next_notifications_[0-9a-f]{32}$/u.test(schema))
    throw new Error("Owned Notifications plan schema required");
  const result = await admin.query<{ body: string; trusted: boolean }>(
    `SELECT p.prosrc AS body,
      p.prosecdef AND p.provolatile='s' AND p.proretset AND p.pronargs=0
      AND p.proowner=n.nspowner AND p.proowner=current_user::regrole
      AND current_schema()=n.nspname AND language.lanname='sql'
      AND p.proconfig=ARRAY[format('search_path=%I, pg_catalog, pg_temp',n.nspname)] AS trusted
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     JOIN pg_language language ON language.oid=p.prolang
     WHERE n.nspname=$1 AND p.proname='pending_recipient_notifications_v2' AND p.pronargs=0`,
    [schema],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || row.trusted !== true)
    throw new Error("Exact installed recovery function authority required");
  return row.body;
}

/** Algorithm-only facts for the exact installed SQL: both families compete for
 * one oldest-first batch. Real table/index and delivery proof remains separate. */
export async function verifyRecoveryFamilyOrdering(admin: Client, installedSql: string) {
  for (const tied of [false, true]) {
    const epoch = "TIMESTAMPTZ '2026-10-18T00:00:00Z'";
    const commentTime = tied ? epoch : `${epoch} + n * INTERVAL '2 seconds'`;
    const danceTime = tied ? epoch : `${epoch} + (n * 2 - 1) * INTERVAL '1 second'`;
    const rows = await admin.query<{ event_id: string }>(`WITH content_publication_outbox AS (
      SELECT 'comment-'||lpad(n::text,3,'0') AS outbox_event_id,${commentTime} AS created_at,
        'comment_notification'::text AS event_type,n=0 AS inbox_delivery_recorded
      FROM generate_series(0,75) n
    ), dance_moderated_result_events_v1 AS (
      SELECT 'dance-'||lpad(n::text,3,'0') AS event_id,${danceTime} AS occurred_at,
        CASE WHEN n=0 THEN ${epoch} ELSE NULL::timestamptz END AS delivered_at
      FROM generate_series(0,75) n
    ) ${installedSql}`);
    const expected = tied
      ? Array.from({ length: 50 }, (_, index) => `comment-${String(index + 1).padStart(3, "0")}`)
      : Array.from({ length: 25 }, (_, index) => {
          const id = String(index + 1).padStart(3, "0");
          return [`dance-${id}`, `comment-${id}`];
        }).flat();
    expect(rows.rows.map((row) => row.event_id)).toEqual(expected);
  }
}

export const gate = () => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
export async function transactionClient(url: string) {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query(
      "BEGIN; SET LOCAL statement_timeout='8s'; SET LOCAL idle_in_transaction_session_timeout='10s'",
    );
    return client;
  } catch (error) {
    try {
      await client.end();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Transaction client acquisition/close failed", {
        cause: error,
      });
    }
    throw error;
  }
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
