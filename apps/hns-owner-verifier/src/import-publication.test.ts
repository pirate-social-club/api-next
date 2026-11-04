import { describe, expect, test } from "bun:test";
import {
  HNS_TXT_IMPORT_PROTOCOL_VERSION,
  type HnsImportPublicationPollRequestV1,
  hnsImportChallengeValueSha256,
  NamespaceOwnershipProviderObservationRejected,
  NamespaceOwnershipProviderUnsupportedProtocol,
  type RouteAttachmentOwnershipSession,
} from "@pirate/application/namespace-ownership";
import type {
  HnsImportPublicationAuthorization,
  HnsImportPublicationAuthorizationInput,
} from "@pirate/platform-cf/hns-root-import-publication-authorization-postgres";
import { Effect, Exit } from "effect";
import { makeHnsOwnerAdapter } from "../../../packages/platform-cf/src/namespace-ownership/hns-owner.ts";
import { makeHnsOwnerServiceBindingTransport } from "../../../packages/platform-cf/src/namespace-ownership/hns-owner-service-binding.ts";
import { attachmentObserverFixture } from "./attachment-observer.fixture.ts";
import { type Env, handleRequest } from "./index.ts";

const env: Env = {
  HNS_OWNERSHIP_SOURCE: "hns_parent_chain_txt",
  HNS_CHALLENGE_TTL_SECONDS: "3600",
  HNS_EVIDENCE_TTL_SECONDS: "2592000",
  HNS_PROVIDER_ENVIRONMENT: "staging",
  HNS_PROVIDER_CONFIGURATION_REFERENCE: "hns-owner-staging",
  HNS_PROVIDER_CONFIGURATION_VERSION: "hns-owner-config-v1",
};
const enabled: Env = { ...env, HNS_PROVIDER_CAPABILITIES: HNS_TXT_IMPORT_PROTOCOL_VERSION };
const context = { namespace_session_id: "namespace-session-1", observation_id: "observation-1" };
const upstream = "nvs_import";

// The hns-txt-v1 session is more than an hour past its own clock.
const session: RouteAttachmentOwnershipSession = {
  operation_kind: "route_attachment",
  actor_id: "user-1",
  community_id: "community-1",
  attachment_intent_id: "attachment-1",
  ceremony_intent_id: "ceremony-1",
  requirement_hash: "4".repeat(64),
  generation: 1,
  request_hash: "5".repeat(64),
  provider_id: "hns.owner.v1",
  provider_binding_hash: "6".repeat(64),
  provider_configuration: {
    kind: "managed",
    reference: "hns-owner-staging",
    version: "hns-owner-config-v1",
  },
  protocol_version: "hns-txt-v1",
  environment: "staging",
  route: {
    family: "hns",
    root_label: "harbor",
    root_label_display: "harbor",
    path_segment: "app.harbor",
    href: "/c/app.harbor",
    app_host: null,
  },
  upstream_session_ref: upstream,
  expires_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
};

async function binding() {
  return {
    root_import_session_id: "root-import-1",
    root_label: "harbor",
    publish_plan_sha256: "7".repeat(64),
    challenge_value_sha256: await hnsImportChallengeValueSha256(`pirate-verification=${upstream}`),
  };
}

function validUntil() {
  return new Date(Date.now() + 13 * 86_400_000).toISOString();
}

type Authorizer = (
  input: HnsImportPublicationAuthorizationInput,
) => Promise<HnsImportPublicationAuthorization | null>;

function granting(calls: HnsImportPublicationAuthorizationInput[] = []): Authorizer {
  return async (input) => {
    calls.push(input);
    return {
      root_import_session_id: "root-import-1",
      root_label: "harbor",
      valid_until: validUntil(),
    };
  };
}

