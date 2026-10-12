// REVIEW PROPOSAL ONLY. Intended packages/platform-cf/src/guest-attachment-preparation-store.test.ts.
// Execute only after root adoption/review. No HTTP/session-verification or binding acceptance claim.
import { expect, test } from "bun:test";
import type {
  GuestAttachmentStore,
  GuestCookieEffect,
} from "@pirate/application/guest-participation-authority";
import { Cause, Effect, Exit, Option } from "effect";
import { makeControlPlaneGuestAttachmentPreparation } from "./guest-attachment-preparation-store.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

const origin = "https://community.example";
const source = "owner_00000000-0000-0000-0000-000000000001";
const originalSource = "owner_00000000-0000-0000-0000-000000000002";
const credentialId = "AAAAAAAAAAAAAAAAAAAAAA";
const intentId = "gai_BBBBBBBBBBBBBBBBBBBBBA";
const otherIntentId = "gai_CCCCCCCCCCCCCCCCCCCCCA";
const nonceDigest = "a".repeat(64);
const requestHash = "b".repeat(64);
const sessionDigest = "c".repeat(64);
const operation = {
  sourceOwnerId: source,
  kind: "attachment_intent",
  idempotencyKey: "intent-key",
  requestHash,
};
const intent = {
  intent_id: intentId,
  state: "awaiting_account",
  expires_at: "2026-10-12T20:15:00.000Z",
};
const created = {
  state: "completed",
  operation_id: "original-intent-operation",
  operation,
  intent,
  cookie_effects: [{ kind: "intent", action: "issue", intentId }],
};
const selected: Parameters<GuestAttachmentStore["createIntent"]>[0]["context"]["selected"] = {
  ownerId: source,
  credentialId,
  origin,
  state: "confirmed",
  // Recovery does not require a current learning lease. SQL is authoritative.
  leaseUntil: "2026-10-11T20:00:00.000Z",
  pendingExpiresAt: "2026-10-11T19:15:00.000Z",
  predecessorCredentialId: null,
};
const provedIntent: Parameters<GuestAttachmentStore["prepareTarget"]>[0]["context"]["intent"] = {
  intentId,
  ownerId: source,
  credentialId,
  origin,
  state: "awaiting_account",
  expiresAt: intent.expires_at,
};
const createInput: Parameters<GuestAttachmentStore["createIntent"]>[0] = {
  context: {
    origin,
    authority: "recovery",
    operation: "create_attachment_intent",
    originAndCsrfChecked: true,
    provedCredentials: [selected],
    provedIntents: [],
    selected,
    access: { kind: "guest", ownerId: source, credentialId, origin },
  },
  expectedOwnerId: source,
  operation: { ...operation, kind: "attachment_intent" },
  intentId,
  nonceDigest,
  expiresAt: intent.expires_at,
};
function prepareInput(
  kind: "ordinary_account" | "persona_wallet_setup" = "ordinary_account",
  binding = sessionDigest,
): Parameters<GuestAttachmentStore["prepareTarget"]>[0] {
  return {
    intentId,
    context: {
      origin,
      authority: "attachment",
      operation: "prepare_target",
      originAndCsrfChecked: true,
      accountCsrfChecked: true,
      account: { kind, accountId: "account-one", sessionBinding: binding },
      provedCredentials: [selected],
      provedIntents: [provedIntent],
      selected,
      intent: provedIntent,
      access: { kind: "guest", ownerId: source, credentialId, origin },
    },
  };
}
const prepared = {
  state: "completed",
  operation_id: `guest_prepare_${requestHash}`,
  operation: {
    sourceOwnerId: source,
    kind: "attachment_prepare",
    idempotencyKey: requestHash,
    requestHash,
  },
  prepared: {
    intent_id: intentId,
    target_revision: 1,
    state: "awaiting_confirmation",
    account_confirmation: { account_id: "account-one", display_name: null },
  },
};
function fixture(
  reply: unknown = created,
  options: {
    commitFails?: boolean;
    rollbackFails?: boolean;
    sqlState?: string;
    rows?: readonly Record<string, unknown>[];
  } = {},
) {
  const queries: PostgresQueryConfig[] = [];
  const logs: unknown[] = [];
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      queries.push(query);
      if (query.text === "COMMIT" && options.commitFails) throw new Error("opaque COMMIT failure");
      if (query.text === "ROLLBACK" && options.rollbackFails)
        throw new Error("opaque ROLLBACK failure");
      if (
        /^SELECT (create_guest_attachment_intent_v1|prepare_guest_attachment_target_v1)/u.test(
          query.text,
        )
      ) {
        if (options.sqlState)
          throw Object.assign(new Error("opaque nonce/session driver message"), {
            code: options.sqlState,
          });
        return { rows: options.rows ?? [{ result: reply }], rowCount: options.rows?.length ?? 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/guest", {
    clientFactory: () => client,
    logger: {
      info: (event, fields) => logs.push({ event, fields }),
      error: (event, fields) => logs.push({ event, fields }),
    },
  });
  return {
    store: makeControlPlaneGuestAttachmentPreparation(runtime, () => "candidate-op"),
    queries,
    logs,
  };
}
async function failure(effect: Effect.Effect<unknown, unknown>) {
  const exit = await Effect.runPromiseExit(effect);
  if (!Exit.isFailure(exit)) throw new Error("expected typed failure");
  const error = Cause.findErrorOption(exit.cause);
  if (!Option.isSome(error)) throw new Error("expected typed failure");
  return error.value;
}
function privacy(value: unknown) {
  const encoded = JSON.stringify(value);
  expect(encoded).not.toContain(nonceDigest);
  expect(encoded).not.toContain(sessionDigest);
  expect(encoded).not.toContain("opaque nonce/session driver message");
}

