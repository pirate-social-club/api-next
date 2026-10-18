/** Future parent-only PG matrix. No work runs on import; no guard bypasses. */
import { expect } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { videoPublicationPostId } from "../../application/src/video/publication-identity.ts";
import {
  attachVideoDecision,
  decideOriginalAudioVideo,
  publishOriginalVideo,
} from "../../domain/src/video-submission.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture.ts";
import type { withInbox } from "./notifications.pg-fixture.ts";
import {
  runVideoAdmissionFixture,
  seedNotificationsVideoActors,
} from "./notifications-video-proof.pg-fixture.ts";
import { createActivePersonaFixture } from "./persona-wallet.pg-fixture.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresControlPlaneOptions,
  type PostgresQueryConfig,
} from "./postgres.ts";
import {
  actor,
  community,
  finalizedFixture,
  responseBytes,
  responseSha256,
  trustedAnalysis,
} from "./video-publication.pg-fixture.ts";

export type VideoMatrixFixture = Parameters<Parameters<typeof withInbox>[0]>[0];

export async function bindMatrixReaders(f: Pick<VideoMatrixFixture, "admin" | "personas">) {
  const users = ["inbox-owner", "inbox-author", "inbox-other"];
  const originalIds = users.map((user) => f.personas[user]);
  const originals = async () =>
    (
      await f.admin.query(
        "SELECT p.persona_id,p.account_id,p.status,p.is_first_persona,b.community_id,b.binding_source,b.bound_at FROM personas p JOIN persona_community_bindings b USING(persona_id) WHERE p.persona_id=ANY($1::text[]) ORDER BY p.persona_id",
        [originalIds],
      )
    ).rows;
  const before = await originals();
  expect(before).toHaveLength(users.length);
  const readers: Record<string, string> = {};
  for (const user of users) {
    const existing = await f.admin.query<{ persona_id: string }>(
      "SELECT p.persona_id FROM persona_community_bindings b JOIN personas p USING(persona_id) WHERE p.account_id=$1 AND b.community_id=$2 AND p.status='active' ORDER BY p.created_at,p.persona_id LIMIT 1",
      [user, community],
    );
    let personaId = existing.rows[0]?.persona_id;
    if (!personaId) {
      // First personas remain immutably bound to inbox-community. Additional
      // personas use the maintained wallet/profile activation protocol.
      personaId = `persona-matrix-${user}`;
      await createActivePersonaFixture(f.admin, { accountId: user, personaId });
      await f.admin.query(
        "INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source) VALUES($1,$2,$3,'persona_creation')",
        [personaId, user, community],
      );
    }
    // This is the same account/community/active selection used by f.submit.
    const selected = await f.admin.query<{ persona_id: string }>(
      "SELECT p.persona_id FROM personas p JOIN persona_community_bindings binding USING(persona_id) WHERE p.account_id=$1 AND binding.community_id=$2 AND p.status='active'",
      [user, community],
    );
    expect(selected.rows.map((row) => row.persona_id)).toContain(personaId);
    readers[user] = personaId;
    if (
      !(
        await f.admin.query(
          "SELECT 1 FROM community_memberships WHERE community_id=$1 AND user_id=$2",
          [community, user],
        )
      ).rowCount
    )
      await insertActiveCommunityMembershipFixture(f.admin, {
        communityId: community,
        userId: user,
        membershipId: `matrix-member-${user}`,
      });
  }
  expect(await originals()).toEqual(before);
  return readers;
}

export async function startMatrixActors(f: VideoMatrixFixture) {
  await seedNotificationsVideoActors(f.admin);
  await bindMatrixReaders(f);
}

/** Distinct real reservations/submissions/analyses/decisions/publications. The
 * capture/media ports retain the existing deterministic fixture limitation. */
export async function prepareMatrixVideo(f: VideoMatrixFixture, key: string, approval = false) {
  const identity = {
    reservationId: `media-reservation-${crypto.randomUUID()}`,
    submissionId: `media-submission-matrix-${key}`,
    operationId: `media-operation-matrix-${key}`,
  };
  const { store, finalized } = await finalizedFixture(f.url, null, identity);
  const base = trustedAnalysis();
  const frames = base.frames.extracted.map((frame) => ({
    ...frame,
    artifactRef: `media://derived/${identity.operationId}/${frame.role}`,
  })) as unknown as typeof base.frames.extracted;
  const analysis = {
    ...base,
    operationId: identity.operationId,
    finalizedVideoRef: `media://immutable/${identity.operationId}/video/1`,
    ...(approval ? { mediaSafety: "review_required" as const } : {}),
    frames: { ...base.frames, extracted: frames },
    safetyRequest: { ...base.safetyRequest, requestId: `matrix-safety-${identity.operationId}` },
    audio: {
      ...base.audio,
      soundtrack: {
        ...base.audio.soundtrack,
        extractedAudioRef: `media://derived/${identity.operationId}/audio`,
      },
    },
  };
  const decision = decideOriginalAudioVideo({
    state: finalized.state,
    analysis,
    canonicalCaptionSha256: null,
    decidedAt: "2026-10-17T00:00:00Z",
  });
  let ready = await store.commitAnalysisDecision({
    submission: finalized.state,
    analysis,
    decision,
    nextState: attachVideoDecision(finalized.state, analysis, decision),
  });
  if (approval) {
    await store.moderate({
      submission: ready.state,
      actor: { kind: "user", userId: actor },
      expectedCreationRevision: 1,
      action: { kind: "approve", hold: "safety", evidenceRef: null },
      endpointTemplate: "/moderation/media-post-submissions/:submissionId/actions",
      idempotencyKey: `matrix-approve-${key}`,
      requestHash: "8".repeat(64),
      responseBytes,
      responseSha256,
    });
    const next = await store.getSubmissionByOperation(identity);
    if (!next) throw new Error("Approved real video missing");
    ready = next;
  }
  const postId = await videoPublicationPostId(ready.state);
  const published = publishOriginalVideo(ready.state, postId);
  const bundle = {
    observedEventSequence: ready.eventSequence,
    ...published,
    decision: ready.state.decision ?? decision,
    poster: { artifactRef: frames[0].artifactRef, canonicalSha256: frames[0].sha256 },
    derivedArtifacts: [
      {
        artifactRef: analysis.audio.soundtrack.extractedAudioRef,
        artifactKind: "extracted_audio" as const,
        canonicalSha256: analysis.audio.soundtrack.extractedAudioSha256,
      },
      ...frames.map((frame) => ({
        artifactRef: frame.artifactRef,
        artifactKind: frame.role,
        canonicalSha256: frame.sha256,
      })),
    ],
  };
  return { ...identity, postId, bundle, publish: () => store.publish(bundle), store };
}

