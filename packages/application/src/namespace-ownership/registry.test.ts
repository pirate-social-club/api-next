import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type {
  NamespaceOwnershipProviderAdapter,
  NamespaceOwnershipProviderCompleteResult,
} from "./adapter.ts";
import {
  makeNamespaceOwnershipProviderRegistry,
  NamespaceOwnershipProviderDuplicate,
  NamespaceOwnershipProviderInvalidResponse,
  NamespaceOwnershipProviderRejected,
} from "./index.ts";

const now = Date.parse("2026-08-20T12:00:00.000Z");
const route = {
  family: "hns" as const,
  root_label: "xn--4v8h",
  root_label_display: "🔥",
  path_segment: "app.xn--4v8h",
  href: "/c/app.xn--4v8h",
  app_host: null,
};
const providerConfiguration = {
  kind: "dynamic" as const,
  reference: "test-hns-verifier",
  version: "1",
};
const startInput = {
  actor_id: "user-1",
  creation_intent_id: "creation-1",
  ceremony_intent_id: "ceremony-1",
  requirement_hash: "a".repeat(64),
  generation: 1,
  request_hash: "b".repeat(64),
  provider_binding_hash: "c".repeat(64),
  provider_configuration: providerConfiguration,
  protocol_version: "hns-owner-txt-v1",
  environment: "staging",
  route,
};
const session = {
  ...startInput,
  provider_id: "test.hns-owner",
  upstream_session_ref: "upstream-hns-1",
  expires_at: "2026-08-20T13:00:00.000Z",
};

function adapter(
  options: Readonly<{
    providerId?: string;
    startSession?: typeof session;
    completeResult?: NamespaceOwnershipProviderCompleteResult;
  }> = {},
): NamespaceOwnershipProviderAdapter {
  const providerId = options.providerId ?? "test.hns-owner";
  return {
    manifest: {
      provider_id: providerId,
      manifest_version: "1",
      supported_families: ["hns"],
      protocol_versions: ["hns-owner-txt-v1"],
      environments: ["staging"],
      submission_channels: ["poll_result"],
      operation_deadlines: { plan_ms: 1_000, start_ms: 5_000, complete_ms: 15_000 },
    },
    plan: () =>
      Effect.succeed({
        status: "supported" as const,
        provider_configuration: providerConfiguration,
        protocol_version: "hns-owner-txt-v1",
      }),
    start: () =>
      Effect.succeed({
        session: options.startSession ?? { ...session, provider_id: providerId },
        presentation: {
          kind: "poll" as const,
          session_id: "upstream-hns-1",
          poll_url: "/verification/namespace/upstream-hns-1",
        },
      }),
    complete: () => Effect.succeed(options.completeResult ?? { status: "pending" as const }),
  };
}

describe("namespace ownership provider registry", () => {
  test("resolves one guarded provider per family", async () => {
    const registry = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([adapter()], { now: () => now }),
    );
    expect(registry.list().map((manifest) => manifest.provider_id)).toEqual(["test.hns-owner"]);

    const provider = await Effect.runPromise(registry.resolve("hns"));
    await expect(
      Effect.runPromise(provider.plan({ route, environment: "staging" })),
    ).resolves.toMatchObject({ status: "supported", protocol_version: "hns-owner-txt-v1" });
    await expect(Effect.runPromise(provider.start(startInput))).resolves.toMatchObject({
      session: { actor_id: "user-1", request_hash: "b".repeat(64) },
      presentation: { session_id: "upstream-hns-1" },
    });
  });

  test("rejects provider session substitution and presentation mismatch", async () => {
    const substituted = adapter({ startSession: { ...session, actor_id: "user-2" } });
    const registry = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([substituted], { now: () => now }),
    );
    const provider = await Effect.runPromise(registry.resolve("hns"));

    await expect(Effect.runPromise(provider.start(startInput))).rejects.toBeInstanceOf(
      NamespaceOwnershipProviderInvalidResponse,
    );
  });

  test("rejects undeclared channels and oversized provider submissions before the adapter", async () => {
    const registry = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([adapter()], { now: () => now }),
    );
    const provider = await Effect.runPromise(registry.resolve("hns"));

    await expect(
      Effect.runPromise(
        provider.complete({
          session,
          submission: { channel: "client_result", payload: {} },
        }),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderRejected);
    await expect(
      Effect.runPromise(
        provider.complete({
          session,
          submission: { channel: "poll_result", payload: "x".repeat(1_048_577) },
        }),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderRejected);
  });

  test("rejects duplicate provider authority for one family", async () => {
    await expect(
      Effect.runPromise(
        makeNamespaceOwnershipProviderRegistry([
          adapter(),
          adapter({ providerId: "test.other-hns-owner" }),
        ]),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderDuplicate);
  });

  test("accepts only completion evidence observed within the live ceremony", async () => {
    const verified = {
      status: "verified" as const,
      provider_evidence_ref: "hns-observation-1",
      evidence_digest: "d".repeat(64),
      provider_identity_digest: "e".repeat(64),
      verified_at: "2026-08-20T12:00:00.000Z",
      expires_at: "2026-09-20T12:00:00.000Z",
    };
    const accepted = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([adapter({ completeResult: verified })], {
        now: () => now,
      }),
    );
    const acceptedProvider = await Effect.runPromise(accepted.resolve("hns"));
    await expect(
      Effect.runPromise(
        acceptedProvider.complete({
          session,
          submission: { channel: "poll_result", payload: {} },
        }),
      ),
    ).resolves.toEqual(verified);

    const late = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry(
        [
          adapter({
            completeResult: {
              ...verified,
              verified_at: "2026-08-20T13:00:00.001Z",
            },
          }),
        ],
        { now: () => now },
      ),
    );
    const lateProvider = await Effect.runPromise(late.resolve("hns"));
    await expect(
      Effect.runPromise(
        lateProvider.complete({
          session,
          submission: { channel: "poll_result", payload: {} },
        }),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderInvalidResponse);
  });
});
