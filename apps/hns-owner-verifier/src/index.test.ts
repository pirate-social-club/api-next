import { describe, expect, test } from "bun:test";
import { app, type Env, handleRequest } from "./index.ts";

const env: Env = {
  HNS_OWNERSHIP_SOURCE: "hns_parent_chain_txt",
  HNS_CHALLENGE_TTL_SECONDS: "3600",
  HNS_EVIDENCE_TTL_SECONDS: "2592000",
  HNS_LEGACY_VERIFIER_URL: "https://verifier.pirate.sc/hns",
  HNS_LEGACY_VERIFIER_BEARER: "test-bearer",
  HNS_PROVIDER_ENVIRONMENT: "staging",
  HNS_PROVIDER_CONFIGURATION_REFERENCE: "hns-owner-staging",
  HNS_PROVIDER_CONFIGURATION_VERSION: "hns-owner-config-v1",
};

const route = {
  family: "hns",
  root_label: "jazleeuw",
  root_label_display: "jazleeuw",
  path_segment: "app.jazleeuw",
  href: "/c/app.jazleeuw",
  app_host: null,
} as const;

const creationStart = {
  actor_id: "user-1",
  creation_intent_id: "cc_intent-1",
  ceremony_intent_id: "cc_ceremony-1",
  requirement_hash: "1".repeat(64),
  generation: 1,
  request_hash: "2".repeat(64),
  provider_binding_hash: "3".repeat(64),
  provider_configuration: {
    kind: "managed",
    reference: "hns-owner-staging",
    version: "hns-owner-config-v1",
  },
  protocol_version: "hns-txt-v1",
  environment: "staging",
  route,
};

const revalidationStart = {
  operation_kind: "route_revalidation",
  route_revalidation_id: "route-revalidation-1",
  revalidation_session_id: "revalidation-session-1",
  community_id: "community-1",
  route_binding_id: "route-binding-1",
  expected_binding_generation: 1,
  expected_verified_evidence_ref: null,
  principal_kind: "system",
  principal_id: "route-revalidation-scheduler",
  requirement_hash: "4".repeat(64),
  start_request_hash: "5".repeat(64),
  provider_binding_hash: "6".repeat(64),
  provider_configuration: {
    kind: "managed",
    reference: "hns-owner-staging",
    version: "hns-owner-config-v1",
  },
  protocol_version: "hns-txt-v1",
  environment: "staging",
  route,
};

