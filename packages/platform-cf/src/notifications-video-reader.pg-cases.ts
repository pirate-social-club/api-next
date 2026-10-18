/** Real producer/shared-reader lifecycle and statement-snapshot proofs. Writer UNRUN. */
import { describe, expect, test } from "bun:test";
import type { HomeFeedDocument, LocalizedPostDocument } from "@pirate/application";
import { Client } from "pg";
import { makeControlPlaneContentStore } from "./content-repository.ts";
import { makeControlPlaneFeedStore } from "./feed-repository.ts";
import { withInbox } from "./notifications.pg-fixture.ts";
import { prepareNotificationSongVideo } from "./notifications-song-video.pg-fixture.ts";
import {
  bindMatrixReaders,
  community,
  matrixHistory,
  prepareMatrixVideo,
  startMatrixActors,
  type VideoMatrixFixture,
} from "./notifications-video-matrix.pg-fixture.ts";
import { readyNotificationVideoForReaders } from "./notifications-video-publication-test-fixture.ts";
import { waitForMatrixSnapshots } from "./notifications-video-race.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import type { PublicVideoPostProjection } from "./video-post-projection.ts";

function readerSnapshot(url: string, key: string) {
  let backendResolve: (pid: number) => void = () => undefined;
  let backendReject: (error: unknown) => void = () => undefined;
  const backend = new Promise<number>((resolve, reject) => {
    backendResolve = resolve;
    backendReject = reject;
  });
  let statements = 0;
  const runtime = makeDirectPostgresControlPlaneLayer(url, {
    clientFactory: (connection, config) => {
      const client = new Client({ ...config, connectionString: connection });
      return {
        connect: async () => {
          try {
            await client.connect();
            const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
              .rows[0]?.pid;
            if (pid === undefined || !Number.isInteger(pid) || pid <= 0)
              throw new Error("Real reader backend required");
            backendResolve(pid);
          } catch (error) {
            backendReject(error);
            throw error;
          }
        },
        end: () => client.end(),
        query: async (query) => {
          const projection =
            query.text.includes("AS video_origin_author_persona_id") &&
            query.text.includes("AS video_song_author_persona_id");
          if (!projection) return client.query({ ...query, values: [...(query.values ?? [])] });
          statements += 1;
          const values = [...(query.values ?? []), key];
          return client.query({
            text: `WITH reader_snapshot_barrier AS MATERIALIZED (
            SELECT pg_advisory_xact_lock_shared($${values.length}::bigint) AS held,1 AS token
          ) SELECT actual.* FROM reader_snapshot_barrier CROSS JOIN LATERAL
            (${query.text} OFFSET (reader_snapshot_barrier.token-1)) actual`,
            values,
          });
        },
      };
    },
  });
  return { runtime, backend, statements: () => statements };
}

function feedVideo(document: HomeFeedDocument, postId: string) {
  const item = document.items.find((item) => "post" in item && item.post.post.id === postId);
  if (!item || !("post" in item) || !item.post.video)
    throw new Error("Produced ready video missing from feed");
  expect(item.post).not.toHaveProperty("canonical_path");
  expect(item.post.video.playback.status).toBe("ready");
  return item.post.video;
}
function postVideo(document: LocalizedPostDocument | null, postId: string) {
  if (!document || !("post" in document) || !document.video)
    throw new Error("Produced ready video missing from GetPost");
  expect(document.post.id).toBe(postId);
  return document.video;
}
function readers(f: VideoMatrixFixture, postId: string, runtime = f.runtime) {
  const feed = makeControlPlaneFeedStore(runtime);
  const content = makeControlPlaneContentStore(runtime);
  return {
    publicFeed: () => f.run(feed.listHome({ query: { sort: "new" } })),
    authenticatedFeed: () =>
      f.run(feed.listHome({ query: { sort: "new" }, viewerUserId: "inbox-owner" })),
    post: () =>
      f.run(content.getPost({ communityId: community, postId, viewerUserId: "inbox-owner" })),
  };
}

