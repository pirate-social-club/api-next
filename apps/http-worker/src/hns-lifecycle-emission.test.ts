import { expect, test } from "bun:test";
import {
  type HnsRootImportLifecycleProjectionV1,
  projectHnsRootImportLifecycleV1,
} from "@pirate/application/namespace-ownership";
import { HnsCommunityRootImportSessionResponseV1 } from "@pirate/contracts";
import { HNS_ROOT_IMPORT_POLICY_V1 } from "@pirate/domain";
import { Effect, Schema } from "effect";
import { makeHnsCommunityRootImportHandlers } from "./hns-community-root-import-handlers.ts";
import { createHttpWorker } from "./transport.ts";

/**
 * The lifecycle a client sees is the lifecycle the server persisted.
 *
 * The projection field existed in the contract and nothing ever populated it,
 * so a client had no server-decided phase, deadline or evidence to render and
 * would have had to infer them from the coarse session status. These assert the
 * emission end of that path: what the store returns reaches the wire unchanged
 * and still satisfies the contract, an operation with no persisted lifecycle
 * emits no projection rather than a synthesised one, and the route still
 * refuses an unauthenticated caller.
 */

const communityId = "community-lifecycle";
const sessionId = "import-lifecycle";
const now = Date.UTC(2026, 8, 10, 12, 0, 0);

const session = {
  community_id: communityId,
  attachment_intent_id: "attachment-lifecycle",
  root_import_session_id: sessionId,
  root_label: "newroot",
  revision: 3,
  expires_at: "2099-01-01T00:00:00.000Z",
  replayed: false,
  status: "observing" as const,
  publication_check_pending: false,
  publish_plan: {
    version: "pirate-hns-root-import-publish-plan-v1" as const,
    replacement_semantics: "complete_resource" as const,
    current_records: [],
    preserved_records: [],
    removed_conflicts: [],
    added_records: [],
    replacement_records: [{ type: "NS", ns: "ns1.pirate." }],
    preserved_unknown_record_types: [],
    encoded_resource_sha256: "1".repeat(64),
    acknowledgement_required: true as const,
  },
  publish_plan_sha256: "2".repeat(64),
  readiness_result_sha256: null,
  retry_after_seconds: 5,
};

/** A projection built the way the adapter builds it, from persisted state. */
function projection(
  overrides: Partial<Parameters<typeof projectHnsRootImportLifecycleV1>[0]> = {},
  observation: HnsRootImportLifecycleProjectionV1["observation"] = null,
): HnsRootImportLifecycleProjectionV1 {
  return projectHnsRootImportLifecycleV1(
    {
      phase: "waiting_safe_commitment",
      revision: 4,
      generation: 1,
      plan_exposed_at_epoch_ms: now - 3_600_000,
      publication_deadline_at_epoch_ms:
        now + HNS_ROOT_IMPORT_POLICY_V1.publication_window_seconds * 1_000,
      first_current_observation_at_epoch_ms: now - 600_000,
      finality_deadline_at_epoch_ms:
        now + HNS_ROOT_IMPORT_POLICY_V1.finality_window_seconds * 1_000,
      readiness_observed_at_epoch_ms: null,
      pending_reason: "waiting_safe_commitment",
      next_check_at_epoch_ms: now + 900_000,
      observation_count: 2,
      consecutive_operational_failures: 0,
      last_useful_error: null,
      last_useful_error_at_epoch_ms: null,
      applied_event_ids: new Set<string>(),
      terminal_decided_at_epoch_ms: null,
      ...overrides,
    },
    { server_now_epoch_ms: now, observation },
  );
}

function handlersReturning(value: unknown) {
  return makeHnsCommunityRootImportHandlers({
    store: { get: () => Effect.succeed(value) },
  } as unknown as Parameters<typeof makeHnsCommunityRootImportHandlers>[0]);
}

const request = {
  principal: { kind: "user" as const, subject: "actor-lifecycle" },
  params: { communityId, sessionId },
  body: undefined,
} as never;