function request(
  path: string,
  body: unknown,
  accept: string,
  header = "namespace-session-1",
): Request {
  return new Request(`https://hns-owner.internal${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: accept,
      "Pirate-Namespace-Session-Id": header,
    },
    body: JSON.stringify(body),
  });
}

async function start(): Promise<{
  readonly body: Record<string, unknown>;
  readonly session: Record<string, unknown>;
}> {
  const response = await app.fetch(
    request("/internal/hns-owner/v1/start", creationStart, "application/json"),
    env,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  return {
    body,
    session: {
      actor_id: creationStart.actor_id,
      creation_intent_id: creationStart.creation_intent_id,
      ceremony_intent_id: creationStart.ceremony_intent_id,
      requirement_hash: creationStart.requirement_hash,
      generation: creationStart.generation,
      request_hash: creationStart.request_hash,
      provider_id: "hns.owner.v1",
      provider_binding_hash: creationStart.provider_binding_hash,
      provider_configuration: creationStart.provider_configuration,
      protocol_version: creationStart.protocol_version,
      environment: creationStart.environment,
      route,
      upstream_session_ref: body.upstream_session_ref,
      expires_at: body.expires_at,
    },
  };
}

async function startRevalidation(): Promise<{
  readonly body: Record<string, unknown>;
  readonly session: Record<string, unknown>;
}> {
  const started = await app.fetch(
    request(
      "/internal/hns-owner/v1/start",
      revalidationStart,
      "application/json",
      "revalidation-session-1",
    ),
    env,
  );
  expect(started.status).toBe(200);
  const body = (await started.json()) as Record<string, unknown>;
  return {
    body,
    session: {
      authority: {
        version: "pirate-hns-route-revalidation-authority-v1",
        route_revalidation_id: revalidationStart.route_revalidation_id,
        community_id: revalidationStart.community_id,
        route_binding_id: revalidationStart.route_binding_id,
        principal_kind: "system",
        principal_id: revalidationStart.principal_id,
        expected_binding_generation: revalidationStart.expected_binding_generation,
        expected_verified_evidence_ref: null,
        requirement_hash: revalidationStart.requirement_hash,
        provider_id: "hns.owner.v1",
        provider_binding_hash: revalidationStart.provider_binding_hash,
        provider_configuration_kind: "managed",
        provider_configuration_reference: "hns-owner-staging",
        provider_configuration_version: "hns-owner-config-v1",
        protocol_version: "hns-txt-v1",
        environment: "staging",
        family: "hns",
        root_label: route.root_label,
        root_label_display: route.root_label_display,
        path_segment: route.path_segment,
      },
      revalidation_session_id: revalidationStart.revalidation_session_id,
      start_request_hash: revalidationStart.start_request_hash,
      upstream_session_ref: body.upstream_session_ref,
      start_presentation: body.presentation,
      status: "pending",
      started_at: new Date(Date.now() - 1_000).toISOString(),
      expires_at: body.expires_at,
      terminal_at: null,
    },
  };
}

describe("HNS owner verifier Worker", () => {
  test("starts both the frozen creation and route-revalidation presentation", async () => {
    const response = await app.fetch(
      request("/internal/hns-owner/v1/start", creationStart, "application/json"),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["upstream_session_ref", "expires_at", "presentation"]);
    const presentation = body.presentation as Record<string, unknown>;
    expect(presentation.session_id).toBe(body.upstream_session_ref);
    expect((presentation.payload as Record<string, unknown>).challenge_name).toBe("jazleeuw");
  });

  test("rejects non-canonical JSON, wrong content types, and excess members", async () => {
    const base = request("/internal/hns-owner/v1/start", creationStart, "application/json");
    const badJson = new Request(base, { body: `${JSON.stringify(creationStart)} ` });
    expect((await app.fetch(badJson, env)).status).toBe(400);
    const wrongType = new Request(base, {
      headers: {
        ...Object.fromEntries(base.headers),
        "content-type": "application/json; charset=utf-8",
      },
    });
    expect((await app.fetch(wrongType, env)).status).toBe(400);
    expect(
      (
        await app.fetch(
          request(
            "/internal/hns-owner/v1/start",
            { ...creationStart, extra: true },
            "application/json",
          ),
          env,
        )
      ).status,
    ).toBe(400);
  });

  test("fails closed for missing or incompatible pinned configuration", async () => {
    const missing: Env = {
      HNS_OWNERSHIP_SOURCE: "hns_parent_chain_txt",
      HNS_CHALLENGE_TTL_SECONDS: "3600",
    };
    expect(
      (
        await app.fetch(
          request("/internal/hns-owner/v1/start", creationStart, "application/json"),
          missing,
        )
      ).status,
    ).toBe(502);
    const incompatible: Env = {
      ...env,
      HNS_PROVIDER_CONFIGURATION_VERSION: "hns-owner-config-other",
    };
    expect(
      (
        await app.fetch(
          request("/internal/hns-owner/v1/start", creationStart, "application/json"),
          incompatible,
        )
      ).status,
    ).toBe(422);
  });

  test("polls the configured legacy endpoint and returns target-owned verified bytes", async () => {
    const { body, session } = await start();
    const legacy = {
      verified: true,
      observation_provider: "hns_parent_chain",
      ownership_source: "hns_parent_chain_txt",
      failure_reason: null,
      observed_values: [`pirate-verification=${String(body.upstream_session_ref)}`],
      root_exists: true,
      root_control_verified: true,
      expiry_root_exists: true,
      expiry_horizon_sufficient: true,
      expiry_blocks_remaining: 100,
      expiry_horizon_blocks: 50,
      expiry_anchor_height: 100,
      expiry_anchor_block_hash: "4".repeat(64),
      expiry_anchor_median_time: 90,
      expiry_chain_network: "main",
      expiry_height: 200,
      expiry_observation_provider: "hsd_json_rpc",
      routing_enabled: false,
      pirate_dns_authority_verified: false,
      control_class: "single_holder_root",
      operation_class: "owner_managed_namespace",
      root_label: "jazleeuw",
      zone_name: "jazleeuw.",
      challenge_name: "jazleeuw.",
    };
    let called = false;
    const response = await handleRequest(
      request("/internal/hns-owner/v1/poll", { session, payload: {} }, "application/octet-stream"),
      env,
      {
        fetcher: async (input, init) => {
          called = true;
          expect(String(input)).toBe("https://verifier.pirate.sc/hns/verify-txt");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-bearer");
          expect(JSON.parse(String(init?.body))).toEqual({
            root_label: "jazleeuw",
            challenge_txt_value: `pirate-verification=${String(body.upstream_session_ref)}`,
          });
          return new Response(JSON.stringify(legacy), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );
    expect(called).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    const output = (await response.json()) as Record<string, unknown>;
    expect(output).toMatchObject({
      status: "verified",
      upstream_session_ref: body.upstream_session_ref,
    });
    expect(String(output.provider_evidence_ref)).toMatch(/^legacy-ns1:sha256:[0-9a-f]{64}$/u);
    expect(typeof output.observed_at).toBe("string");
    expect(typeof output.expires_at).toBe("string");
    expect(Date.parse(String(output.expires_at)) - Date.parse(String(output.observed_at))).toBe(
      2_592_000_000,
    );
  });

  test("maps an unverified legacy observation to pending and fails closed on source mismatch", async () => {
    const { body, session } = await start();
    const base = {
      verified: false,
      failure_reason: "challenge_not_published",
      challenge_name: "jazleeuw.",
    };
    const pending = await handleRequest(
      request("/internal/hns-owner/v1/poll", { session, payload: {} }, "application/octet-stream"),
      env,
      {
        fetcher: async () =>
          new Response(JSON.stringify(base), { headers: { "content-type": "application/json" } }),
      },
    );
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ status: "pending" });
    const mismatch = await handleRequest(
      request("/internal/hns-owner/v1/poll", { session, payload: {} }, "application/octet-stream"),
      env,
      {
        fetcher: async () =>
          new Response(
            JSON.stringify({
              ...base,
              verified: true,
              ownership_source: "owner_authoritative_dns_txt",
            }),
            { headers: { "content-type": "application/json" } },
          ),
      },
    );
    expect(mismatch.status).toBe(502);
    expect(body.upstream_session_ref).toBeTruthy();
  });

  test("maps a creation challenge mismatch from an existing TXT to pending", async () => {
    const { session } = await start();
    const response = await handleRequest(
      request("/internal/hns-owner/v1/poll", { session, payload: {} }, "application/octet-stream"),
      env,
      {
        fetcher: async () =>
          new Response(
            JSON.stringify({
              verified: false,
              failure_reason: "challenge_mismatch",
              challenge_name: "jazleeuw.",
              observed_values: ["v=spf1 include:example.invalid"],
            }),
            { headers: { "content-type": "application/json" } },
          ),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "pending" });
  });

  test("accepts owner-DNS trailing-dot challenge names and sends challenge_host", async () => {
    const { body, session } = await start();
    const ownerDnsEnv: Env = { ...env, HNS_OWNERSHIP_SOURCE: "owner_authoritative_dns_txt" };
    const legacy = {
      verified: true,
      observation_provider: "owner_dns",
      ownership_source: "owner_authoritative_dns_txt",
      failure_reason: null,
      observed_values: [`pirate-verification=${String(body.upstream_session_ref)}`],
      root_exists: true,
      root_control_verified: true,
      expiry_root_exists: true,
      expiry_horizon_sufficient: true,
      expiry_blocks_remaining: 100,
      expiry_horizon_blocks: 50,
      expiry_anchor_height: 100,
      expiry_anchor_block_hash: "8".repeat(64),
      expiry_anchor_median_time: 90,
      expiry_chain_network: "main",
      expiry_height: 200,
      expiry_observation_provider: "hsd_json_rpc",
      routing_enabled: false,
      pirate_dns_authority_verified: false,
      control_class: "single_holder_root",
      operation_class: "owner_managed_namespace",
      root_label: "jazleeuw",
      zone_name: "jazleeuw.",
      challenge_name: "_pirate.jazleeuw.",
    };
    let sentBody: Record<string, unknown> | null = null;
    const response = await handleRequest(
      request("/internal/hns-owner/v1/poll", { session, payload: {} }, "application/octet-stream"),
      ownerDnsEnv,
      {
        fetcher: async (_input, init) => {
          sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify(legacy), {
            headers: { "content-type": "application/json" },
          });
        },
      },
    );
    expect(sentBody as Record<string, unknown> | null).toEqual({
      root_label: "jazleeuw",
      challenge_host: "_pirate.jazleeuw",
      challenge_txt_value: `pirate-verification=${String(body.upstream_session_ref)}`,
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>).status).toBe("verified");
  });

  test("maps legacy infrastructure-unavailable observations to retryable 503", async () => {
    const { session } = await start();
    const response = await handleRequest(
      request("/internal/hns-owner/v1/poll", { session, payload: {} }, "application/octet-stream"),
      env,
      {
        fetcher: async () =>
          new Response(
            JSON.stringify({
              verified: false,
              failure_reason: "root_resource_unavailable",
              challenge_name: "jazleeuw.",
            }),
            { headers: { "content-type": "application/json" } },
          ),
      },
    );
    expect(response.status).toBe(503);
  });

  test("rejects an HTTP legacy URL before making an upstream request", async () => {
    const { session } = await start();
    let called = false;
    const response = await handleRequest(
      request("/internal/hns-owner/v1/poll", { session, payload: {} }, "application/octet-stream"),
      { ...env, HNS_LEGACY_VERIFIER_URL: "http://verifier.pirate.sc/hns" },
      {
        fetcher: async () => {
          called = true;
          return new Response(null, { status: 500 });
        },
      },
    );
    expect(called).toBe(false);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "provider_misconfigured" });
  });

  test("maps upstream throttling, failures, redirects, and oversize bodies safely", async () => {
    const { session } = await start();
    const cases: ReadonlyArray<{
      readonly upstream: Response;
      readonly status: number;
      readonly error: string;
    }> = [
      { upstream: new Response(null, { status: 429 }), status: 503, error: "provider_unavailable" },
      { upstream: new Response(null, { status: 503 }), status: 503, error: "provider_unavailable" },
      {
        upstream: new Response(null, {
          status: 302,
          headers: { location: "https://other.invalid" },
        }),
        status: 502,
        error: "invalid_response",
      },
      {
        upstream: new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": "1048577",
          },
        }),
        status: 502,
        error: "invalid_response",
      },
    ];
    for (const testCase of cases) {
      const response = await handleRequest(
        request(
          "/internal/hns-owner/v1/poll",
          { session, payload: {} },
          "application/octet-stream",
        ),
        env,
        { fetcher: async () => testCase.upstream },
      );
      expect(response.status).toBe(testCase.status);
      expect(await response.json()).toEqual({ error: testCase.error });
    }
  });

  test("accepts the exact route-revalidation poll wire and returns nested verified output", async () => {
    const { body: startBody, session } = await startRevalidation();
    const legacy = {
      verified: true,
      observation_provider: "hns_parent_chain",
      ownership_source: "hns_parent_chain_txt",
      failure_reason: null,
      observed_values: [`pirate-verification=${String(startBody.upstream_session_ref)}`],
      root_exists: true,
      root_control_verified: true,
      expiry_root_exists: true,
      expiry_horizon_sufficient: true,
      expiry_blocks_remaining: 100,
      expiry_horizon_blocks: 50,
      expiry_anchor_height: 100,
      expiry_anchor_block_hash: "7".repeat(64),
      expiry_anchor_median_time: 90,
      expiry_chain_network: "main",
      expiry_height: 200,
      expiry_observation_provider: "hsd_json_rpc",
      routing_enabled: false,
      pirate_dns_authority_verified: false,
      control_class: "single_holder_root",
      operation_class: "owner_managed_namespace",
      root_label: "jazleeuw",
      zone_name: "jazleeuw.",
      challenge_name: "jazleeuw.",
    };
    const response = await handleRequest(
      request(
        "/internal/hns-owner/v1/poll",
        { operation_kind: "route_revalidation", session, payload: {} },
        "application/octet-stream",
        "revalidation-session-1",
      ),
      env,
      {
        fetcher: async () =>
          new Response(JSON.stringify(legacy), {
            headers: { "content-type": "application/json" },
          }),
      },
    );
    expect(response.status).toBe(200);
    const output = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(output)).toEqual(["status", "observation"]);
    expect(output.status).toBe("verified");
    expect((output.observation as Record<string, unknown>).challenge_name).toBe("jazleeuw");

    const rejected = await handleRequest(
      request(
        "/internal/hns-owner/v1/poll",
        { operation_kind: "route_revalidation", session, payload: {} },
        "application/octet-stream",
        "revalidation-session-1",
      ),
      env,
      {
        fetcher: async () =>
          new Response(
            JSON.stringify({
              verified: false,
              failure_reason: "challenge_not_published",
              root_control_verified: false,
              challenge_name: "jazleeuw.",
            }),
            { headers: { "content-type": "application/json" } },
          ),
      },
    );
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toEqual({
      status: "rejected",
      reason_code: "challenge_mismatch",
    });

    const explicitMismatch = await handleRequest(
      request(
        "/internal/hns-owner/v1/poll",
        { operation_kind: "route_revalidation", session, payload: {} },
        "application/octet-stream",
        "revalidation-session-1",
      ),
      env,
      {
        fetcher: async () =>
          new Response(
            JSON.stringify({
              verified: false,
              failure_reason: "challenge_mismatch",
              root_control_verified: false,
              challenge_name: "jazleeuw.",
            }),
            { headers: { "content-type": "application/json" } },
          ),
      },
    );
    expect(await explicitMismatch.json()).toEqual({
      status: "rejected",
      reason_code: "challenge_mismatch",
    });
  });

  test("rejects a route-revalidation poll when the header does not match the session", async () => {
    const { session } = await startRevalidation();
    let called = false;
    const response = await handleRequest(
      request(
        "/internal/hns-owner/v1/poll",
        { operation_kind: "route_revalidation", session, payload: {} },
        "application/octet-stream",
        "different-revalidation-session",
      ),
      env,
      {
        fetcher: async () => {
          called = true;
          return new Response(null, { status: 500 });
        },
      },
    );
    expect(called).toBe(false);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });
});
