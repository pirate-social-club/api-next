import { describe, expect, test } from "bun:test";
import {
  PROVIDER_PRESENTATION_PAYLOAD_MAX_BYTES,
  PROVIDER_PRESENTATION_SESSION_ID_MAX_BYTES,
  PROVIDER_PRESENTATION_URL_MAX_BYTES,
  type ProviderPresentation,
} from "@pirate/contracts";
import { Effect } from "effect";
import type {
  NamespaceOwnershipProviderAdapter,
  NamespaceOwnershipProviderCompleteResult,
} from "./adapter.ts";
import { NAMESPACE_OWNERSHIP_UPSTREAM_SESSION_REF_MAX_BYTES } from "./adapter.ts";
import {
  makeNamespaceOwnershipProviderRegistry,
  NamespaceOwnershipProviderDuplicate,
  NamespaceOwnershipProviderInvalidResponse,
  NamespaceOwnershipProviderUnboundRejected,
  NamespaceOwnershipProviderUnknown,
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
const startContext = { namespace_session_id: "namespace-session-1" } as const;
const completeContext = {
  namespace_session_id: "namespace-session-1",
  observation_id: "completion-attempt-1",
} as const;
const session = {
  ...startInput,
  provider_id: "test.hns-owner",
  upstream_session_ref: "upstream-hns-1",
  expires_at: "2026-08-20T13:00:00.000Z",
};

function adapter(
  options: Readonly<{
    providerId?: string;
    startPresentation?: ProviderPresentation;
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
        presentation: options.startPresentation ?? {
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
    await expect(
      Effect.runPromise(provider.start(startInput, startContext)),
    ).resolves.toMatchObject({
      session: { actor_id: "user-1", request_hash: "b".repeat(64) },
      presentation: { session_id: "upstream-hns-1" },
    });
  });

  test("snapshots and freezes manifest authorization state", async () => {
    const source = adapter();
    const registry = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([source], { now: () => now }),
    );
    const mutableSource = source.manifest as unknown as {
      environments: string[];
      operation_deadlines: { plan_ms: number };
      supported_families: string[];
    };
    mutableSource.environments.push("production");
    mutableSource.supported_families.push("spaces");
    mutableSource.operation_deadlines.plan_ms = 1;

    const listed = registry.list();
    const mutableListed = listed[0] as unknown as {
      environments: string[];
      operation_deadlines: { plan_ms: number };
      supported_families: string[];
    };
    expect(() => mutableListed.environments.push("production")).toThrow();
    expect(() => mutableListed.supported_families.push("spaces")).toThrow();
    expect(() => {
      mutableListed.operation_deadlines.plan_ms = 1;
    }).toThrow();
    expect(() =>
      (listed as unknown as Array<(typeof listed)[number]>).push(
        listed[0] as (typeof listed)[number],
      ),
    ).toThrow();
    expect(listed[0]).toMatchObject({
      supported_families: ["hns"],
      environments: ["staging"],
      operation_deadlines: { plan_ms: 1_000 },
    });
    const listedManifest = listed[0];
    if (listedManifest === undefined) throw new Error("expected the registered manifest");

    await expect(Effect.runPromise(registry.resolve("spaces"))).rejects.toBeInstanceOf(
      NamespaceOwnershipProviderUnknown,
    );
    const provider = await Effect.runPromise(registry.resolve("hns"));
    expect(provider.manifest).toBe(listedManifest);
    await expect(
      Effect.runPromise(provider.plan({ route, environment: "production" })),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderUnboundRejected);
  });

  test("rejects provider session substitution and presentation mismatch", async () => {
    const substituted = adapter({ startSession: { ...session, actor_id: "user-2" } });
    const registry = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([substituted], { now: () => now }),
    );
    const provider = await Effect.runPromise(registry.resolve("hns"));

    await expect(
      Effect.runPromise(provider.start(startInput, startContext)),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderInvalidResponse);
  });

  test("rejects oversized provider presentation and upstream reference fields", async () => {
    const oversizedUrl = "u".repeat(PROVIDER_PRESENTATION_URL_MAX_BYTES + 1);
    const invalidPresentations: readonly ProviderPresentation[] = [
      { kind: "redirect", session_id: "upstream-hns-1", url: oversizedUrl },
      { kind: "deeplink", session_id: "upstream-hns-1", uri: oversizedUrl },
      { kind: "poll", session_id: "upstream-hns-1", poll_url: oversizedUrl },
      {
        kind: "embedded_sdk",
        session_id: "upstream-hns-1",
        protocol: "hns-owner-v1",
        version: "1",
        payload: {
          value: "x".repeat(PROVIDER_PRESENTATION_PAYLOAD_MAX_BYTES),
        },
      },
      {
        kind: "none",
        session_id: "s".repeat(PROVIDER_PRESENTATION_SESSION_ID_MAX_BYTES + 1),
      },
    ];

    for (const startPresentation of invalidPresentations) {
      const registry = await Effect.runPromise(
        makeNamespaceOwnershipProviderRegistry([adapter({ startPresentation })], {
          now: () => now,
        }),
      );
      const provider = await Effect.runPromise(registry.resolve("hns"));
      await expect(
        Effect.runPromise(provider.start(startInput, startContext)),
      ).rejects.toBeInstanceOf(NamespaceOwnershipProviderInvalidResponse);
    }

    const oversizedReference = "r".repeat(NAMESPACE_OWNERSHIP_UPSTREAM_SESSION_REF_MAX_BYTES + 1);
    const registry = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry(
        [
          adapter({
            startSession: { ...session, upstream_session_ref: oversizedReference },
            startPresentation: {
              kind: "poll",
              session_id: oversizedReference,
              poll_url: "/verification/namespace/oversized",
            },
          }),
        ],
        { now: () => now },
      ),
    );
    const provider = await Effect.runPromise(registry.resolve("hns"));
    await expect(
      Effect.runPromise(provider.start(startInput, startContext)),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderInvalidResponse);
  });

  test("rejects undeclared channels and oversized provider submissions before the adapter", async () => {
    const registry = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([adapter()], { now: () => now }),
    );
    const provider = await Effect.runPromise(registry.resolve("hns"));

    await expect(
      Effect.runPromise(
        provider.complete(
          {
            session,
            submission: { channel: "client_result", payload: {} },
          },
          completeContext,
        ),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderUnboundRejected);
    await expect(
      Effect.runPromise(
        provider.complete(
          {
            session,
            submission: { channel: "poll_result", payload: "x".repeat(1_048_577) },
          },
          completeContext,
        ),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderUnboundRejected);
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
      evidence_kind: "raw_provider_response_v1" as const,
      provider_evidence_ref: "hns-observation-1",
      raw_response_bytes: new TextEncoder().encode('{"status":"verified"}'),
      observation: { status: "verified" } as const,
      observed_at: "2026-08-20T12:00:00.000Z",
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
        acceptedProvider.complete(
          {
            session,
            submission: { channel: "poll_result", payload: {} },
          },
          completeContext,
        ),
      ),
    ).resolves.toEqual(verified);

    const late = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry(
        [
          adapter({
            completeResult: {
              ...verified,
              observed_at: "2026-08-20T13:00:00.001Z",
            },
          }),
        ],
        { now: () => now },
      ),
    );
    const lateProvider = await Effect.runPromise(late.resolve("hns"));
    await expect(
      Effect.runPromise(
        lateProvider.complete(
          {
            session,
            submission: { channel: "poll_result", payload: {} },
          },
          completeContext,
        ),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderInvalidResponse);

    for (const expiresAt of ["2026-08-20T11:59:59.999Z", "2026-08-20T12:00:00.000Z"]) {
      const stale = await Effect.runPromise(
        makeNamespaceOwnershipProviderRegistry(
          [
            adapter({
              completeResult: {
                ...verified,
                observed_at: "2026-08-20T11:00:00.000Z",
                expires_at: expiresAt,
              },
            }),
          ],
          { now: () => now },
        ),
      );
      const staleProvider = await Effect.runPromise(stale.resolve("hns"));
      await expect(
        Effect.runPromise(
          staleProvider.complete(
            {
              session,
              submission: { channel: "poll_result", payload: {} },
            },
            completeContext,
          ),
        ),
      ).rejects.toBeInstanceOf(NamespaceOwnershipProviderInvalidResponse);
    }

    const noExpiryResult = { ...verified, expires_at: null };
    const noExpiry = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([adapter({ completeResult: noExpiryResult })], {
        now: () => now,
      }),
    );
    const noExpiryProvider = await Effect.runPromise(noExpiry.resolve("hns"));
    await expect(
      Effect.runPromise(
        noExpiryProvider.complete(
          {
            session,
            submission: { channel: "poll_result", payload: {} },
          },
          completeContext,
        ),
      ),
    ).resolves.toEqual(noExpiryResult);
  });
});
