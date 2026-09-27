import { describe, expect, test } from "bun:test";
import type { HnsPollResultCompletionResponseV1 } from "@pirate/contracts";
import { Effect, Exit } from "effect";
import type { HnsCommunityRootImportPreparation } from "./hns-community-root-import.ts";
import {
  checkHnsTxtAttachment,
  getCurrentHnsTxtAttachment,
  type HnsTxtAttachmentState,
  type HnsTxtAttachmentStore,
  hnsTxtAttachmentResponse,
  startHnsTxtAttachment,
} from "./hns-txt-attachment.ts";

const future = new Date(Date.now() + 3_600_000).toISOString();
const past = new Date(Date.now() - 1_000).toISOString();
const upstream = `nvs_${"a".repeat(48)}`;

function state(overrides: Partial<HnsTxtAttachmentState> = {}): HnsTxtAttachmentState {
  return {
    attachment_intent_id: "intent-1",
    root_label: "harbor",
    intent_status: "verification_required",
    intent_expires_at: future,
    ownership: {
      namespace_session_id: "session-1",
      ceremony_intent_id: "ceremony-1",
      expected_revision: 1,
      status: "pending",
      upstream_session_ref: upstream,
      expires_at: future,
    },
    route_href: null,
    ...overrides,
  };
}

const preparation: HnsCommunityRootImportPreparation = {
  actor_id: "actor",
  community_id: "community",
  attachment_intent_id: "intent-1",
  ceremony_intent_id: "ceremony-1",
  ceremony_generation: 1,
  root_label: "harbor",
  attachment_revision: 1,
  root_import_session_id: "unused-session",
  provision_job_id: "unused-job",
  start_idempotency_key: "start",
  start_request_sha256: "b".repeat(64),
};

function memoryStore(initial: HnsTxtAttachmentState | null) {
  let current = initial;
  const commits: string[] = [];
  const store: HnsTxtAttachmentStore = {
    load: () => Effect.succeed({ kind: "authorized", state: current } as const),
    commit: (input) =>
      Effect.sync(() => {
        commits.push(input.attachment_intent_id);
        if (current === null || current.intent_status !== "commit_ready") {
          return { kind: "conflict" } as const;
        }
        current = {
          ...current,
          intent_status: "committed",
          route_href: `/c/${current.root_label}`,
        };
        return { kind: "committed" } as const;
      }),
  };
  return {
    store,
    commits,
    set: (next: HnsTxtAttachmentState) => {
      current = next;
    },
  };
}

function completionReturning(
  status: HnsPollResultCompletionResponseV1["status"],
  onCall: () => void = () => {},
) {
  return {
    complete: () =>
      Effect.sync(() => {
        onCall();
        return {
          operation_kind: "route_attachment",
          community_id: "community",
          attachment_intent_id: "intent-1",
          ceremony_intent_id: "ceremony-1",
          session_id: "session-1",
          revision: 2,
          status,
          replayed: false,
          result_hash: status === "verified" ? "c".repeat(64) : null,
          retry_after_seconds: status === "pending" ? 15 : null,
        } as unknown as HnsPollResultCompletionResponseV1;
      }),
  };
}

const checkInput = {
  actor_id: "actor",
  community_id: "community",
  attachment_intent_id: "intent-1",
  idempotency_key: "check-1",
};

describe("hnsTxtAttachmentResponse", () => {
  test("shows the challenge while the TXT is awaited", () => {
    expect(hnsTxtAttachmentResponse(state(), Date.now())).toEqual({
      attachment_intent_id: "intent-1",
      root_label: "harbor",
      status: "awaiting_txt",
      challenge: { name: "harbor", value: `pirate-verification=${upstream}` },
      expires_at: future,
      route_href: null,
      retry_after_seconds: null,
    });
  });

  test("an elapsed challenge is expired and hides its value", () => {
    const expired = hnsTxtAttachmentResponse(
      state({ ownership: { ...state().ownership!, expires_at: past } }),
      Date.now(),
    );
    expect(expired.status).toBe("expired");
    expect(expired.challenge).toBeNull();
  });

  test("a committed attachment reports its public route", () => {
    const attached = hnsTxtAttachmentResponse(
      state({ intent_status: "committed", route_href: "/c/harbor" }),
      Date.now(),
    );
    expect(attached).toMatchObject({
      status: "attached",
      route_href: "/c/harbor",
      challenge: null,
    });
  });

  test("a rejected ownership check is reported as rejected", () => {
    const rejected = hnsTxtAttachmentResponse(
      state({ intent_status: "failed", ownership: { ...state().ownership!, status: "failed" } }),
      Date.now(),
    );
    expect(rejected.status).toBe("rejected");
  });
});

