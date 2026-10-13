/** Real native rewarded Guest producer fixture. No outside SQL overlay or
 * inserted positive Guest session/attempt/qualification/share/credit row. */
import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import type { GuestLearningAccess, StudyBatchTranscriber } from "@pirate/application";
import {
  Clock,
  IdGen,
  makeOwnerGuestStudyService,
  makeOwnerSpokenSuccessProtocol,
} from "@pirate/application";
import { makeOwnerGuestSpokenClosedRecovery } from "@pirate/application/owner-guest-spoken-closed-recovery";
import type { OwnerStudyInvokingTranscriber } from "@pirate/application/owner-guest-study-service";
import { GuestRewardTermsV1, GuestSha256V1, GuestStudySessionV1 } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneAccountOwnerRewardHooks } from "./account-owner-reward-hooks.ts";
import { makeControlledAccountSpokenComposition } from "./controlled-account-spoken-composition.ts";
import { makeControlPlanePreparedGuestStudyContentStore } from "./guest-prepared-study-content-store.ts";
import { makeControlPlanePreparedGuestRewardContentStore } from "./guest-reward-prepared-content-store.ts";
import { makeOriginalAccountStudySourceControl } from "./owner-account-source-control.ts";
import { makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores } from "./owner-guest-spoken-checkpoint-recovery-store.ts";
import { makeOwnerGuestSpokenDispatchContextStore } from "./owner-guest-spoken-dispatch-context.ts";
import { makeOwnerGuestStudyPublicVisibilityStore } from "./owner-guest-study-public-visibility.ts";
import {
  composeGuestRewardCapturedContinuation,
  composeGuestRewardStudyMutationMethods,
  makeControlPlaneGuestRewardStudyContinuations,
} from "./owner-reward-study-continuation.ts";
import { type ArchiveFixture, archiveFixture } from "./owner-spoken-archive.pg-fixture.ts";
import { makeControlPlaneOwnerSpokenPreArchiveCheckpointStore } from "./owner-spoken-checkpoint-store.ts";
import { makeOwnerSpokenFencedArchiveStage } from "./owner-spoken-fenced-archive.ts";
import {
  makeControlPlaneOwnerSpokenCapturedContinuationStore,
  makeControlPlaneOwnerStudyMutations,
} from "./owner-study-mutations.ts";
import {
  disclosure,
  hash,
  pgUrl,
  policy,
  q,
  run,
  seedGuest,
} from "./owner-study-starter.pg-fixture.ts";
import { makeControlPlaneOwnerStudyStarter } from "./owner-study-starter.ts";
import { composeOwnerAwareStudyV2Store } from "./owner-study-store-composition.ts";
import { makeDirectPostgresControlPlaneLayer, type PostgresClientFactory } from "./postgres.ts";
import { makeControlPlaneStudyV2Store } from "./study-v2-repository.ts";

const decode = <S extends Schema.ConstraintDecoder<unknown>>(s: S, v: unknown): S["Type"] =>
  Schema.decodeUnknownSync(s, { onExcessProperty: "error" })(v);