test("creation publishes exact nonce-cookie effect only after acknowledged COMMIT", async () => {
  const f = fixture();
  const outcome = await Effect.runPromise(
    f.store.createIntent(createInput).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(f.queries.at(-1)?.text).toBe("COMMIT");
        }),
      ),
    ),
  );
  expect(outcome).toMatchObject({
    state: "completed",
    operation,
    outcomeId: created.operation_id,
    result: { intent, cookieEffects: created.cookie_effects },
  });
  privacy(outcome);
  privacy(f.logs);
  const limits = f.queries.find((q) => q.text.includes("transaction_timeout"));
  expect(limits?.text).toContain("'transaction_timeout','3s'");
  expect(limits?.text).toContain("'lock_timeout','250ms'");
  expect(limits?.text).toContain("'statement_timeout','2s'");
  expect(limits?.text).toContain("'idle_in_transaction_session_timeout','2s'");
});

test("COMMIT/ROLLBACK uncertainty exposes no completed outcome or cookie effects", async () => {
  for (const options of [{ commitFails: true }, { sqlState: "GP006", rollbackFails: true }]) {
    const f = fixture(created, options);
    const published: GuestCookieEffect[] = [];
    let outcomes = 0;
    const error = await failure(
      f.store.createIntent(createInput).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            outcomes += 1;
            if (outcome.state === "completed") published.push(...outcome.result.cookieEffects);
          }),
        ),
      ),
    );
    expect(error).toMatchObject({ _tag: "ControlPlaneTransactionOutcomeUnknown" });
    expect(outcomes).toBe(0);
    expect(published).toEqual([]);
    privacy(error);
    privacy(f.logs);
  }
  const f = fixture(prepared, { commitFails: true });
  const error = await failure(f.store.prepareTarget(prepareInput()));
  expect(error).toMatchObject({ _tag: "ControlPlaneTransactionOutcomeUnknown", phase: "commit" });
});

test("strict unknown-row creation decoder rejects malformed/excess/wrong-cookie replies before COMMIT", async () => {
  const replies: unknown[] = [
    null,
    { ...created, nonce_digest: nonceDigest },
    { ...created, operation: undefined },
    { ...created, operation: { ...operation, requestHash: nonceDigest } },
    { ...created, intent: { ...intent, intent_id: otherIntentId } },
    { ...created, cookie_effects: [{ kind: "intent", action: "issue", intentId: otherIntentId }] },
    { ...created, cookie_effects: [created.cookie_effects[0], created.cookie_effects[0]] },
    { ...created, cookie_effects: [] }, // replay must carry original nonce proof
  ];
  for (const reply of replies) {
    const f = fixture(reply);
    expect(await failure(f.store.createIntent(createInput))).toMatchObject({
      _tag: "ControlPlaneStatementFailed",
      label: "guest-attachment.create.decode",
    });
    expect(f.queries.map((q) => q.text)).toContain("ROLLBACK");
    expect(f.queries.map((q) => q.text)).not.toContain("COMMIT");
    privacy(f.logs);
  }
  for (const rows of [[], [{ result: created }, { result: created }]]) {
    const f = fixture(created, { rows });
    expect(await failure(f.store.createIntent(createInput))).toMatchObject({
      _tag: "ControlPlaneStatementFailed",
    });
    expect(f.queries.map((q) => q.text)).not.toContain("COMMIT");
  }
});