export function registerVideoReaderPostgresCases(completed: () => void) {
  const suite = process.env.CONTROL_PLANE_POSTGRES_TEST_URL ? describe : describe.skip;
  suite("produced video shared feed/GetPost current author privacy", () => {
    for (const intent of ["original_audio", "song_reference"] as const)
      for (const change of ["account-erasure", "persona-suspension"] as const)
        test(`${intent}/${change}: active snapshot then redacted shared readers retain facts and omit canonical metadata`, async () => {
          await withInbox(async (f) => {
            let postId: string;
            let soundtrackPostId: string;
            if (intent === "song_reference") {
              const video = await prepareNotificationSongVideo(f, false);
              await bindMatrixReaders(f);
              await video.publish();
              postId = video.postId;
              soundtrackPostId = video.songPostId;
            } else {
              await startMatrixActors(f);
              const video = await prepareMatrixVideo(f, `shared-reader-${change}`);
              await video.publish();
              postId = video.postId;
              soundtrackPostId = postId;
            }
            await readyNotificationVideoForReaders(f, postId);
            expect(
              (
                await f.admin.query(
                  "SELECT slug,post_id,slug_policy_version FROM post_slug_aliases WHERE post_id=$1",
                  [postId],
                )
              ).rows,
            ).toEqual([
              { slug: postId, post_id: postId, slug_policy_version: "video-receipt-exact-v1" },
            ]);
            const author = (
              await f.admin.query<{
                author_persona_id: string;
                author_user_id: string;
                title: string | null;
              }>("SELECT author_persona_id,author_user_id,title FROM posts WHERE post_id=$1", [
                soundtrackPostId,
              ])
            ).rows[0];
            if (!author?.author_persona_id || !author.author_user_id)
              throw new Error("Active authoritative soundtrack author required");
            const original = (
              await f.admin.query<{ original_sound_id: string | null }>(
                "SELECT original_sound_id FROM media_publication_projections WHERE post_id=$1",
                [postId],
              )
            ).rows[0];
            const expected = (persona: string | null): PublicVideoPostProjection["soundtrack"] => {
              if (intent === "original_audio") {
                if (!original?.original_sound_id)
                  throw new Error("Real original sound association required");
                return {
                  kind: "original_audio",
                  original_sound_id: original.original_sound_id,
                  origin_video_post_id: postId,
                  origin_author_persona_id: persona,
                };
              }
              if (!author.title) throw new Error("Real song title required");
              return {
                kind: "song_reference",
                render_mode: "canonical_replace",
                song_reference: {
                  song_post_id: soundtrackPostId,
                  song_title: author.title,
                  song_author_persona_id: persona,
                },
              };
            };
            const fresh = readers(f, postId);
            const active = await Promise.all([
              fresh.publicFeed(),
              fresh.authenticatedFeed(),
              fresh.post(),
            ]);
            for (const video of [
              feedVideo(active[0], postId),
              feedVideo(active[1], postId),
              postVideo(active[2], postId),
            ])
              expect(video.soundtrack).toEqual(expected(author.author_persona_id));
            const history = await matrixHistory(f);
            const alias = (await f.admin.query("SELECT * FROM post_slug_aliases ORDER BY slug"))
              .rows;
            const locker = new Client({ connectionString: f.url }),
              writer = new Client({ connectionString: f.url });
            const key = BigInt(
              `0x${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
            ).toString();
            const gates = [
              readerSnapshot(f.url, key),
              readerSnapshot(f.url, key),
              readerSnapshot(f.url, key),
            ] as const;
            const settle = <A>(promise: Promise<A>) =>
              promise.then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error }),
              );
            const startPending = () =>
              [
                settle(readers(f, postId, gates[0].runtime).publicFeed()),
                settle(readers(f, postId, gates[1].runtime).authenticatedFeed()),
                settle(readers(f, postId, gates[2].runtime).post()),
              ] as const;
            let pending: ReturnType<typeof startPending> | undefined;
            let lockerConnected = false,
              writerConnected = false;
            let failed = false;
            let primary: unknown;
            const cleanup: unknown[] = [];
            try {
              await locker.connect();
              lockerConnected = true;
              await writer.connect();
              writerConnected = true;
              await locker.query("BEGIN");
              await locker.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
              pending = startPending();
              const pids = await Promise.all(gates.map((gate) => gate.backend));
              expect(new Set(pids).size).toBe(3);
              await waitForMatrixSnapshots(f.admin, pids);
              await writer.query("BEGIN");
              if (change === "account-erasure")
                await writer.query("UPDATE users SET status='deleted' WHERE user_id=$1", [
                  author.author_user_id,
                ]);
              else
                await writer.query("UPDATE personas SET status='suspended' WHERE persona_id=$1", [
                  author.author_persona_id,
                ]);
              await writer.query("COMMIT");
              await locker.query("COMMIT");
              const held = await Promise.all(pending);
              if (!held[0].ok) throw held[0].error;
              if (!held[1].ok) throw held[1].error;
              if (!held[2].ok) throw held[2].error;
              for (const video of [
                feedVideo(held[0].value, postId),
                feedVideo(held[1].value, postId),
                postVideo(held[2].value, postId),
              ])
                expect(video.soundtrack).toEqual(expected(author.author_persona_id));
              expect(gates.map((gate) => gate.statements())).toEqual([1, 1, 1]);
              const current = await Promise.all([
                fresh.publicFeed(),
                fresh.authenticatedFeed(),
                fresh.post(),
              ]);
              for (const video of [
                feedVideo(current[0], postId),
                feedVideo(current[1], postId),
                postVideo(current[2], postId),
              ])
                expect(video.soundtrack).toEqual(expected(null));
              expect(
                (
                  await f.admin.query(
                    "SELECT author_persona_id,author_user_id,title FROM posts WHERE post_id=$1",
                    [soundtrackPostId],
                  )
                ).rows,
              ).toEqual([author]);
              expect(
                (await f.admin.query("SELECT * FROM post_slug_aliases ORDER BY slug")).rows,
              ).toEqual(alias);
              expect(await matrixHistory(f)).toEqual(history);
            } catch (error) {
              failed = true;
              primary = error;
            } finally {
              for (const client of [
                lockerConnected ? locker : undefined,
                writerConnected ? writer : undefined,
              ]) {
                if (!client) continue;
                try {
                  await client.query("ROLLBACK");
                } catch (error) {
                  cleanup.push(error);
                }
              }
              const results = pending ? await Promise.all(pending) : [];
              for (const result of results) if (!result.ok) cleanup.push(result.error);
              for (const client of [locker, writer]) {
                try {
                  await client.end();
                } catch (error) {
                  cleanup.push(error);
                }
              }
            }
            if (failed && cleanup.length)
              throw new AggregateError([primary, ...cleanup], "Reader proof and cleanup failed", {
                cause: primary,
              });
            if (failed) throw primary;
            if (cleanup.length) throw new AggregateError(cleanup, "Reader proof cleanup failed");
          });
          completed();
        }, 120000);
  });
}
