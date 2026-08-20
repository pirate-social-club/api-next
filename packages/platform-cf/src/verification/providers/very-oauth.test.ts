import { describe, expect, test } from "bun:test";
import type {
  VerificationProviderCompleteInput,
  VerificationProviderPlanInput,
  VerificationProviderStartInput,
} from "@pirate/application/verification";
import type { ProofSession, VerificationRequirements } from "@pirate/domain/verification";
import { runProviderTransportConformance } from "@pirate/testing/verification";
import { Cause, Effect, Exit, Result } from "effect";
import {
  makeVeryOauthProvider,
  VERY_OAUTH_CONFIGURATION_REFERENCE,
  VERY_OAUTH_CONFIGURATION_VERSION,
  VERY_OAUTH_HTTP_TIMEOUT_MS,
  VERY_OAUTH_ISSUER,
  VERY_OAUTH_MANIFEST,
  VERY_OAUTH_PROTOCOL_VERSION,
  VERY_OAUTH_PROVIDER_ID,
  VERY_OAUTH_RP_SCOPE,
  type VeryOauthAdapterOptions,
  type VeryOauthTransport,
} from "./very-oauth.ts";

const NOW = "2099-08-20T12:00:00.000Z";
const EXPIRES = "2099-08-20T12:05:00.000Z";
const HASH = "d628ee9079970681ece2757f9a269054129a0382f66fad34102cddcd7dbc9cc5";
const DIGEST = "b".repeat(64);
const KEY = new Uint8Array(32).fill(7);
const SUBJECT = "very-subject-1";
const DETERMINISTIC_STATE = btoa(String.fromCharCode(...new Uint8Array(32).fill(1))).replace(
  /=+$/u,
  "",
);

const SCOPE = {
  kind: "named" as const,
  scope_semantics: "issuer_rp_scope" as const,
  issuer: VERY_OAUTH_ISSUER,
  rp_scope: VERY_OAUTH_RP_SCOPE,
};

const REQUIREMENTS = [
  { claim_id: "credential.subject_unique" },
  { claim_id: "human.personhood" },
] as const satisfies VerificationRequirements;

const CLAIM_IDS = ["credential.subject_unique", "human.personhood"] as const;
const CONFIGURATION = {
  kind: "dynamic" as const,
  reference: VERY_OAUTH_CONFIGURATION_REFERENCE,
  version: VERY_OAUTH_CONFIGURATION_VERSION,
};

const START_INPUT: VerificationProviderStartInput = {
  actor_id: "actor-1",
  intent_id: "intent-1",
  request_hash: HASH,
  method: "palm_oauth",
  scope: SCOPE,
  request_mode: "dynamic",
  provider_configuration: CONFIGURATION,
  requested_requirements: REQUIREMENTS,
  requested_claim_ids: CLAIM_IDS,
  subject_binding_intent: "establish",
  protocol_version: VERY_OAUTH_PROTOCOL_VERSION,
  environment: "test",
};

type Calls = {
  readonly token: Array<Readonly<{ url: string; body: string; timeout_ms: number }>>;
  readonly userInfo: Array<Readonly<{ url: string; access_token: string; timeout_ms: number }>>;
};

function identifiers() {
  const counts = new Map<string, number>();
  return {
    next(kind: string) {
      const next = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, next);
      return `${kind}-${next}`;
    },
  };
}

function randomness() {
  let calls = 0;
  return {
    bytes(length: number) {
      calls += 1;
      return new Uint8Array(length).fill(calls);
    },
  };
}

function transportWith(
  calls: Calls,
  overrides: Partial<VeryOauthTransport> = {},
): VeryOauthTransport {
  return {
    token: (input) => {
      calls.token.push({ url: input.url, body: input.body, timeout_ms: input.timeout_ms });
      return Effect.succeed({
        status: 200,
        body: { access_token: "access-token-secret", id_token: "id-token-secret" },
      });
    },
    userInfo: (input) => {
      calls.userInfo.push(input);
      return Effect.succeed({ status: 200, body: { sub: SUBJECT } });
    },
    ...overrides,
  };
}