test("the persisted lifecycle reaches the wire unchanged and satisfies the contract", async () => {
  const observation = {
    view: "safe" as const,
    resource_sha256: "3".repeat(64),
    tip_height: 3_260,
    update_inclusion_height: 3_248,
    commitment_height: 3_255,
  };
  const lifecycle = projection({}, observation);
  const handlers = handlersReturning({ ...session, lifecycle });
  const result = (await handlers.GetHnsCommunityRootImport(request)) as {
    readonly status: number;
    readonly body: Readonly<{ lifecycle: HnsRootImportLifecycleProjectionV1 }>;
  };
  expect(result.status).toBe(200);
  expect(result.body.lifecycle).toEqual(lifecycle);
  expect(Schema.is(HnsCommunityRootImportSessionResponseV1)(result.body)).toBe(true);

  // The three heights stay distinct on the wire. Reporting the tip as the
  // inclusion height would tell an owner their name is included when it is not.
  expect(result.body.lifecycle.observation).toEqual(observation);
  expect(result.body.lifecycle.phase).toBe("waiting_safe_commitment");
  expect(result.body.lifecycle.deadline).toEqual({
    kind: "finality",
    at: new Date(now + HNS_ROOT_IMPORT_POLICY_V1.finality_window_seconds * 1_000).toISOString(),
  });
  expect(result.body.lifecycle.permitted_actions).toEqual(["poll"]);
  expect(result.body.lifecycle.retry_hint_seconds).toBe(900);
});

test("an operation with no persisted lifecycle emits no projection at all", async () => {
  const handlers = handlersReturning(session);
  const result = (await handlers.GetHnsCommunityRootImport(request)) as {
    readonly body: Record<string, unknown>;
  };
  // Absent, not null and not synthesised: the server has nothing to report,
  // and a projection derived from the session status would be an inference.
  expect("lifecycle" in result.body).toBe(false);
  expect(Schema.is(HnsCommunityRootImportSessionResponseV1)(result.body)).toBe(true);
});

test("different observed records produce different emitted evidence", async () => {
  const first = projection(
    {},
    {
      view: "current",
      resource_sha256: "a".repeat(64),
      tip_height: 3_260,
      update_inclusion_height: 3_248,
      commitment_height: null,
    },
  );
  const second = projection(
    {},
    {
      view: "safe",
      resource_sha256: "b".repeat(64),
      tip_height: 3_300,
      update_inclusion_height: 3_248,
      commitment_height: 3_295,
    },
  );
  expect(first.observation).not.toEqual(second.observation);
  for (const lifecycle of [first, second]) {
    const handlers = handlersReturning({ ...session, lifecycle });
    const result = (await handlers.GetHnsCommunityRootImport(request)) as {
      readonly body: Readonly<{ lifecycle: HnsRootImportLifecycleProjectionV1 }>;
    };
    expect(result.body.lifecycle.observation).toEqual(lifecycle.observation);
    expect(Schema.is(HnsCommunityRootImportSessionResponseV1)(result.body)).toBe(true);
  }
});

test("phase drives the permitted actions the client may offer", () => {
  const cases = [
    ["awaiting_publication", ["poll", "acknowledge"]],
    ["checking_publication", ["poll", "check_publication"]],
    ["waiting_safe_commitment", ["poll"]],
    ["checking_authority", ["poll", "refresh_readiness"]],
    ["ready", ["poll", "activate"]],
    ["recovery_required", ["poll", "recover"]],
    ["failed", ["poll"]],
  ] as const;
  for (const [phase, actions] of cases) {
    // Activation is offered only in `ready`: an action list derived from the
    // session status rather than the phase would offer it in `observing` too.
    expect(projection({ phase }).permitted_actions).toEqual([...actions]);
  }
});

test("the route still refuses an unauthenticated caller", async () => {
  const app = createHttpWorker({
    handlers: handlersReturning({ ...session, lifecycle: projection() }),
    authenticate: ({ credentials }: { credentials: { authorization?: string } }) => ({
      kind: "user" as const,
      subject: credentials.authorization ?? "",
    }),
    authorize: ({ input }: { input: { principal: unknown } }) => {
      if (input.principal === null) throw new Error("Missing principal");
    },
  } as never);
  const url = `https://worker.test/communities/${communityId}/hns-root-imports/${sessionId}`;
  expect((await app.request(url)).status).toBe(401);
  const authorized = await app.request(url, { headers: { authorization: "actor-lifecycle" } });
  expect(authorized.status).toBe(200);
  expect(authorized.headers.get("cache-control")).toBe("no-store");
  const body = (await authorized.json()) as Record<string, unknown>;
  expect(body.lifecycle).toBeDefined();
});
