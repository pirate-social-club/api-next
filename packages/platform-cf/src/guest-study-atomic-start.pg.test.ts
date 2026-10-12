// Outside authored/unexecuted proposal. Genuine maintained0001..0254 fixture;
// actual restricted LOGIN and adapter, actual controlled shared selector/capture.
import { describe, expect, test } from "bun:test";
import { ControlPlaneTransactionOutcomeUnknown } from "@pirate/application";
import {
  counts,
  disclosure,
  editFixture,
  financialFingerprint,
  fixture,
  hash,
  lostCommitClient,
  pgUrl,
  policy,
  q,
  rejected,
  run,
  seedGuest,
} from "./owner-study-starter.pg-fixture.ts";
import {
  type GuestAtomicStudyStartInput,
  makeControlPlaneOwnerStudyStarter,
} from "./owner-study-starter.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];
const suite = pgUrl ? describe : describe.skip;
const wrapper =
  "reserve_guest_prepared_study_start_v1(jsonb,jsonb,text,text,text,text,text,text,jsonb,text)";
async function actor(
  f: Fixture,
  options: Parameters<typeof makeDirectPostgresControlPlaneLayer>[1] = {},
  configuredDisclosure: typeof disclosure | null = disclosure,
) {
  // Restricted LOGIN gets no helper or wrapper capability before this explicit
  // disposable-fixture entrypoint grant; native ACL proof occurred before revokes.
  await expect(
    f.guest.query("SELECT select_guest_study_start_plan_v1(NULL,NULL,NULL,NULL,NULL)"),
  ).rejects.toMatchObject({ code: "42501" });
  const permitted = (
    await f.admin.query("SELECT has_function_privilege($1::text,$2::text,'EXECUTE') AS allowed", [
      f.role,
      wrapper,
    ])
  ).rows[0].allowed;
  if (!permitted)
    await expect(
      f.guest.query(
        "SELECT reserve_guest_prepared_study_start_v1(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)",
      ),
    ).rejects.toMatchObject({ code: "42501" });
  await f.admin.query(`GRANT EXECUTE ON FUNCTION ${wrapper} TO ${q(f.role)}`);
  return makeControlPlaneOwnerStudyStarter(
    makeDirectPostgresControlPlaneLayer(f.guestUrl, options),
    configuredDisclosure,
    policy,
  );
}
const input = (
  proof: Awaited<ReturnType<typeof seedGuest>>,
  key: string,
): GuestAtomicStudyStartInput => ({
  access: proof.access,
  source: { kind: "guest", ownerId: proof.ownerId },
  operation: {
    sourceOwnerId: proof.ownerId,
    kind: "study_start",
    idempotencyKey: key,
    requestHash: hash(`atomic-start:${key}`),
  },
  communityId: "study-community",
  postId: "study-post",
  sessionId: `draw-${key}`,
  createdAt: new Date().toISOString(),
  targetLanguage: null,
  learnerBand: null,
  timezone: "UTC",
  idempotencyKey: key,
  requestHash: hash(`atomic-start:${key}`),
  rewardMode: "practice_only",
  rewardTerms: null,
  disclosure: { version: disclosure.version, accepted: true },
  trustedEdge: { kind: "trusted_edge", fingerprint: "atomic-owned-test-edge" },
  policy,
  freshRefusalOperationId: `operation-${key}`,
});
const lookup = (i: GuestAtomicStudyStartInput) => ({
  access: i.access,
  sourceOwnerId: i.source.ownerId,
  communityId: i.communityId,
  postId: i.postId,
  idempotencyKey: i.idempotencyKey,
});
async function retained(f: Fixture) {
  const values: Record<string, unknown> = {};
  for (const table of [
    "guest_resource_edge_locks",
    "guest_resource_policy_snapshots",
    "guest_resource_cost_policy_snapshots",
    "guest_resource_session_reservations",
    "guest_resource_provider_calls",
    "guest_resource_release_receipts",
    "guest_participation_operations",
    "participation_owner_clocks",
  ])
    values[table] = (
      await f.admin.query(
        `SELECT count(*)::int AS n,encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash FROM ${q(table)} t`,
      )
    ).rows;
  return values;
}
suite("atomic shared-selector guest Study start", () => {
  test(
    "two real four-spoken-card sessions reserve exact24 each and original replay ignores fresh catalogue/policy/draw",
    async () =>
      fixture(async (f) => {
        const backend = await actor(f),
          proof = await seedGuest(f, 81),
          a = input(proof, "first-four"),
          b = input(proof, "second-four");
        const finance = await financialFingerprint(f),
          first = await run(backend.startPreparedSession(a)),
          second = await run(backend.startPreparedSession(b));
        if (
          first.kind !== "start" ||
          first.outcome.state !== "completed" ||
          second.kind !== "start" ||
          second.outcome.state !== "completed"
        )
          throw new Error("Expected real captured sessions");
        expect(first.outcome.result.session.items).toHaveLength(4);
        expect(second.outcome.result.session.items).toHaveLength(4);
        expect(
          (
            await f.admin.query(
              "SELECT initial_units,worst_case_cost_micros::text AS cost FROM guest_resource_session_reservations WHERE source_owner_id=$1 ORDER BY session_id",
              [proof.ownerId],
            )
          ).rows,
        ).toEqual([
          { initial_units: 24, cost: "24000" },
          { initial_units: 24, cost: "24000" },
        ]);
        expect(
          (
            await f.admin.query(
              "SELECT owner_active::int AS active,owner_calls::text AS calls FROM guest_resource_usage_v1(ARRAY[$1]::text[],clock_timestamp())",
              [proof.ownerId],
            )
          ).rows,
        ).toEqual([{ active: 2, calls: "48" }]);
        await expect(
          f.guest.query(
            "SELECT select_guest_study_start_plan_v1($1,'study-community','study-post',NULL,NULL)",
            [proof.ownerId],
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await editFixture(
          f.admin,
          "UPDATE study_exercise_versions SET retired_at=clock_timestamp() WHERE community_id='study-community' AND post_id='study-post'",
        );
        const before = await retained(f);
        expect(
          await run(
            (await actor(f, {}, null)).startPreparedSession({
              ...a,
              sessionId: "unused-fresh-replay-draw",
              policy: null,
              freshRefusalOperationId: "unused-fresh-operation",
            }),
          ),
        ).toEqual(first);
        expect(await retained(f)).toEqual(before);
        expect(await financialFingerprint(f)).toEqual(finance);
      }),
    30000,
  );
  test(
    "real resource refusal commits one original abort; replay and exact status do not redraw",
    async () =>
      fixture(async (f) => {
        const backend = await actor(f),
          proof = await seedGuest(f, 82),
          i = input(proof, "definite-refusal");
        const refusedPolicy = {
          ...policy,
          version: "atomic-low-cost-v1",
          maximumOwnerCostMicrosPerRollingDay: "1000",
        };
        const before = await counts(f),
          finance = await financialFingerprint(f),
          first = await run(backend.startPreparedSession({ ...i, policy: refusedPolicy }));
        expect(first.kind).toBe("resource_refused");
        if (first.kind !== "resource_refused" || first.outcome.state !== "completed")
          throw new Error("Expected committed positive refusal");
        expect(first.outcome.result.state).toBe("budget_refused");
        expect(
          (
            await f.admin.query(
              "SELECT state,operation_id,idempotency_key,request_hash,resource_scope::jsonb AS resource_scope FROM guest_participation_operations WHERE operation_id=$1",
              [i.freshRefusalOperationId],
            )
          ).rows,
        ).toEqual([
          {
            state: "known_aborted",
            operation_id: i.freshRefusalOperationId,
            idempotency_key: i.idempotencyKey,
            request_hash: i.requestHash,
            resource_scope: ["guest_study_start_v1", i.communityId, i.postId],
          },
        ]);
        expect(await run(f.store.findStartOperation(lookup(i)))).toEqual({
          state: "not_started",
          session: null,
        });
        const after = await counts(f);
        expect(after.sessions).toBe(before.sessions);
        expect(after.items).toBe(before.items);
        expect(after.calls).toBe(before.calls);
        expect(after.operations).toBe(before.operations + 1);
        const receipt = await retained(f);
        expect(
          await run(
            backend.startPreparedSession({
              ...i,
              policy: null,
              sessionId: "unused-refusal-draw",
              freshRefusalOperationId: "unused-refusal-op",
            }),
          ),
        ).toEqual(first);
        expect(await retained(f)).toEqual(receipt);
        expect(await financialFingerprint(f)).toEqual(finance);
      }),
    30000,
  );
  test(
    "lost real COMMIT acknowledgment on refusal stays unknown until actual original abort readback",
    async () =>
      fixture(async (f) => {
        const lost = lostCommitClient(),
          backend = await actor(f, { clientFactory: lost.clientFactory }),
          proof = await seedGuest(f, 83),
          i = input(proof, "lost-refusal");
        const error = await rejected(
          backend.startPreparedSession({
            ...i,
            policy: {
              ...policy,
              version: "atomic-lost-low-cost-v1",
              maximumOwnerCostMicrosPerRollingDay: "1000",
            },
          }),
        );
        expect(error).toBeInstanceOf(ControlPlaneTransactionOutcomeUnknown);
        expect(lost.observed()).toBe(true);
        expect(await run(f.store.findStartOperation(lookup(i)))).toEqual({
          state: "not_started",
          session: null,
        });
        const before = await retained(f),
          retry = await run(
            (await actor(f)).startPreparedSession({
              ...i,
              policy: null,
              sessionId: "never-used-after-lost-refusal",
              freshRefusalOperationId: "never-used-after-lost-refusal-op",
            }),
          );
        expect(retry.kind).toBe("resource_refused");
        expect(await retained(f)).toEqual(before);
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS n FROM guest_resource_session_reservations WHERE source_owner_id=$1",
              [proof.ownerId],
            )
          ).rows,
        ).toEqual([{ n: 1 }]);
      }),
    30000,
  );
  test(
    "known abort without resource stays read-only, and NEW source/disclosure failures roll back every new plan row",
    async () =>
      fixture(async (f) => {
        const backend = await actor(f),
          proof = await seedGuest(f, 84),
          original = input(proof, "retained-no-resource-abort");
        // Explicit actual retained historical witness, not an absence→abort inference.
        await f.admin.query(
          "INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,idempotency_key,request_hash,state,created_at,resolved_at) VALUES($1,$2,'study_start',guest_study_start_resource_scope_v1($3,$4),$5,$6,'known_aborted',clock_timestamp(),clock_timestamp())",
          [
            original.freshRefusalOperationId,
            proof.ownerId,
            original.communityId,
            original.postId,
            original.idempotencyKey,
            original.requestHash,
          ],
        );
        const before = await retained(f),
          replay = await run(backend.startPreparedSession({ ...original, policy: null }));
        expect(replay).toEqual({
          kind: "start",
          outcome: { state: "known_aborted", operation: original.operation },
        });
        expect(await retained(f)).toEqual(before);
        // No approved current disclosure: actual NEW wrapper may reserve inside
        // its owning TX, but projection/capture refusal rolls EVERY new row back.
        const noCurrentDisclosure = await actor(f, {}, null);
        expect(
          await rejected(
            noCurrentDisclosure.startPreparedSession(input(proof, "missing-current-disclosure")),
          ),
        ).toMatchObject({
          _tag: "GuestParticipationStoreRejected",
          reason: "resource-policy-unavailable",
        });
        expect(await retained(f)).toEqual(before);
        expect(
          await run(noCurrentDisclosure.startPreparedSession({ ...original, policy: null })),
        ).toEqual(replay);
        expect(await retained(f)).toEqual(before);
        const noConsent = input(proof, "no-consent");
        expect(
          await rejected(
            backend.startPreparedSession({
              ...noConsent,
              disclosure: { version: disclosure.version, accepted: false },
            }),
          ),
        ).toMatchObject({
          _tag: "GuestParticipationStoreRejected",
          reason: "resource-policy-unavailable",
        });
        expect(await retained(f)).toEqual(before);
        await editFixture(
          f.admin,
          "UPDATE study_exercise_versions SET retired_at=clock_timestamp() WHERE exercise_version_id IN('exercise-3','exercise-4')",
        );
        expect(
          await rejected(backend.startPreparedSession(input(proof, "insufficient-source"))),
        ).toMatchObject({
          _tag: "GuestParticipationStoreRejected",
          reason: "resource-policy-unavailable",
        });
        expect(await retained(f)).toEqual(before);
      }),
    30000,
  );
  test(
    "lost successful atomic COMMIT retains one exact session/reservation and original source clocks",
    async () =>
      fixture(async (f) => {
        const lost = lostCommitClient(),
          backend = await actor(f, { clientFactory: lost.clientFactory }),
          proof = await seedGuest(f, 85),
          i = input(proof, "lost-success");
        expect(await rejected(backend.startPreparedSession(i))).toBeInstanceOf(
          ControlPlaneTransactionOutcomeUnknown,
        );
        expect(lost.observed()).toBe(true);
        const resolved = await run(f.store.findStartOperation(lookup(i)));
        expect(resolved.state).toBe("completed");
        const before = await retained(f),
          retry = await run(
            (await actor(f)).startPreparedSession({
              ...i,
              policy: null,
              sessionId: "unused-post-commit-session",
              freshRefusalOperationId: "unused-post-commit-operation",
            }),
          );
        if (retry.kind !== "start" || retry.outcome.state !== "completed")
          throw new Error("Expected retained successful original");
        expect(retry.outcome.result.session.session_id).toBe(i.sessionId);
        expect(retry.outcome.outcomeId).toBe(i.freshRefusalOperationId);
        expect(
          (
            await f.admin.query(
              "SELECT s.created_at=r.created_at AS same_created,s.expires_at=r.reservation_expires_at AS same_expiry,r.initial_units FROM study_sessions_v2 s JOIN guest_resource_session_reservations r ON r.reservation_id=s.guest_resource_reservation_id WHERE s.session_id=$1",
              [i.sessionId],
            )
          ).rows,
        ).toEqual([{ same_created: true, same_expiry: true, initial_units: 24 }]);
        expect(await retained(f)).toEqual(before);
      }),
    30000,
  );
});