const controlled = [
  "read_guest_reward_start_terms_v1(text,text,bigint,bigint,text,integer)",
  "read_guest_reward_prepared_content_v1(text,text,text,integer)",
  "reserve_guest_prepared_study_start_v1(jsonb,jsonb,text,text,text,text,text,text,jsonb,text)",
  "prepare_guest_study_start_v1(jsonb,jsonb,text,text,text,text,text,jsonb)",
  "commit_guest_study_start_with_rewards_v1(jsonb,jsonb,text,text,text,text,text,jsonb,jsonb,jsonb,text,text,text,text,boolean,text,jsonb,integer)",
  "read_owner_guest_answer_source_v1(jsonb,text,text,text)",
  "read_owner_guest_spoken_dispatch_context_v1(jsonb,text,text,text,text)",
  "read_owner_guest_answer_operation_v1(jsonb,text,jsonb,text,text,text,integer)",
  "reserve_guest_spoken_answer_v1(jsonb,jsonb,text,jsonb,text,bigint,jsonb,text,boolean,text,text,text)",
  "fail_guest_spoken_answer_v1(text,jsonb,text,text,text,text,text)",
  "persist_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb)",
  "read_owner_guest_spoken_success_v1(jsonb,jsonb,text,text)",
  "read_owner_guest_spoken_capture_v1(jsonb,jsonb,text,text)",
  "acknowledge_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb,text,bigint)",
  "resolve_guest_audio_io_capture_private_v1(jsonb,jsonb,text,text,bigint,text)",
  "claim_guest_audio_io_private_v1(jsonb)",
  "settle_guest_audio_io_private_v1(jsonb,text,boolean)",
  "list_guest_spoken_closed_recovery_v1(integer)",
  "read_guest_spoken_closed_recovery_v1(text)",
  "find_owner_guest_spoken_success_for_audio_v1(jsonb,text,text,text,text,integer,text,text,integer,integer)",
  "prepare_owner_guest_reward_spoken_v1(jsonb,jsonb,text,text)",
  "apply_owner_guest_reward_spoken_v1(jsonb,jsonb,text,jsonb,jsonb,jsonb,jsonb,jsonb,text)",
  "finish_owner_guest_reward_spoken_v1(jsonb,jsonb,text,jsonb,jsonb,jsonb,jsonb,text)",
  "resume_owner_guest_reward_spoken_hold_v1(jsonb,jsonb,text,text)",
  "find_guest_reward_spoken_hold_v1(jsonb,jsonb,text)",
  "prepare_guest_reward_spoken_hold_v1(text,jsonb,text,text,text,bytea,integer)",
] as const;
const financialTables = [
  "owner_participation_admission_operations",
  "owner_participation_admission_attempts",
  "megapot_owner_shares",
  "megapot_owner_snapshot_leaves",
  "megapot_owner_allocations",
  "reward_credit_persona_bindings",
  "reward_credit_recipient_selections",
  "owner_accounting_native_source_inventory_v1",
] as const;
const source = { communityId: "study-community", postId: "study-post" } as const;
const defaultSafetyMarginSeconds = 120;