function options(overrides: Partial<VeryOauthAdapterOptions> = {}) {
  const calls: Calls = { token: [], userInfo: [] };
  const base: VeryOauthAdapterOptions = {
    authorization_endpoint: "https://connect.very.example/authorize",
    token_endpoint: "https://api.very.example/oauth2/token",
    userinfo_endpoint: "https://api.very.example/oauth2/userinfo",
    issuer: VERY_OAUTH_ISSUER,
    jwks_url: "https://connect.very.example/.well-known/jwks.json",
    client_id: "pirate-client",
    client_secret: "client-secret",
    redirect_uri: "https://api.pirate.example/verification/very/callback",
    sealing_key: KEY,
    transport: transportWith(calls),
    clock: { now: () => NOW, expiresAt: () => EXPIRES },
    identifiers: identifiers(),
    randomness: randomness(),
    digest: { digest: () => Effect.succeed(DIGEST) },
    id_token_verifier: ({ issuer, audience, nonce }) =>
      Effect.succeed({ issuer, audience, subject: SUBJECT, nonce }),
  };
  return { value: { ...base, ...overrides }, calls };
}

function provider(overrides: Partial<VeryOauthAdapterOptions> = {}) {
  const configured = options(overrides);
  return {
    adapter: makeVeryOauthProvider(configured.value),
    calls: configured.calls,
    value: configured.value,
  };
}

function planInput(
  overrides: Partial<VerificationProviderPlanInput> = {},
): VerificationProviderPlanInput {
  return {
    method: START_INPUT.method,
    scope: START_INPUT.scope,
    requested_requirements: START_INPUT.requested_requirements,
    requested_claim_ids: START_INPUT.requested_claim_ids,
    subject_binding_intent: START_INPUT.subject_binding_intent,
    protocol_version: START_INPUT.protocol_version,
    environment: START_INPUT.environment,
    ...overrides,
  };
}

async function failureTag(effect: Effect.Effect<unknown, unknown>): Promise<string> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const failure = Cause.findError(exit.cause);
  if (Result.isFailure(failure)) throw new Error("expected typed failure");
  return String((failure.success as { readonly _tag?: unknown })._tag);
}

async function started(adapter: ReturnType<typeof provider>["adapter"]) {
  return Effect.runPromise(adapter.start(START_INPUT));
}

function completion(
  session: ProofSession,
  payload: unknown = {
    code: "one-time-code",
    state: new URL("https://connect.very.example").searchParams.get("state") ?? "",
  },
): VerificationProviderCompleteInput {
  return { session, submission: { channel: "client_result", payload } };
}