async function importRequest(overrides: Partial<HnsImportPublicationPollRequestV1> = {}) {
  const body: HnsImportPublicationPollRequestV1 = {
    operation_kind: "route_attachment_import",
    protocol_version: HNS_TXT_IMPORT_PROTOCOL_VERSION,
    session,
    binding: await binding(),
    payload: {},
    ...overrides,
  };
  return new Request("https://hns-owner.internal/internal/hns-owner/v1/import-poll", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Pirate-Namespace-Session-Id": context.namespace_session_id,
      "Pirate-HNS-Observation-Id": context.observation_id,
    },
    body: JSON.stringify(body),
  });
}

function adapter(verifierEnv: Env, authorizer: Authorizer | undefined, observed: () => void) {
  const transport = makeHnsOwnerServiceBindingTransport({
    fetch: (url, init) =>
      handleRequest(new Request(String(url), init), verifierEnv, {
        targetObserver: attachmentObserverFixture("verified", observed),
        ...(authorizer === undefined ? {} : { importAuthorizer: authorizer }),
      }),
  });
  return makeHnsOwnerAdapter({
    transport,
    provider_configuration: session.provider_configuration,
    environments: ["staging"],
    target_observation_contract: "v2",
    import_protocol_enabled: true,
  });
}

describe("hns-txt-import-v1 verifier contract", () => {
  test("a verifier with the capability disabled refuses as unsupported without observing", async () => {
    let observations = 0;
    const response = await handleRequest(await importRequest(), env, {
      targetObserver: attachmentObserverFixture("verified", () => observations++),
      importAuthorizer: granting(),
    });
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "unsupported_protocol" });
    const complete = adapter(env, granting(), () => observations++).completeRouteAttachmentImport;
    if (complete === undefined) throw new Error("import method missing");
    const exit = await Effect.runPromiseExit(
      complete(
        {
          session,
          binding: {
            ...(await binding()),
            protocol_version: "hns-txt-import-v1",
            valid_until: validUntil(),
          },
          submission: { channel: "poll_result", payload: {} },
        },
        context,
      ),
    );
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
      NamespaceOwnershipProviderUnsupportedProtocol.name,
    );
    expect(observations).toBe(0);
  });

  test("accepts a matching poll more than an hour after the session started", async () => {
    let observations = 0;
    const calls: HnsImportPublicationAuthorizationInput[] = [];
    const complete = adapter(
      enabled,
      granting(calls),
      () => observations++,
    ).completeRouteAttachmentImport;
    if (complete === undefined) throw new Error("import method missing");
    const result = await Effect.runPromise(
      complete(
        {
          session,
          binding: {
            ...(await binding()),
            protocol_version: "hns-txt-import-v1",
            valid_until: validUntil(),
          },
          submission: { channel: "poll_result", payload: {} },
        },
        context,
      ),
    );
    expect(result.status).toBe("verified");
    expect(observations).toBe(1);
    // The verifier bound the database read to the header's namespace session
    // and every value in the plan binding; the poll carried no clock.
    expect(calls).toEqual([
      {
        actor_id: "user-1",
        community_id: "community-1",
        root_label: "harbor",
        namespace_session_id: context.namespace_session_id,
        upstream_session_ref: upstream,
        challenge_value_sha256: (await binding()).challenge_value_sha256,
        publish_plan_sha256: "7".repeat(64),
      },
    ]);
  });

  test("refuses without observing when the database denies or names another root", async () => {
    let observations = 0;
    const observer = attachmentObserverFixture("verified", () => observations++);
    const deny = await handleRequest(await importRequest(), enabled, {
      targetObserver: observer,
      importAuthorizer: async () => null,
    });
    expect(deny.status).toBe(409);
    expect(await deny.json()).toEqual({ error: "publication_not_authorized" });
    const otherRoot = await handleRequest(await importRequest(), enabled, {
      targetObserver: observer,
      importAuthorizer: async () => ({
        root_import_session_id: "root-import-1",
        root_label: "otherroot",
        valid_until: validUntil(),
      }),
    });
    expect(otherRoot.status).toBe(409);
    const otherSession = await handleRequest(await importRequest(), enabled, {
      targetObserver: observer,
      importAuthorizer: async () => ({
        root_import_session_id: "root-import-2",
        root_label: "harbor",
        valid_until: validUntil(),
      }),
    });
    expect(otherSession.status).toBe(409);
    const unavailable = await handleRequest(await importRequest(), enabled, {
      targetObserver: observer,
      importAuthorizer: async () => {
        throw new Error("database unavailable");
      },
    });
    expect(unavailable.status).toBe(503);
    const unconfigured = await handleRequest(await importRequest(), enabled, {
      targetObserver: observer,
    });
    expect(unconfigured.status).toBe(502);
    expect(observations).toBe(0);
  });

  test("refuses a binding whose challenge digest does not match the session before any read", async () => {
    const calls: HnsImportPublicationAuthorizationInput[] = [];
    for (const changed of [
      { binding: { ...(await binding()), challenge_value_sha256: "8".repeat(64) } },
      { binding: { ...(await binding()), root_label: "otherroot" } },
      { session: { ...session, environment: "production" } },
      { session: { ...session, protocol_version: "hns-txt-import-v1" } },
    ]) {
      const response = await handleRequest(await importRequest(changed), enabled, {
        targetObserver: attachmentObserverFixture("verified"),
        importAuthorizer: granting(calls),
      });
      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test("an unknown capability is a misconfiguration, not a silent enablement", async () => {
    const response = await handleRequest(
      await importRequest(),
      { ...env, HNS_PROVIDER_CAPABILITIES: "hns-txt-import-v2" },
      { targetObserver: attachmentObserverFixture("verified"), importAuthorizer: granting() },
    );
    expect(response.status).toBe(502);
  });

  test("the adapter rejects an envelope that answers for a different plan", async () => {
    const transport = makeHnsOwnerServiceBindingTransport({
      fetch: async (url, init) => {
        const original = await handleRequest(new Request(String(url), init), enabled, {
          targetObserver: attachmentObserverFixture("verified"),
          importAuthorizer: granting(),
        });
        const document = (await original.json()) as Record<string, unknown>;
        const tampered = { ...document, publish_plan_sha256: "9".repeat(64) };
        const ordered = Object.fromEntries(
          Object.entries(tampered).sort(([left], [right]) => (left < right ? -1 : 1)),
        );
        return new Response(JSON.stringify(ordered), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const complete = makeHnsOwnerAdapter({
      transport,
      provider_configuration: session.provider_configuration,
      environments: ["staging"],
      target_observation_contract: "v2",
      import_protocol_enabled: true,
    }).completeRouteAttachmentImport;
    if (complete === undefined) throw new Error("import method missing");
    const exit = await Effect.runPromiseExit(
      complete(
        {
          session,
          binding: {
            ...(await binding()),
            protocol_version: "hns-txt-import-v1",
            valid_until: validUntil(),
          },
          submission: { channel: "poll_result", payload: {} },
        },
        context,
      ),
    );
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
      NamespaceOwnershipProviderObservationRejected.name,
    );
  });

  test("hns-txt-v1 is unchanged: an expired route-attachment session is still rejected", async () => {
    let observations = 0;
    const response = await handleRequest(
      new Request("https://hns-owner.internal/internal/hns-owner/v1/poll", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/octet-stream",
          "Pirate-Namespace-Session-Id": context.namespace_session_id,
          "Pirate-HNS-Observation-Id": context.observation_id,
        },
        body: JSON.stringify({ operation_kind: "route_attachment", session, payload: {} }),
      }),
      enabled,
      { targetObserver: attachmentObserverFixture("verified", () => observations++) },
    );
    expect(response.status).toBe(400);
    expect(observations).toBe(0);
  });

  test("an adapter without the capability exposes no import method", () => {
    const transport = makeHnsOwnerServiceBindingTransport({ fetch: async () => new Response() });
    const plain = makeHnsOwnerAdapter({
      transport,
      provider_configuration: session.provider_configuration,
      environments: ["staging"],
    });
    expect(plain.completeRouteAttachmentImport).toBeUndefined();
  });
});