test("proved replay retains immutable historical source and emits no nonce refresh; missing proof requires restart after COMMIT", async () => {
  const replay = {
    ...created,
    operation: { ...operation, sourceOwnerId: originalSource },
    cookie_effects: [],
  };
  const f = fixture(replay);
  const outcome = await Effect.runPromise(
    f.store.createIntent({
      ...createInput,
      context: { ...createInput.context, provedIntents: [provedIntent] },
    }),
  );
  expect(outcome).toMatchObject({
    operation: replay.operation,
    outcomeId: created.operation_id,
    result: { cookieEffects: [] },
  });
  const restart = fixture({ state: "issuance_requires_restart" });
  expect(await failure(restart.store.createIntent(createInput))).toMatchObject({
    _tag: "GuestParticipationStoreRejected",
    reason: "issuance-requires-restart",
  });
  expect(restart.queries.at(-1)?.text).toBe("COMMIT");
});

test("ordinary and setup protected sessions reach identical private prepare with full session binding and no cookie effects", async () => {
  for (const kind of ["ordinary_account", "persona_wallet_setup"] satisfies readonly (
    | "ordinary_account"
    | "persona_wallet_setup"
  )[]) {
    const f = fixture(prepared);
    const outcome = await Effect.runPromise(
      f.store.prepareTarget(prepareInput(kind)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(f.queries.at(-1)?.text).toBe("COMMIT");
          }),
        ),
      ),
    );
    expect(outcome).toMatchObject({
      state: "completed",
      result: prepared.prepared,
      operation: prepared.operation,
    });
    const query = f.queries.find((q) =>
      q.text.startsWith("SELECT prepare_guest_attachment_target_v1"),
    );
    expect(query?.values).toEqual([
      origin,
      [credentialId],
      credentialId,
      source,
      [intentId],
      intentId,
      "account-one",
      sessionDigest,
    ]);
    privacy(outcome);
    privacy(f.logs);
  }
  const f = fixture(prepared);
  expect(
    await failure(f.store.prepareTarget(prepareInput("persona_wallet_setup", "binding"))),
  ).toMatchObject({
    _tag: "ControlPlaneStatementFailed",
    label: "guest-attachment.prepare.session-binding",
    outcomeCertainty: "not-started",
  });
  expect(f.queries).toEqual([]);
});

test("prepare decoder refuses foreign target/source/intent, cookie effects and private metadata with rollback", async () => {
  const replies: unknown[] = [
    { ...prepared, target_session_digest: sessionDigest },
    { ...prepared, cookie_effects: [] },
    { ...prepared, operation: { ...prepared.operation, sourceOwnerId: originalSource } },
    { ...prepared, operation: { ...prepared.operation, idempotencyKey: "browser-key" } },
    { ...prepared, prepared: { ...prepared.prepared, intent_id: otherIntentId } },
    {
      ...prepared,
      prepared: {
        ...prepared.prepared,
        account_confirmation: { account_id: "foreign", display_name: null },
      },
    },
  ];
  for (const reply of replies) {
    const f = fixture(reply);
    const error = await failure(f.store.prepareTarget(prepareInput()));
    expect(error).toMatchObject({
      _tag: "ControlPlaneStatementFailed",
      label: "guest-attachment.prepare.decode",
    });
    expect(f.queries.map((q) => q.text)).toContain("ROLLBACK");
    expect(f.queries.map((q) => q.text)).not.toContain("COMMIT");
    privacy(error);
    privacy(f.logs);
  }
});

test("only exact GP001 through GP008 map; unexpected SQLSTATE and driver messages remain private", async () => {
  const cases = new Map([
    ["GP001", "proof-revoked"],
    ["GP002", "owner-mismatch"],
    ["GP003", "authority-conflict"],
    ["GP004", "credential-cleanup-required"],
    ["GP005", "idempotency-conflict"],
    ["GP006", "intent-expired"],
    ["GP007", "ceremony-cleanup-required"],
    ["GP008", "target-changed"],
  ]);
  for (const [sqlState, reason] of cases) {
    const f = fixture(prepared, { sqlState });
    const error = await failure(f.store.prepareTarget(prepareInput()));
    expect(error).toMatchObject({ _tag: "GuestParticipationStoreRejected", reason });
    privacy(error);
    privacy(f.logs);
  }
  for (const sqlState of ["P0001", "42702", "22023", "GP009"]) {
    const error = await failure(
      fixture(prepared, { sqlState }).store.prepareTarget(prepareInput()),
    );
    expect(error).toMatchObject({ _tag: "ControlPlaneStatementFailed", sqlState });
    privacy(error);
  }
});