describe("Very OAuth provider-local contract", () => {
  test("passes the shared deterministic provider transport conformance harness", async () => {
    await runProviderTransportConformance([
      {
        name: "Very OAuth native code exchange",
        makeTransport: () => transportWith({ token: [], userInfo: [] }),
        makeAdapter: (transport) => {
          const configured = options();
          return makeVeryOauthProvider({ ...configured.value, transport });
        },
        startInput: START_INPUT,
        submission: {
          channel: "client_result",
          payload: { code: "one-time-code", state: DETERMINISTIC_STATE },
        },
        operation: "complete",
        expected: "success",
        assertTransport: () => undefined,
      },
    ]);
  });

  test("advertises only the v1 personhood and subject-unique dynamic redirect contract", async () => {
    expect(VERY_OAUTH_MANIFEST.claim_ids).toEqual([
      "human.personhood",
      "credential.subject_unique",
    ]);
    expect(VERY_OAUTH_MANIFEST.claim_ids).not.toContain("human.unique");
    expect(VERY_OAUTH_MANIFEST.supported_methods).toEqual(["palm_oauth"]);
    expect(await Effect.runPromise(provider().adapter.plan(planInput()))).toEqual({
      status: "supported",
      request_mode: "dynamic",
      provider_configuration: CONFIGURATION,
    });
    expect(await Effect.runPromise(provider().adapter.plan(planInput({ method: "self" })))).toEqual(
      { status: "unsupported" },
    );
    expect(
      await Effect.runPromise(
        provider().adapter.plan(planInput({ requested_claim_ids: ["human.unique"] })),
      ),
    ).toEqual({ status: "unsupported" });
    expect(
      await Effect.runPromise(
        provider().adapter.plan(
          planInput({ scope: { kind: "none", issuer: VERY_OAUTH_PROVIDER_ID } }),
        ),
      ),
    ).toEqual({ status: "unsupported" });
  });

  test("seals state, nonce, and PKCE verifier and exposes only a redirect presentation", async () => {
    const { adapter } = provider();
    const start = await started(adapter);
    expect(start.session).toMatchObject({
      id: "session-1",
      provider_id: VERY_OAUTH_PROVIDER_ID,
      upstream_session_ref: expect.stringMatching(
        /^very\.oauth\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
      ),
      status: "pending",
      started_at: NOW,
      expires_at: EXPIRES,
    });
    expect(start.presentation.kind).toBe("redirect");
    if (start.presentation.kind !== "redirect") throw new Error("expected redirect");
    const url = new URL(start.presentation.url);
    expect(url.searchParams.get("client_id")).toBe("pirate-client");
    expect(url.searchParams.get("state")).toHaveLength(43);
    expect(url.searchParams.get("nonce")).toHaveLength(43);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid");
    expect(url.searchParams.get("code_challenge")).toHaveLength(43);
    expect(url.searchParams.has("code")).toBe(false);
    expect(url.searchParams.has("code_verifier")).toBe(false);
    expect(start.presentation.url).not.toContain("client-secret");
  });

  test("performs a bounded server-side form exchange, exact token checks, UserInfo subject agreement, and scoped evidence", async () => {
    const { adapter, calls, value } = provider();
    const start = await started(adapter);
    if (start.presentation.kind !== "redirect") throw new Error("expected redirect");
    const state = new URL(start.presentation.url).searchParams.get("state");
    const result = await Effect.runPromise(
      adapter.complete(completion(start.session, { code: "one-time-code", state })),
    );
    expect(calls.token).toHaveLength(1);
    expect(calls.token[0]?.url).toBe(value.token_endpoint);
    expect(calls.token[0]?.timeout_ms).toBe(VERY_OAUTH_HTTP_TIMEOUT_MS);
    const form = new URLSearchParams(calls.token[0]?.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_id")).toBe(value.client_id);
    expect(form.get("client_secret")).toBe(value.client_secret);
    expect(form.get("code")).toBe("one-time-code");
    expect(form.get("code_verifier")).toHaveLength(43);
    expect(calls.userInfo).toEqual([
      {
        url: value.userinfo_endpoint,
        access_token: "access-token-secret",
        timeout_ms: VERY_OAUTH_HTTP_TIMEOUT_MS,
      },
    ]);
    expect(result.assertions.map((assertion) => assertion.claim_id)).toEqual([...CLAIM_IDS]);
    expect(
      result.assertions.every((assertion) => assertion.assurance === "provider_attested"),
    ).toBe(true);
    expect(result.assertions).not.toContainEqual(
      expect.objectContaining({ claim_id: "human.unique" }),
    );
    expect(result.subject_keys[0]?.scope).toEqual(SCOPE);
    expect(result.binding_groups).toEqual([
      { id: "binding-1", kind: "same_subject", subject_key_id: "subject-1" },
    ]);
    expect(JSON.stringify(result)).not.toContain("one-time-code");
    expect(JSON.stringify(result)).not.toContain("access-token-secret");
    expect(JSON.stringify(result)).not.toContain("client-secret");
  });

  test("rejects state mismatch before consuming the authorization code", async () => {
    const { adapter, calls } = provider();
    const start = await started(adapter);
    expect(
      await failureTag(
        adapter.complete(
          completion(start.session, {
            code: "one-time-code",
            state: "wrong-state",
          }),
        ),
      ),
    ).toBe("VerificationProviderUnboundRejected");
    expect(calls.token).toHaveLength(0);
  });

  test("rejects a sealed-ref transplant across proof sessions before exchange", async () => {
    const { adapter, calls } = provider();
    const first = await started(adapter);
    const second = await started(adapter);
    if (first.presentation.kind !== "redirect") throw new Error("expected redirect");
    const transplanted = {
      ...second.session,
      upstream_session_ref: first.session.upstream_session_ref,
    };
    const state = new URL(first.presentation.url).searchParams.get("state");
    expect(
      await failureTag(adapter.complete(completion(transplanted, { code: "code", state }))),
    ).toBe("VerificationProviderUnboundRejected");
    expect(calls.token).toHaveLength(0);
  });

  test("rejects excess client callback fields before exchange", async () => {
    const { adapter, calls } = provider();
    const start = await started(adapter);
    if (start.presentation.kind !== "redirect") throw new Error("expected redirect");
    const state = new URL(start.presentation.url).searchParams.get("state");
    expect(
      await failureTag(
        adapter.complete(completion(start.session, { code: "code", state, extra: "rejected" })),
      ),
    ).toBe("VerificationProviderUnboundRejected");
    expect(calls.token).toHaveLength(0);
  });

  test("rejects stale sessions before any upstream request", async () => {
    let now = NOW;
    const { calls, value } = provider({ clock: { now: () => now, expiresAt: () => EXPIRES } });
    const adapter = makeVeryOauthProvider(value);
    const start = await started(adapter);
    now = "2099-08-20T12:05:01.000Z";
    expect(
      await failureTag(
        adapter.complete(
          completion(start.session, {
            code: "one-time-code",
            state: "ignored",
          }),
        ),
      ),
    ).toBe("VerificationProviderUnboundRejected");
    expect(calls.token).toHaveLength(0);
  });

  test("rejects a non-300-second expiry at launch", async () => {
    const configured = provider({
      clock: { now: () => NOW, expiresAt: () => "2099-08-20T12:04:59.999Z" },
    });
    expect(await failureTag(configured.adapter.start(START_INPUT))).toBe(
      "VerificationProviderRejected",
    );
  });

  test("fails closed for malformed token, issuer/audience/nonce/sub, UserInfo mismatch, and upstream statuses", async () => {
    const cases: Array<readonly [string, Partial<VeryOauthAdapterOptions>, string]> = [
      [
        "malformed token",
        {
          transport: transportWith(
            { token: [], userInfo: [] },
            { token: () => Effect.succeed({ status: 200, body: { access_token: "a" } }) },
          ),
        },
        "VerificationProviderInvalidResponse",
      ],
      [
        "issuer mismatch",
        {
          id_token_verifier: ({ audience, nonce }) =>
            Effect.succeed({ issuer: "https://wrong.example", audience, subject: SUBJECT, nonce }),
        },
        "VerificationProviderRejected",
      ],
      [
        "audience mismatch",
        {
          id_token_verifier: ({ issuer, nonce }) =>
            Effect.succeed({ issuer, audience: "wrong-client", subject: SUBJECT, nonce }),
        },
        "VerificationProviderRejected",
      ],
      [
        "nonce mismatch",
        {
          id_token_verifier: ({ issuer, audience }) =>
            Effect.succeed({ issuer, audience, subject: SUBJECT, nonce: "wrong-nonce" }),
        },
        "VerificationProviderRejected",
      ],
      [
        "empty subject",
        {
          id_token_verifier: ({ issuer, audience, nonce }) =>
            Effect.succeed({ issuer, audience, subject: "", nonce }),
        },
        "VerificationProviderRejected",
      ],
      [
        "userinfo mismatch",
        {
          transport: transportWith(
            { token: [], userInfo: [] },
            { userInfo: () => Effect.succeed({ status: 200, body: { sub: "other" } }) },
          ),
        },
        "VerificationProviderRejected",
      ],
      [
        "upstream unavailable",
        {
          transport: transportWith(
            { token: [], userInfo: [] },
            { token: () => Effect.succeed({ status: 503, body: {} }) },
          ),
        },
        "VerificationProviderUnavailable",
      ],
    ];
    for (const [, overrides, expected] of cases) {
      const { adapter } = provider(overrides);
      const start = await started(adapter);
      if (start.presentation.kind !== "redirect") throw new Error("expected redirect");
      const state = new URL(start.presentation.url).searchParams.get("state");
      expect(
        await failureTag(adapter.complete(completion(start.session, { code: "code", state }))),
      ).toBe(expected);
    }
  });

  test("rejects tampered sealed state and a non-32-byte configuration key without revealing details", async () => {
    const good = provider();
    const start = await started(good.adapter);
    const tampered = {
      ...start.session,
      upstream_session_ref: `${start.session.upstream_session_ref}x`,
    };
    const failure = await Effect.runPromiseExit(good.adapter.complete(completion(tampered)));
    expect(Exit.isFailure(failure)).toBe(true);
    expect(await failureTag(good.adapter.complete(completion(tampered)))).toBe(
      "VerificationProviderUnboundRejected",
    );
    const bad = provider({ sealing_key: new Uint8Array(31) });
    expect(await failureTag(bad.adapter.start(START_INPUT))).toBe(
      "VerificationProviderMisconfigured",
    );
  });

  test("keeps callback secrets out of failure text", async () => {
    const { adapter } = provider();
    const start = await started(adapter);
    const failure = await Effect.runPromiseExit(
      adapter.complete(
        completion(start.session, {
          code: "authorization-code-secret",
          state: "wrong-state",
          extra: "client-verifier-secret",
        }),
      ),
    );
    const text = String(failure);
    expect(text).not.toContain("authorization-code-secret");
    expect(text).not.toContain("client-verifier-secret");
    expect(text).not.toContain("client-secret");
  });
});
