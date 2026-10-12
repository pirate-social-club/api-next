import { expect, test } from "bun:test";
import type {
  GuestAuthorityStore,
  GuestCookieEffect,
} from "@pirate/application/guest-participation-authority";
import { Cause, Effect, Exit, Option } from "effect";
import { makeControlPlaneGuestAuthorityTransitions } from "./guest-authority-store.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

const origin = "https://community.example";
const source = "owner_00000000-0000-0000-0000-000000000001";
const aliasRoot = "owner_00000000-0000-0000-0000-000000000002";
const issuedId = "AAAAAAAAAAAAAAAAAAAAAA";
const carriedId = "BBBBBBBBBBBBBBBBBBBBBA";
const digest = "a".repeat(64);
const requestHash = "b".repeat(64);
const issuanceKey = "issuance-key-one";
const metadata = {
  owner_id: source,
  credential_id: issuedId,
  credential_state: "pending_bootstrap",
  session_until: null,
};
const authority = {
  object: "guest_authority",
  state: "pending",
  selected: metadata,
  proved_credentials: [metadata],
  pointer_repair: null,
};
const completed = {
  state: "completed",
  operation_id: "immutable-original-operation",
  operation: {
    sourceOwnerId: source,
    kind: "bootstrap_issue",
    idempotencyKey: issuanceKey,
    requestHash,
  },
  authority,
  cookie_effects: [{ kind: "credential", action: "issue", credentialId: issuedId }],
};
const issueInput: Parameters<GuestAuthorityStore["issuePending"]>[0] = {
  context: {
    origin,
    authority: "bootstrap",
    operation: "issue",
    originAndCsrfChecked: true,
    provedCredentials: [],
    provedIntents: [],
    selected: null,
  },
  issuance: {
    operation: {
      sourceOwnerId: source,
      kind: "bootstrap_issue",
      idempotencyKey: issuanceKey,
      requestHash,
    },
    credentialId: issuedId,
    tokenDigest: digest,
    pendingExpiresAt: "2026-10-12T18:15:00.000Z",
  },
  newOwnerId: source,
};

function fixture(
  reply: unknown = completed,
  options: { commitFails?: boolean; sqlState?: string } = {},
) {
  const queries: PostgresQueryConfig[] = [];
  const logs: unknown[] = [];
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      queries.push(query);
      if (query.text === "COMMIT" && options.commitFails)
        throw new Error("fixture COMMIT acknowledgement lost");
      if (
        /^SELECT (issue_guest_pending_v1|discover_guest_authority_v1|cleanup_guest_authority_v1)/u.test(
          query.text,
        )
      ) {
        if (options.sqlState)
          throw Object.assign(new Error("opaque driver message"), { code: options.sqlState });
        return { rows: [{ result: reply }], rowCount: 1 };
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
    store: makeControlPlaneGuestAuthorityTransitions(runtime, () => "fresh-candidate-operation"),
    queries,
    logs,
  };
}
async function failure(effect: Effect.Effect<unknown, unknown>) {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const found = Cause.findErrorOption(exit.cause);
  if (!Option.isSome(found)) throw new Error("expected typed failure");
  return found.value;
}

test("COMMIT uncertainty publishes no outcome or cookie effects", async () => {
  const f = fixture(completed, { commitFails: true });
  const published: GuestCookieEffect[] = [];
  let outcomes = 0;
  const error = await failure(
    f.store.issuePending(issueInput).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          outcomes += 1;
          if (outcome.state === "completed") published.push(...outcome.result.cookieEffects);
        }),
      ),
    ),
  );
  expect(error).toMatchObject({ _tag: "ControlPlaneTransactionOutcomeUnknown", phase: "commit" });
  expect(outcomes).toBe(0);
  expect(published).toEqual([]);
  expect(f.queries.map((q) => q.text)).toContain("COMMIT");
  expect(JSON.stringify(error)).not.toContain(digest);
});

test("fresh issuance publishes only after acknowledged COMMIT and never returns its digest", async () => {
  const f = fixture();
  const outcome = await Effect.runPromise(
    f.store.issuePending(issueInput).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(f.queries.at(-1)?.text).toBe("COMMIT");
        }),
      ),
    ),
  );
  expect(outcome).toMatchObject({
    state: "completed",
    operation: completed.operation,
    outcomeId: completed.operation_id,
    result: { cookieEffects: completed.cookie_effects },
  });
  expect(JSON.stringify(outcome)).not.toContain(digest);
});