describe("startHnsTxtAttachment", () => {
  test("issues the challenge without creating a root-import session", async () => {
    const memory = memoryStore(state());
    let prepared = 0;
    const result = await Effect.runPromise(
      startHnsTxtAttachment(
        {
          actor_id: "actor",
          community_id: "community",
          root_label: "harbor",
          idempotency_key: "k",
        },
        {
          ownership: {
            start: () =>
              Effect.succeed({
                operation_kind: "route_attachment",
                community_id: "community",
                attachment_intent_id: "intent-1",
                ceremony_intent_id: "ceremony-1",
                generation: 1,
                session_id: "session-1",
                channel: "poll_result",
                status: "pending",
                expires_at: future,
                challenge: {
                  ownership_source: "hns_parent_chain_txt",
                  challenge_name: "harbor",
                  challenge_value: `pirate-verification=${upstream}`,
                  expires_at: future,
                },
                replayed: false,
              } as never),
          },
          store: {
            ...memory.store,
            prepare: () =>
              Effect.sync(() => {
                prepared += 1;
                return { kind: "created", value: preparation } as const;
              }),
          },
        },
      ),
    );
    expect(prepared).toBe(1);
    expect(result.status).toBe("awaiting_txt");
    expect(result.challenge?.value).toBe(`pirate-verification=${upstream}`);
  });

  test("reports the daily limit with its retry time", async () => {
    const memory = memoryStore(null);
    const exit = await Effect.runPromiseExit(
      startHnsTxtAttachment(
        {
          actor_id: "actor",
          community_id: "community",
          root_label: "harbor",
          idempotency_key: "k",
        },
        {
          ownership: { start: () => Effect.die("no challenge when rate limited") },
          store: {
            ...memory.store,
            prepare: () =>
              Effect.succeed({ kind: "rate_limited", retry_after_seconds: 3_600 } as const),
          },
        },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("rate_limited");
  });
});

describe("checkHnsTxtAttachment", () => {
  test("a pending chain observation keeps awaiting and commits nothing", async () => {
    const memory = memoryStore(state());
    const result = await Effect.runPromise(
      checkHnsTxtAttachment(checkInput, {
        completion: completionReturning("pending"),
        store: memory.store,
      }),
    );
    expect(result.status).toBe("awaiting_txt");
    expect(result.retry_after_seconds).toBe(15);
    expect(memory.commits).toEqual([]);
  });

  test("a verified observation commits the route", async () => {
    const memory = memoryStore(state());
    const result = await Effect.runPromise(
      checkHnsTxtAttachment(checkInput, {
        completion: completionReturning("verified", () =>
          memory.set(state({ intent_status: "commit_ready" })),
        ),
        store: memory.store,
      }),
    );
    expect(memory.commits).toEqual(["intent-1"]);
    expect(result).toMatchObject({ status: "attached", route_href: "/c/harbor" });
  });

  test("a verified attachment whose commit was interrupted is committed on the next check", async () => {
    const memory = memoryStore(state({ intent_status: "commit_ready" }));
    let completions = 0;
    const result = await Effect.runPromise(
      checkHnsTxtAttachment(checkInput, {
        completion: completionReturning("verified", () => {
          completions += 1;
        }),
        store: memory.store,
      }),
    );
    expect(completions).toBe(0);
    expect(result.status).toBe("attached");
  });

  test("an unauthorized actor is refused as not found", async () => {
    const exit = await Effect.runPromiseExit(
      getCurrentHnsTxtAttachment(
        { actor_id: "actor", community_id: "community" },
        {
          store: {
            load: () => Effect.succeed({ kind: "unauthorized" } as const),
            commit: () => Effect.die("unused"),
          },
        },
      ),
    );
    expect(JSON.stringify(exit)).toContain("not_found");
  });
});
