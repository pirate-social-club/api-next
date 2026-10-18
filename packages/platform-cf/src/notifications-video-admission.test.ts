import { expect, test } from "bun:test";
import {
  type ControlPlaneDb,
  type ControlPlaneStatement,
  ControlPlaneTransactionOutcomeUnknown,
} from "@pirate/application";
import { Effect } from "effect";
import { makeNotificationsVideoAdmissionStore } from "./notifications-video-admission.ts";
import {
  ensureExactVideoReceiptAliasInTransaction,
  requireVideoPublicationIdentityInTransaction,
} from "./video-publication-identity.ts";

const source = "-- reviewed install\nSELECT 1";
const sourceSha = Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))),
  (b) => b.toString(16).padStart(2, "0"),
).join("");
const plan = {
  contract_sha256: "36e74a67ee280677436ff0d7ea7d1fd6243db3dc9432645a23a2402e2d03ec19",
  plan_sha256: "a".repeat(64),
  alias_run_id: "00000000-0000-4000-8000-000000000001",
  paired_solid_sha256: "b".repeat(64),
  cutover_source_sha256: sourceSha,
};
function fixture(
  options: {
    drained?: boolean;
    aliases_ready?: boolean;
    producer_fenced?: boolean;
    lostAck?: boolean;
  } = {},
) {
  const statements: ControlPlaneStatement[] = [];
  let committed = false;
  let unknown = options.lostAck;
  const cause = new ControlPlaneTransactionOutcomeUnknown({
    phase: "commit",
    label: "control-plane.commit",
    limitMs: 5000,
    elapsedMs: 5000,
  });
  const execute: ControlPlaneDb["Service"]["execute"] = (s) => {
    statements.push(s);
    const rows = s.label.endsWith(".reconcile")
      ? committed
        ? [
            {
              plan_sha256: plan.plan_sha256,
              alias_run_id: plan.alias_run_id,
              paired_solid_sha256: plan.paired_solid_sha256,
              cutover_source_sha256: plan.cutover_source_sha256,
            },
          ]
        : []
      : s.label.endsWith(".ready")
        ? [
            {
              drained: options.drained ?? true,
              aliases_ready: options.aliases_ready ?? true,
              producer_fenced: options.producer_fenced ?? true,
            },
          ]
        : [];
    return Effect.succeed({ rows: rows as never, rowCount: rows.length });
  };
  const db: ControlPlaneDb["Service"] = {
    execute,
    withTransaction: (use) =>
      Effect.gen(function* () {
        const result = yield* use({ execute });
        committed = true;
        if (unknown) {
          unknown = false;
          return yield* cause;
        }
        return result;
      }),
  };
  return { statements, cause, store: makeNotificationsVideoAdmissionStore(db) };
}
test("cutover excludes outbox first, then namespace; readiness precedes atomic install/receipt, with no drain/materialization under locks", async () => {
  const f = fixture();
  expect(await Effect.runPromise(f.store.cutover(plan, source))).toEqual({
    alreadyCommitted: false,
  });
  expect(f.statements.map((s) => s.label)).toEqual([
    "notifications.video.cutover.deadlines",
    "notifications.video.cutover.exclude",
    "notifications.video.cutover.namespace",
    "notifications.video.cutover.reconcile",
    "notifications.video.cutover.ready",
    "notifications.video.cutover.install",
    "notifications.video.cutover.receipt",
  ]);
  expect(f.statements[1]?.text).toBe(
    "LOCK TABLE content_publication_outbox IN EXCLUSIVE MODE NOWAIT",
  );
  expect(f.statements[2]?.text).toContain("NOWAIT");
  expect(f.statements[5]?.text).toBe(source);
  expect(
    f.statements.every(
      (s) =>
        !s.text.includes("deliver_comment_notification_v1") &&
        !s.text.includes("ensure_exact_video_receipt_alias_v1"),
    ),
  ).toBe(true);
});
test("any outstanding old fact, alias conflict or unfenced producer refuses without installing new eligibility", async () => {
  for (const options of [
    { drained: false },
    { aliases_ready: false },
    { producer_fenced: false },
  ]) {
    const f = fixture(options);
    await expect(Effect.runPromise(f.store.cutover(plan, source))).rejects.toThrow(
      "prerequisites incomplete",
    );
    expect(
      f.statements.some((s) => s.label.endsWith(".install") || s.label.endsWith(".receipt")),
    ).toBe(false);
  }
  const f = fixture();
  await expect(
    Effect.runPromise(f.store.cutover({ ...plan, cutover_source_sha256: "f".repeat(64) }, source)),
  ).rejects.toThrow("source mismatch");
  expect(f.statements).toHaveLength(0);
});
test("committed lost-ack preserves the unknown-outcome error; explicit exact receipt reconciliation does not reinstall or reset facts", async () => {
  const f = fixture({ lostAck: true });
  const error = await Effect.runPromise(Effect.flip(f.store.cutover(plan, source)));
  expect(error).toBe(f.cause);
  expect(await Effect.runPromise(f.store.cutover(plan, source))).toEqual({
    alreadyCommitted: true,
  });
  expect(f.statements.filter((s) => s.label.endsWith(".install"))).toHaveLength(1);
  await expect(
    Effect.runPromise(f.store.cutover({ ...plan, paired_solid_sha256: "c".repeat(64) }, source)),
  ).rejects.toThrow("receipt differs");
  expect(f.statements.filter((s) => s.label.endsWith(".install"))).toHaveLength(1);
});
test("exact alias failures never invoke generic allocation or another identity; unknown outcomes are unchanged", async () => {
  const input = { submissionId: "s", operationId: "o", postId: "post-fixed" };
  for (const result of [
    "inserted",
    "already-exact",
    "slug-collision",
    "different-existing-alias",
    "invalid-key",
    "unknown",
  ]) {
    const calls: ControlPlaneStatement[] = [];
    const execute: ControlPlaneDb["Service"]["execute"] = (s) => {
      calls.push(s);
      return Effect.succeed({ rows: [{ result }] as never, rowCount: 1 });
    };
    const task = Effect.runPromise(ensureExactVideoReceiptAliasInTransaction({ execute }, input));
    if (result === "inserted" || result === "already-exact") await task;
    else await expect(task).rejects.toThrow("refused");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual(["s", "o", "post-fixed"]);
    expect(calls[0]?.text).toBe("SELECT ensure_exact_video_receipt_alias_v1($1,$2,$3) AS result");
  }
  const cause = new ControlPlaneTransactionOutcomeUnknown({
    phase: "commit",
    label: "publication",
    limitMs: 5000,
    elapsedMs: 5000,
  });
  const execute: ControlPlaneDb["Service"]["execute"] = () => Effect.fail(cause);
  expect(
    await Effect.runPromise(
      Effect.flip(ensureExactVideoReceiptAliasInTransaction({ execute }, input)),
    ),
  ).toBe(cause);
  await expect(
    Effect.runPromise(
      requireVideoPublicationIdentityInTransaction(
        {
          execute: (() =>
            Effect.succeed({
              rows: [{ post_id: "post-other" }],
              rowCount: 1,
            })) as ControlPlaneDb["Service"]["execute"],
        },
        input,
      ),
    ),
  ).rejects.toThrow("identity did not reconcile");
});