test("unknown-row malformed/excess/duplicate/unproved/wrong issued-cookie metadata rolls back before COMMIT", async () => {
  const bad: unknown[] = [
    ...["confirmed", "revoked", "pending_successor"].map((credential_state) => {
      const wrong = { ...metadata, credential_state };
      return {
        ...completed,
        authority: { ...authority, selected: wrong, proved_credentials: [wrong] },
      };
    }),
    null,
    { ...completed, secret_digest: digest },
    { ...completed, operation: undefined },
    { ...completed, authority: { ...authority, selected: null } },
    { ...completed, authority: { ...authority, proved_credentials: [metadata, metadata] } },
    {
      ...completed,
      authority: { ...authority, proved_credentials: [{ ...metadata, credential_id: carriedId }] },
    },
    { ...completed, operation: { ...completed.operation, requestHash: digest } },
    {
      ...completed,
      cookie_effects: [{ kind: "credential", action: "issue", credentialId: carriedId }],
    },
    {
      ...completed,
      cookie_effects: [{ kind: "credential", action: "expire", credentialId: issuedId }],
    },
    { ...completed, cookie_effects: [completed.cookie_effects[0], completed.cookie_effects[0]] },
  ];
  for (const reply of bad) {
    const f = fixture(reply);
    const error = await failure(f.store.issuePending(issueInput));
    expect(error).toMatchObject({
      _tag: "ControlPlaneStatementFailed",
      label: "guest-authority.issue.decode",
    });
    const commands = f.queries.map((q) => q.text);
    expect(commands).toContain("ROLLBACK");
    expect(commands).not.toContain("COMMIT");
    expect(JSON.stringify(error)).not.toContain(digest);
    expect(JSON.stringify(error)).not.toContain("secret_digest");
    expect(JSON.stringify(f.logs)).not.toContain(digest);
  }
});

test("only exact GP001 through GP005 map to safe semantic reasons", async () => {
  const cases = new Map([
    ["GP001", "proof-revoked"],
    ["GP002", "owner-mismatch"],
    ["GP003", "authority-conflict"],
    ["GP004", "credential-cleanup-required"],
    ["GP005", "idempotency-conflict"],
  ]);
  for (const [sqlState, reason] of cases) {
    const f = fixture(completed, { sqlState });
    const error = await failure(f.store.issuePending(issueInput));
    expect(error).toMatchObject({ _tag: "GuestParticipationStoreRejected", reason });
    expect(f.queries.map((q) => q.text)).toContain("ROLLBACK");
    expect(JSON.stringify(error)).not.toContain("opaque driver message");
  }
  for (const sqlState of ["P0001", "42702", "22023", "GP006"]) {
    const error = await failure(fixture(completed, { sqlState }).store.issuePending(issueInput));
    expect(error).toMatchObject({ _tag: "ControlPlaneStatementFailed", sqlState });
    expect(JSON.stringify(error)).not.toContain("opaque driver message");
  }
});

test("proved issuance replay preserves immutable original operation source after empty aliasing", async () => {
  const carried = { ...metadata, owner_id: aliasRoot, credential_id: carriedId };
  const replay = {
    ...completed,
    authority: { ...authority, selected: carried, proved_credentials: [carried] },
    cookie_effects: [],
  };
  const f = fixture(replay);
  const context: Parameters<GuestAuthorityStore["issuePending"]>[0]["context"] = {
    ...issueInput.context,
    provedCredentials: [
      {
        ownerId: aliasRoot,
        credentialId: carriedId,
        origin,
        state: "pending_bootstrap",
        leaseUntil: null,
        pendingExpiresAt: "2026-10-12T18:15:00.000Z",
        predecessorCredentialId: null,
      },
    ],
    selected: {
      ownerId: aliasRoot,
      credentialId: carriedId,
      origin,
      state: "pending_bootstrap",
      leaseUntil: null,
      pendingExpiresAt: "2026-10-12T18:15:00.000Z",
      predecessorCredentialId: null,
    },
  };
  const outcome = await Effect.runPromise(
    f.store.issuePending({
      ...issueInput,
      context,
      issuance: {
        ...issueInput.issuance,
        operation: { ...issueInput.issuance.operation, sourceOwnerId: aliasRoot },
      },
    }),
  );
  expect(outcome).toMatchObject({
    state: "completed",
    operation: completed.operation,
    outcomeId: "immutable-original-operation",
    result: { authority: { selected: carried }, cookieEffects: [] },
  });
  expect(f.queries.map((q) => q.text)).toContain("COMMIT");
});

