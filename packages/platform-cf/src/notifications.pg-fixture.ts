import { evaluateTextModerationV2 } from "@pirate/application/text-moderation-runtime";
import { canonicalBodyHash } from "@pirate/application/use-cases/content/common";
import { canonicalTextModerationInput } from "@pirate/domain";
import { Effect } from "effect";
import { Client } from "pg";
import { makeControlPlaneCommentNavigationStore } from "./comment-navigation-repository.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import { makeControlPlaneNotificationStore } from "./notifications-repository.ts";
import {
  initializeNotificationsInboxSchema,
  type NotificationsInboxInitialization,
} from "./notifications-schema-init.pg-fixture.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneTextSubmissionStore } from "./text-submission-repository.ts";

const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
export async function withInbox(
  use: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  beforeMigration?: (admin: Client, schema: string, url: string) => Promise<() => Promise<void>>,
  initialization: NotificationsInboxInitialization = "baseline",
) {
  if (!connection) throw new Error("Postgres test URL required");
  const schema = `api_next_notifications_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: connection });
  let schemaCreated = false;
  let cleanup: (() => Promise<void>) | undefined;
  const failures: unknown[] = [];
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const url = new URL(connection);
    url.searchParams.set("options", `-c search_path=${schema}`);
    await initializeNotificationsInboxSchema({
      mode: initialization,
      admin,
      schema,
      connectionString: url.toString(),
      beforeApplicationDdl: async () => {
        cleanup = await beforeMigration?.(admin, schema, url.toString());
      },
    });
    await admin.query(`SET search_path TO "${schema}"`);
    if (initialization === "baseline") {
      // Compatibility with older behavior baselines only. An integrated
      // generated baseline already contains these objects; it is not ACL proof.
      const installed = await admin.query("SELECT to_regclass('notification_inbox') AS installed");
      if (installed.rows[0].installed === null)
        await admin.query(
          await Bun.file(
            new URL(
              "../../../db/postgres/migrations/0271_notifications_inbox.sql",
              import.meta.url,
            ),
          ).text(),
        );
      const video = await admin.query(
        "SELECT to_regprocedure('video_publication_post_id_v1(text,text)') AS installed",
      );
      if (video.rows[0].installed === null) {
        for (const candidate of [
          "0272_notifications_video_destination.sql",
          "0273_notifications_video_alias_audit.sql",
        ]) {
          await admin.query(
            await Bun.file(
              new URL(`../../../db/postgres/migrations/${candidate}`, import.meta.url),
            ).text(),
          );
        }
      }
    }
    await use(await setup(admin, url.toString()));
  } catch (error) {
    failures.push(error);
  } finally {
    if (schemaCreated) {
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await cleanup?.();
    } catch (error) {
      failures.push(error);
    }
    try {
      await admin.end();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Inbox setup/body/cleanup failed", { cause: failures[0] });
}

async function setup(admin: Client, url: string) {
  await admin.query(
    "INSERT INTO users(user_id) VALUES ('inbox-owner'),('inbox-other'),('inbox-author')",
  );
  await activatePendingPersonaFixtures(admin);
  await admin.query(
    "INSERT INTO communities(community_id,display_name,created_by_user_id,created_at,updated_at) VALUES ('inbox-community','Inbox fixture','inbox-author',now(),now())",
  );
  const personas = Object.fromEntries(
    (
      await admin.query("SELECT account_id,persona_id FROM personas WHERE is_first_persona")
    ).rows.map((row) => [row.account_id, row.persona_id as string]),
  );
  for (const account of ["inbox-author", "inbox-other", "inbox-owner"]) {
    await admin.query(
      "INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source) VALUES ($1,$2,'inbox-community','first_membership')",
      [personas[account], account],
    );
    await insertActiveCommunityMembershipFixture(admin, {
      communityId: "inbox-community",
      membershipId: `${account}-member`,
      userId: account,
    });
  }
  await admin.query(
    `INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility,body,created_at,updated_at)
    VALUES ('inbox-community','inbox-post','inbox-owner',$1,'text','published','public','Source post',now(),now())`,
    [personas["inbox-owner"]],
  );
  await admin.query(
    "INSERT INTO post_slug_aliases(post_id,slug,slug_policy_version) VALUES ('inbox-post','inbox-post','post-slug-v1')",
  );
  const runtime = makeDirectPostgresControlPlaneLayer(url);
  const store = makeControlPlaneNotificationStore(runtime);
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.scoped(effect));
  const submit = async (
    key: string,
    parent?: string,
    actor = "inbox-author",
    held = false,
    postId = "inbox-post",
    communityId = "inbox-community",
    publicationRuntime = runtime,
  ) => {
    const persona = (
      await admin.query(
        "SELECT p.persona_id FROM personas p JOIN persona_community_bindings binding USING(persona_id) WHERE p.account_id=$1 AND binding.community_id=$2 AND p.status='active'",
        [actor, communityId],
      )
    ).rows[0]?.persona_id as string | undefined;
    if (!persona) throw new Error("missing fixture persona");
    const surface = parent ? ("reply" as const) : ("comment" as const);
    const body = { idempotency_key: key, persona_id: persona, body: `Publication ${key}` };
    const requestHash = await run(
      canonicalBodyHash({
        endpoint: surface,
        community_id: communityId,
        post_id: postId,
        ...(parent ? { parent_comment_id: parent } : {}),
        body,
      }),
    );
    const writer = makeControlPlaneTextSubmissionStore(publicationRuntime);
    const input = {
      communityId,
      actor: { kind: "user" as const, userId: actor },
      personaId: persona,
      body,
      moderationInput: {
        version: "text-moderation-input-v1" as const,
        surface,
        title: null,
        body: body.body,
      },
      idempotencyKey: key,
      requestHash,
      operationId: `operation-${key}`,
      authorDeclaredRating: "general" as const,
      target: parent
        ? {
            surface: "reply" as const,
            communityId,
            postId: postId,
            parentCommentId: parent,
          }
        : { surface: "comment" as const, communityId, postId: postId },
    };
    if (held) {
      const canonical = canonicalTextModerationInput(input.moderationInput);
      if (canonical.kind !== "accepted") throw new Error("invalid fixture input");
      const moderated = await run(
        evaluateTextModerationV2({
          communityId: input.communityId,
          moderationInput: input.moderationInput,
          inputSha256: canonical.sha256,
          store: writer,
          provider: undefined,
        }),
      );
      return run(writer.commitTerminal({ ...input, evaluation: moderated.evaluation }));
    }
    return run(writer.commitPublished(input));
  };
  const publish = async (
    key: string,
    parent?: string,
    actor = "inbox-author",
    postId = "inbox-post",
  ) => {
    const outcome = await submit(key, parent, actor, false, postId);
    if (outcome.kind === "conflict" || outcome.kind === "policy-stale")
      throw new Error("unexpected publication conflict");
    const source = (
      await admin.query(
        "SELECT outbox_event_id,comment_id FROM content_publication_outbox WHERE submission_id=$1 AND event_type='comment_notification'",
        [outcome.snapshot.submission_id],
      )
    ).rows[0];
    if (!source) throw new Error("publication did not persist its notification fact");
    return { eventId: source.outbox_event_id as string, commentId: source.comment_id as string };
  };
  const seedComment = async (
    id: string,
    parent: string | null,
    depth: number,
    post = "inbox-post",
  ) => {
    await admin.query(
      `INSERT INTO comments(community_id,comment_id,post_id,parent_comment_id,author_user_id,author_persona_id,status,body,depth,created_at,updated_at)
      VALUES ('inbox-community',$1,$2,$3,'inbox-author',$4,'published',$1,$5,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')`,
      [id, post, parent, personas["inbox-author"], depth],
    );
  };
  return {
    admin,
    store,
    run,
    publish,
    submit,
    seedComment,
    runtime,
    url,
    personas,
    navigation: makeControlPlaneCommentNavigationStore(runtime),
  };
}