export async function matrixComment(
  f: VideoMatrixFixture,
  postId: string,
  key: string,
  parent?: string,
  user = "inbox-author",
) {
  const outcome = await f.submit(key, parent, user, false, postId, community);
  if (outcome.kind !== "created" && outcome.kind !== "replay")
    throw new Error("Real comment publication required");
  const facts = (
    await f.admin.query<{ comment_id: string; outbox_event_id: string }>(
      "SELECT comment_id,outbox_event_id FROM content_publication_outbox WHERE submission_id=$1 AND event_type='comment_notification'",
      [outcome.snapshot.submission_id],
    )
  ).rows;
  expect(facts).toHaveLength(1);
  const fact = facts[0];
  if (!fact) throw new Error("Existing publication fact required");
  return fact;
}

export async function matrixPlan() {
  const source = await Bun.file(
    new URL("../../../db/postgres/candidates/notifications-video-cutover.sql", import.meta.url),
  ).text();
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
  );
  return {
    source,
    plan: {
      contract_sha256: "36e74a67ee280677436ff0d7ea7d1fd6243db3dc9432645a23a2402e2d03ec19",
      plan_sha256: "a".repeat(64),
      alias_run_id: crypto.randomUUID(),
      paired_solid_sha256: "b".repeat(64), // synthetic fixture only, no Solid/runtime acceptance
      cutover_source_sha256: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
    },
  };
}

export async function prepareMatrixAdmission(f: VideoMatrixFixture) {
  const input = await matrixPlan();
  await runVideoAdmissionFixture(f.runtime, (store) =>
    Effect.gen(function* () {
      yield* store.startAudit({
        runId: input.plan.alias_run_id,
        planSha256: input.plan.plan_sha256,
        mode: "materialize",
      });
      return yield* store.auditBatch({
        runId: input.plan.alias_run_id,
        planSha256: input.plan.plan_sha256,
      });
    }),
  );
  return input;
}

export async function admitMatrix(f: VideoMatrixFixture) {
  const input = await prepareMatrixAdmission(f);
  expect(
    await runVideoAdmissionFixture(f.runtime, (store) =>
      Effect.gen(function* () {
        yield* store.drain();
        return yield* store.cutover(input.plan, input.source);
      }),
    ),
  ).toEqual({ alreadyCommitted: false });
  return input;
}

export async function matrixClient(url: string) {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    return client;
  } catch (error) {
    try {
      await client.end();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Matrix client acquisition/close failed", {
        cause: error,
      });
    }
    throw error;
  }
}

/** Hooks observe actual native operations. They never retry, substitute rows,
 * suppress failures or execute anything outside the parent-supplied fixture. */
export function matrixObservedRuntime(
  url: string,
  hooks: {
    before?: (query: PostgresQueryConfig, pid: number) => Promise<void>;
    after?: (query: PostgresQueryConfig) => Promise<void>;
  },
) {
  const options: PostgresControlPlaneOptions = {
    clientFactory: (connection, config) => {
      const client = new Client({ ...config, connectionString: connection });
      let pid = 0;
      return {
        connect: async () => {
          await client.connect();
          pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        },
        end: () => client.end(),
        query: async (query) => {
          await hooks.before?.(query, pid);
          const result = await client.query({ ...query, values: [...(query.values ?? [])] });
          await hooks.after?.(query);
          return result;
        },
      };
    },
  };
  return makeDirectPostgresControlPlaneLayer(url, options);
}

export async function matrixHistory(f: VideoMatrixFixture) {
  return (
    await f.admin.query(`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY submission_id),'[]') FROM media_post_submissions s WHERE media_kind='video') AS submissions,
    (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY submission_id,endpoint_template,idempotency_key),'[]') FROM media_submission_command_replays r) AS commands,
    (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY outbox_event_id),'[]') FROM content_publication_outbox f) AS facts,
    (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY source_event_id),'[]') FROM notification_publication_deliveries d) AS deliveries,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY notification_id),'[]') FROM notification_inbox i) AS inbox`)
  ).rows;
}

export { actor, community };