test("lost proof restart rejection emits no cookie or synthetic durable outcome", async () => {
  const f = fixture({ state: "issuance_requires_restart" });
  let outcomes = 0;
  const error = await failure(
    f.store.issuePending(issueInput).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          outcomes += 1;
        }),
      ),
    ),
  );
  expect(error).toMatchObject({
    _tag: "GuestParticipationStoreRejected",
    reason: "issuance-requires-restart",
  });
  expect(outcomes).toBe(0);
  expect(f.queries.map((q) => q.text)).toContain("COMMIT");
});

test("discovery returns only proved metadata and validates exact pointer repair without selecting it", async () => {
  const credential = {
    ownerId: source,
    credentialId: issuedId,
    origin,
    state: "confirmed",
    leaseUntil: "2026-10-12T19:00:00.000Z",
    pendingExpiresAt: null,
    predecessorCredentialId: carriedId,
  } satisfies Parameters<
    GuestAuthorityStore["discover"]
  >[0]["context"]["provedCredentials"][number];
  const current = {
    ...metadata,
    credential_state: "confirmed",
    session_until: credential.leaseUntil,
  };
  const reply = {
    ...authority,
    state: "recovery_required",
    selected: null,
    proved_credentials: [current],
    pointer_repair: {
      previous_credential_id: carriedId,
      credential_id: issuedId,
      owner_id: source,
    },
  };
  const input: Parameters<GuestAuthorityStore["discover"]>[0] = {
    context: {
      origin,
      authority: "bootstrap",
      operation: "discover",
      provedCredentials: [credential],
      provedIntents: [],
      selected: null,
    },
    expectedOwnerId: source,
    previousCredentialId: carriedId,
  };
  const result = await Effect.runPromise(fixture(reply).store.discover(input));
  expect(result.selected).toBeNull();
  expect(result.pointer_repair).toEqual(reply.pointer_repair);
  for (const invalid of [
    { ...reply, pointer_repair: { ...reply.pointer_repair, credential_id: carriedId } },
    { ...reply, pointer_repair: { ...reply.pointer_repair, previous_credential_id: issuedId } },
    { ...reply, selected: current },
  ]) {
    const f = fixture(invalid);
    expect(await failure(f.store.discover(input))).toMatchObject({
      _tag: "ControlPlaneStatementFailed",
      label: "guest-authority.discover.decode",
    });
    expect(f.queries.map((q) => q.text)).toContain("ROLLBACK");
    expect(f.queries.map((q) => q.text)).not.toContain("COMMIT");
  }
});

test("cleanup never selects singleton metadata and rejects an expiry effect outside its proved candidates", async () => {
  const credential = {
    ownerId: source,
    credentialId: issuedId,
    origin,
    state: "confirmed",
    leaseUntil: "2026-10-12T19:00:00.000Z",
    pendingExpiresAt: null,
    predecessorCredentialId: null,
  } satisfies Parameters<GuestAuthorityStore["cleanup"]>[0]["context"]["provedCredentials"][number];
  const input: Parameters<GuestAuthorityStore["cleanup"]>[0] = {
    context: {
      origin,
      authority: "recovery",
      operation: "cleanup",
      originAndCsrfChecked: true,
      provedCredentials: [credential],
      provedIntents: [],
      selected: null,
    },
    selectedCredentialId: null,
    candidateCredentialIds: [issuedId],
    candidateIntentIds: [],
  };
  const reply = {
    authority: {
      ...authority,
      state: "authority_conflict",
      selected: null,
      proved_credentials: [{ ...metadata, credential_state: "revoked" }],
    },
    cookieEffects: [{ kind: "credential", action: "expire", credentialId: issuedId }],
  };
  expect(await Effect.runPromise(fixture(reply).store.cleanup(input))).toEqual(reply);
  const invalid = fixture({
    ...reply,
    cookieEffects: [{ kind: "credential", action: "expire", credentialId: carriedId }],
  });
  expect(await failure(invalid.store.cleanup(input))).toMatchObject({
    _tag: "ControlPlaneStatementFailed",
    label: "guest-authority.cleanup.decode",
  });
  expect(invalid.queries.map((q) => q.text)).toContain("ROLLBACK");
  const wrongSelection = fixture(reply);
  expect(
    await failure(wrongSelection.store.cleanup({ ...input, selectedCredentialId: issuedId })),
  ).toMatchObject({ _tag: "GuestParticipationStoreRejected", reason: "owner-mismatch" });
  expect(wrongSelection.queries).toEqual([]);
});