async function within<A>(p: Promise<A>, label: string, ms = 5000): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Owned ${label} deadline`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type Service = ReturnType<typeof makeOwnerGuestStudyService>;
export type RewardedFixture = ArchiveFixture & {
  adminRuntime: ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
  guestRuntime: ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
  study: Service;
  preview: ReturnType<typeof makeControlPlanePreparedGuestRewardContentStore>;
  providerCalls: () => number;
  putCalls: () => number;
  objects: Map<string, Uint8Array>;
  servicesFor: (clientFactory?: PostgresClientFactory) => {
    study: Service;
    closedRecovery: ReturnType<typeof makeOwnerGuestSpokenClosedRecovery>;
    browser: ReturnType<typeof makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores>["browser"];
  };
  startGuest: (
    serial: number,
    key: string,
  ) => Promise<{ access: GuestLearningAccess; session: GuestStudySessionV1 }>;
  completeAccount: (
    input: Readonly<{ personaId: string; postId: string; sessionId: string; rewarded: boolean }>,
  ) => Promise<{
    sessionId: string;
    providerCalls: number;
    putCalls: number;
  }>;
  completeGuest: (
    serial: number,
    key: string,
  ) => Promise<{ access: GuestLearningAccess; session: GuestStudySessionV1 }>;
};

export async function rewardedFixture(
  use: (f: RewardedFixture) => Promise<void>,
  options: Readonly<{ ownedResetNamespace?: true; purchaseSafetyMarginSeconds?: number }> = {},
) {
  const safetyMarginSeconds = options.purchaseSafetyMarginSeconds ?? defaultSafetyMarginSeconds;
  await archiveFixture(
    async (f) => {
      // Preserve every financial source/owed ledger row until Root physically
      // tears down this owned app and PostgreSQL; no business DROP/delete.
      f.deferDestructiveCleanup();
      expect(
        (
          await f.admin.query(`SELECT head.owner_account_id,head.audio_revision::text,
      revision.policy_revision::text,revision.third_party_reward_legs,revision.pool_leg,
      revision.derivative_video,head.current_policy_hash=revision.policy_hash AS exact_hash
      FROM song_owner_policies head JOIN song_owner_policy_revisions revision
      ON revision.community_id=head.community_id AND revision.post_id=head.post_id
      AND revision.policy_revision=head.current_policy_revision
      WHERE head.community_id='study-community' AND head.post_id='study-post'`)
        ).rows,
      ).toEqual([
        {
          owner_account_id: "study-account",
          audio_revision: "1",
          policy_revision: "1",
          third_party_reward_legs: "allowed",
          pool_leg: "allowed",
          derivative_video: "allowed",
          exact_hash: true,
        },
      ]);
      expect(
        (
          await f.admin.query(`SELECT trigger.tgenabled FROM pg_trigger trigger
      WHERE trigger.tgrelid='media_publication_projections'::regclass
      AND trigger.tgname='media_publication_song_owner_policy_initialize'`)
        ).rows,
      ).toEqual([{ tgenabled: "O" }]);
      const ownedPgUrl = pgUrl;
      if (!ownedPgUrl) throw new Error("Owned PG required");
      const all = await loadPostgresMigrations();
      const candidates = all.filter(
        (m) =>
          m.sql.includes("CREATE FUNCTION freeze_owner_megapot_drawing_private_v1(") &&
          m.sql.includes("CREATE FUNCTION require_owner_accounting_ready_private_v1("),
      );
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      if (candidate === undefined) throw new Error("Actual complete financial source required");
      const full = all.slice(0, all.indexOf(candidate) + 1);
      expect(full.map((m) => Number(m.version.slice(0, 4)))).toEqual(
        Array.from({ length: full.length }, (_, i) => i + 1),
      );
      const old = decode(
        Schema.Record(Schema.String, GuestSha256V1),
        JSON.parse(
          await readFile(
            new URL("./disabled-owner-accounting.accepted-learning-prefix.json", import.meta.url),
            "utf8",
          ),
        ),
      );
      for (const m of full.slice(0, 264)) {
        const acceptedChecksum = old[m.version];
        if (acceptedChecksum === undefined) throw new Error("Accepted migration checksum missing");
        expect(m.checksum).toBe(acceptedChecksum);
      }
      expect(full[264]?.checksum).toBe(
        "337b5469bdf01595413349517f1c0750530280a4a38ac8fd007a2d2e3c4e106f",
      );
      expect(full[265]?.checksum).toBe(
        "a5ffb1317f5630c822c9d35a59ce2a35dadd8ed0b3de54a6c94ae9304fe4bc77",
      );
      const scoped = new URL(ownedPgUrl);
      scoped.searchParams.set("options", `-c search_path=${f.schema}`);
      await runPostgresMigrations({
        connectionString: scoped.toString(),
        migrations: full,
        expectedLedger: full.slice(0, 257),
      });
      expect(
        (await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version"))
          .rows,
      ).toEqual(full.map(({ version, checksum }) => ({ version, checksum })));
      // Actual native closure, never a runtime success callback or mutable fixture manifest.
      await f.admin.query("SELECT require_owner_accounting_ready_private_v1()");
      const principal = decode(
        Schema.Struct({
          same: Schema.Literal(true),
          superuser: Schema.Literal(false),
          bypass: Schema.Literal(false),
          inherit: Schema.Literal(false),
          create_role: Schema.Literal(false),
        }),
        (
          await f.guest.query(
            "SELECT current_user=session_user AS same,rolsuper AS superuser,rolbypassrls AS bypass,rolinherit AS inherit,rolcreaterole AS create_role FROM pg_roles WHERE rolname=current_user",
          )
        ).rows[0],
      );
      expect(principal.same).toBe(true);
      // Before any future controlled grant, every private financial table denies this LOGIN.
      for (const table of financialTables) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"])
          expect(
            (
              await f.guest.query("SELECT has_table_privilege(current_user,$1,$2) AS allowed", [
                table,
                privilege,
              ])
            ).rows,
          ).toEqual([{ allowed: false }]);
        await expect(f.guest.query(`SELECT * FROM ${q(table)}`)).rejects.toMatchObject({
          code: "42501",
        });
      }
      for (const signature of controlled) {
        const frame = (
          await f.admin.query(
            `SELECT p.proowner=c.relowner AS owner,p.pronamespace=c.relnamespace AS namespace,
    p.prosecdef AS definer,p.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',n.nspname)] AS pinned
    FROM pg_proc p CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE p.oid=$1::regprocedure AND c.oid='participation_owners'::regclass`,
            [signature],
          )
        ).rows;
        expect(frame).toEqual([{ owner: true, namespace: true, definer: true, pinned: true }]);
        // Only this explicit actual source-consumer list; never the entire manifest.
        await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(f.role)}`);
      }
      expect(
        (
          await f.guest.query(
            "SELECT has_function_privilege(current_user,'require_owner_guest_source_private_v1(jsonb)','EXECUTE') AS allowed",
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
      await expect(
        f.guest.query("SELECT require_owner_guest_source_private_v1('{}'::jsonb)"),
      ).rejects.toMatchObject({ code: "42501" });
      await f.admin.query("SELECT require_owner_accounting_ready_private_v1()");
      const adminRuntime = makeDirectPostgresControlPlaneLayer(scoped.toString(), {
        closeTimeoutMs: 2000,
      });
      const guestRuntime = makeDirectPostgresControlPlaneLayer(f.guestUrl, {
        closeTimeoutMs: 2000,
      });
      const retained: Array<{
        task: Promise<unknown>;
        settled: Promise<{ ok: true } | { ok: false; error: unknown }>;
      }> = [];
      const retain = (task: Promise<unknown>) => {
        const settled = task.then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error }),
        );
        retained.push({ task, settled });
      };
      let providerCalls = 0,
        putCalls = 0;
      const objects = new Map<string, Uint8Array>();
      const outsideSql = async () =>
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename=$1 AND xact_start IS NOT NULL",
              [f.role],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
      const bucket = {
        put: async (key: string, bytes: Uint8Array) => {
          await outsideSql();
          expect(
            (
              await f.admin.query(
                `SELECT count(*)::integer AS n FROM guest_study_spoken_checkpoints cp
    JOIN guest_study_spoken_captures cap USING(capture_id) JOIN learner_audio_upload_attempts upload
    ON upload.upload_attempt_id=cap.upload_attempt_id WHERE upload.object_ref=$1`,
                [key],
              )
            ).rows,
          ).toEqual([{ n: 1 }]);
          putCalls++;
          objects.set(key, new Uint8Array(bytes));
          return { size: bytes.byteLength };
        },
      };
      const transcriber: OwnerStudyInvokingTranscriber = {
        providerRetention: "not_stored",
        available: true,
        invoke: Effect.fn("rewardedNative.provider")(function* (input) {
          yield* Effect.promise(outsideSql);
          providerCalls++;
          return {
            state: "completed" as const,
            result: {
              transcript: new TextDecoder().decode(input.audio),
              detectedLanguage: "en",
              detectedLanguageConfidence: 0.99,
            },
          };
        }),
      };
      // Driver faults use the real restricted LOGIN and exact production
      // composition. They never replace native producer/grade/hold authority.
      const servicesFor = (clientFactory?: PostgresClientFactory) => {
        const runtime = makeDirectPostgresControlPlaneLayer(f.guestUrl, {
          closeTimeoutMs: 2000,
          ...(clientFactory === undefined ? {} : { clientFactory }),
        });
        const base = makeControlPlaneOwnerStudyMutations(runtime, {
          rawPolicy: policy,
          disclosureVersion: disclosure.version,
          rerecordEnabled: true,
          providerRetention: "not_stored",
        });
        const accepted = makeControlPlaneOwnerSpokenCapturedContinuationStore(runtime);
        const rewards = makeControlPlaneGuestRewardStudyContinuations(runtime, {
          ...accepted,
          submitAnswer: base.submitAnswer,
        });
        const mutations = composeGuestRewardStudyMutationMethods(base, rewards);
        const starter = makeControlPlaneOwnerStudyStarter(
          runtime,
          disclosure,
          policy,
          undefined,
          safetyMarginSeconds,
        );
        const prepared = makeControlPlanePreparedGuestStudyContentStore(adminRuntime, disclosure);
        const store = composeOwnerAwareStudyV2Store({
          starter,
          mutations,
          prepared,
          ordinary: makeControlPlaneStudyV2Store(adminRuntime),
          originalAccountSources: makeOriginalAccountStudySourceControl(adminRuntime),
          verifiedOrdinaryAccount: null,
        });
        const study = makeOwnerGuestStudyService({
          store,
          prepared,
          atomicStarter: starter,
          dispatchContext: makeOwnerGuestSpokenDispatchContextStore(runtime),
          resourcePolicy: policy,
          transcriber,
          success: makeOwnerSpokenSuccessProtocol(
            makeControlPlaneOwnerSpokenPreArchiveCheckpointStore(runtime),
            store,
            makeOwnerSpokenFencedArchiveStage(runtime, bucket, retain),
          ),
          recovery: makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores(runtime).browser,
          visibility: makeOwnerGuestStudyPublicVisibilityStore(adminRuntime),
          rerecordEnabled: true,
        });
        const recovered = makeControlPlaneOwnerGuestSpokenCheckpointRecoveryStores(runtime);
        return {
          study,
          browser: recovered.browser,
          closedRecovery: makeOwnerGuestSpokenClosedRecovery(
            recovered.closed,
            composeGuestRewardCapturedContinuation(accepted, rewards),
          ),
        };
      };
      const { study } = servicesFor();
      const withClock = <A, E>(e: Effect.Effect<A, E, Clock | IdGen>) =>
        run(
          e.pipe(
            Effect.provideService(Clock, { now: Effect.sync(() => Date.now()) }),
            Effect.provideService(IdGen, { next: Effect.sync(() => crypto.randomUUID()) }),
          ),
        );
      const preview = makeControlPlanePreparedGuestRewardContentStore(
        guestRuntime,
        disclosure,
        safetyMarginSeconds,
      );
      const startGuest = async (serial: number, key: string) => {
        const actual = await seedGuest(f, serial);
        const quote = await run(
          preview.get({ ...source, targetLanguage: null, learnerBand: null }),
        );
        if (
          quote.availability.state !== "ready" ||
          quote.reward_preview === null ||
          quote.reward_preview_terms_hash === null
        )
          throw new Error("Actual ready original reward preview required");
        const started = await withClock(
          study.startSession({
            access: actual.access,
            ...source,
            trustedEdge: { kind: "trusted_edge", fingerprint: `causal-owned-${serial}` },
            body: {
              expected_owner_id: actual.ownerId,
              idempotency_key: key,
              reward_mode: "megapot_guest_v1",
              reward_preview_terms_hash: quote.reward_preview_terms_hash,
              target_language: null,
              learner_band: null,
              timezone: "UTC",
              disclosure: { version: disclosure.version, accepted: true },
            },
          }),
        );
        if (started.kind !== "start" || started.outcome.state !== "completed")
          throw new Error("Actual completed rewarded source required");
        const session = decode(GuestStudySessionV1, started.outcome.result.session);
        expect(session.reward_terms).toEqual(quote.reward_preview);
        expect(
          (
            await f.admin.query(
              "SELECT account_id,persona_id,participation_owner_id FROM study_sessions_v2 WHERE session_id=$1",
              [session.session_id],
            )
          ).rows,
        ).toEqual([{ account_id: null, persona_id: null, participation_owner_id: actual.ownerId }]);
        return { access: actual.access, session };
      };
      const completeAccount = async (
        input: Readonly<{
          personaId: string;
          postId: string;
          sessionId: string;
          rewarded: boolean;
        }>,
      ) => {
        // Ordinary Account source stays in its separate native Account producer.
        // This owned source-owner runtime is functional producer evidence; the
        // restricted Guest LOGIN is never given Account raw-row permissions.
        const reader = makeControlPlaneAccountOwnerRewardHooks(adminRuntime, null);
        const quote = input.rewarded
          ? await run(
              reader.preview({
                accountId: "study-account",
                personaId: input.personaId,
                communityId: source.communityId,
                postId: input.postId,
                audioRevision: 1,
                lyricsRevision: 1,
                qualificationPolicyRevision: "study_session_first_pass_v2@1",
                disclosureVersion: disclosure.version,
                purchaseSafetyMarginSeconds: safetyMarginSeconds,
              }),
            )
          : null;
        if (input.rewarded && quote === null)
          throw new Error("Actual original Account preview required");
        const hooks =
          quote === null
            ? undefined
            : makeControlPlaneAccountOwnerRewardHooks(adminRuntime, {
                rewardPreviewTermsHash: quote.reward_preview_terms_hash,
                disclosureVersion: disclosure.version,
                disclosureAccepted: true,
                purchaseSafetyMarginSeconds: safetyMarginSeconds,
              });
        let calls = 0,
          puts = 0;
        const accountProvider: StudyBatchTranscriber = {
          providerRetention: "not_stored",
          transcribe: Effect.fn("mixedNative.accountProvider")(function* (request) {
            yield* Effect.promise(async () => {
              expect(
                (
                  await f.admin.query(
                    `SELECT count(*)::integer AS n FROM learner_audio_account_provider_calls provider
              JOIN learner_audio_account_producer_captures capture USING(upload_attempt_id)
              WHERE capture.account_id='study-account' AND capture.content_digest=$1 AND provider.state='started'`,
                    [hash(request.audio)],
                  )
                ).rows,
              ).toEqual([{ n: 1 }]);
            });
            calls++;
            return {
              transcript: new TextDecoder().decode(request.audio),
              detectedLanguage: "en",
              detectedLanguageConfidence: 0.99,
            };
          }),
        };
        const account = makeControlledAccountSpokenComposition(
          adminRuntime,
          {
            put: async (key, bytes) => {
              expect(
                (
                  await f.admin.query(
                    `SELECT count(*)::integer AS n FROM learner_audio_account_spoken_checkpoints cp
            JOIN learner_audio_account_producer_captures capture USING(upload_attempt_id)
            WHERE capture.account_id='study-account' AND capture.expected_object_ref=$1`,
                    [key],
                  )
                ).rows,
              ).toEqual([{ n: 1 }]);
              puts++;
              objects.set(key, new Uint8Array(bytes));
              return { size: bytes.byteLength };
            },
          },
          accountProvider,
          false,
          retain,
          undefined,
          hooks,
        );
        let session = await run(
          account.store.startSession({
            accountId: "study-account",
            personaId: input.personaId,
            communityId: source.communityId,
            postId: input.postId,
            sessionId: input.sessionId,
            idempotencyKey: `start:${input.sessionId}`,
            requestHash: hash(`start:${input.sessionId}`),
            createdAt: new Date().toISOString(),
            targetLanguage: null,
            learnerBand: null,
            timezone: "UTC",
          }),
        );
        expect(session.items).toHaveLength(4);
        for (let index = 0; index < 4; index++) {
          const current = session.lesson.current;
          if (current === null) throw new Error("Original Account current card required");
          const route = {
            accountId: "study-account",
            communityId: source.communityId,
            sessionId: session.session_id,
            sessionItemId: current.session_item_id,
            idempotencyKey: `${input.sessionId}:answer:${index}`,
          };
          const context = await run(account.store.loadSpokenAnswerContext(route));
          const original = {
            ...route,
            attemptNumber: current.presentation_number,
            audio: new TextEncoder().encode(context.referenceText),
            audioContentType: "audio/webm",
            audioDurationMs: 1000,
          };
          const answered = await withClock(account.spoken.submitSpokenAnswer(original));
          expect(answered.outcome).toBe("correct");
          session = answered.session;
          expect(await withClock(account.spoken.submitSpokenAnswer(original))).toEqual(answered);
          expect(calls).toBe(index + 1);
          expect(puts).toBe(index + 1);
        }
        expect(session.status).toBe("completed");
        if (hooks !== undefined)
          expect(
            (await run(hooks.project("study-account", source.communityId, session.session_id)))
              .participation,
          ).toMatchObject({ state: "admitted" });
        return { sessionId: session.session_id, providerCalls: calls, putCalls: puts };
      };
      const completeGuest = async (serial: number, key: string) => {
        const actual = await seedGuest(f, serial);
        const quote = await run(
          preview.get({ ...source, targetLanguage: null, learnerBand: null }),
        );
        expect(quote.availability.state).toBe("ready");
        const terms = quote.reward_preview,
          termsHash = quote.reward_preview_terms_hash;
        if (terms === null || termsHash === null)
          throw new Error("Actual complete native reward preview required");
        decode(GuestRewardTermsV1, terms);
        decode(GuestSha256V1, termsHash);
        const before = await f.admin.query(
          "SELECT (SELECT count(*) FROM users)::integer AS users,(SELECT count(*) FROM personas)::integer AS personas,(SELECT count(*) FROM community_memberships)::integer AS memberships",
        );
        const started = await withClock(
          study.startSession({
            access: actual.access,
            ...source,
            trustedEdge: { kind: "trusted_edge", fingerprint: `rewarded-owned-${serial}` },
            body: {
              expected_owner_id: actual.ownerId,
              idempotency_key: key,
              reward_mode: "megapot_guest_v1",
              reward_preview_terms_hash: termsHash,
              target_language: null,
              learner_band: null,
              timezone: "UTC",
              disclosure: { version: disclosure.version, accepted: true },
            },
          }),
        );
        if (started.kind !== "start" || started.outcome.state !== "completed")
          throw new Error("Actual completed original native start required");
        let session = decode(GuestStudySessionV1, started.outcome.result.session);
        expect(session.reward_terms).toEqual(terms);
        expect(session.items).toHaveLength(4);
        const originalRows = (
          await f.admin.query(
            "SELECT account_id,persona_id,participation_owner_id,guest_reward_mode FROM study_sessions_v2 WHERE session_id=$1",
            [session.session_id],
          )
        ).rows;
        expect(originalRows).toEqual([
          {
            account_id: null,
            persona_id: null,
            participation_owner_id: actual.ownerId,
            guest_reward_mode: "megapot_guest_v1",
          },
        ]);
        for (let i = 0; i < 4; i++) {
          const current = session.lesson.current;
          if (current === null) throw new Error("Real current presentation required");
          const item = session.items.find(
            (item) => item.session_item_id === current.session_item_id,
          );
          if (item?.presentation.kind !== "say_it_back")
            throw new Error("Prepared spoken source card required");
          const original = {
            access: actual.access,
            communityId: session.community_id,
            sessionId: session.session_id,
            sessionItemId: item.session_item_id,
            attemptNumber: current.presentation_number,
            idempotencyKey: `${key}:answer:${i}`,
            audio: new TextEncoder().encode(item.presentation.reference_text),
            audioContentType: "audio/webm",
            audioDurationMs: 1000,
          };
          const answered = await withClock(study.submitSpokenAnswer(original));
          if (answered.state !== "completed")
            throw new Error("Actual original answer completion required");
          expect(answered.result.answer.outcome).toBe("correct");
          session = decode(GuestStudySessionV1, answered.result.answer.session);
          const calls = providerCalls,
            puts = putCalls;
          expect(await withClock(study.submitSpokenAnswer(original))).toEqual(answered);
          expect(providerCalls).toBe(calls);
          expect(putCalls).toBe(puts);
        }
        expect(session.status).toBe("completed");
        expect(session.participation.state).toBe("admitted");
        expect(
          (
            await f.admin.query(
              "SELECT (SELECT count(*) FROM users)::integer AS users,(SELECT count(*) FROM personas)::integer AS personas,(SELECT count(*) FROM community_memberships)::integer AS memberships",
            )
          ).rows,
        ).toEqual(before.rows);
        expect(
          (
            await f.admin.query(
              `SELECT count(*)::integer AS n FROM megapot_owner_shares share
    JOIN activity_qualifications qualification USING(qualification_id)
    WHERE share.owner_id=$1 AND share.pool_leg_id=$2 AND share.drawing_id=$3::numeric
     AND qualification.participation_owner_kind='guest' AND qualification.account_id IS NULL AND qualification.persona_id IS NULL`,
              [actual.ownerId, terms.pool_leg_id, terms.original_drawing_id],
            )
          ).rows,
        ).toEqual([{ n: 1 }]);
        return { access: actual.access, session };
      };
      let primary: unknown,
        failed = false;
      const cleanup: unknown[] = [];
      try {
        await use({
          ...f,
          adminRuntime,
          guestRuntime,
          study,
          preview,
          providerCalls: () => providerCalls,
          putCalls: () => putCalls,
          objects,
          completeGuest,
          completeAccount,
          startGuest,
          servicesFor,
        });
      } catch (e) {
        failed = true;
        primary = e;
      } finally {
        try {
          // Dynamic registrations are read again after each independent observed drain.
          let drained = 0;
          while (drained < retained.length) {
            const batch = retained.slice(drained);
            drained += batch.length;
            const outcomes = await within(
              Promise.all(batch.map((t) => t.settled)),
              "retained archive drain",
            );
            for (const outcome of outcomes) if (!outcome.ok) cleanup.push(outcome.error);
          }
        } catch (e) {
          cleanup.push(e);
          f.deferDestructiveCleanup();
        }
      }
      if (failed || cleanup.length)
        throw new AggregateError(
          [...(failed ? [primary] : []), ...cleanup],
          "Owned rewarded producer failed or cleanup incomplete",
        );
    },
    { initializeOwnerPolicy: true, ...options },
  );
}
