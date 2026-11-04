import { describe, expect, test } from "bun:test";
import { requireInlineAppShape } from "./staging-hns-access-setup.ts";

const appId = "11111111-1111-4111-8111-111111111111";
const tokenId = "22222222-2222-4222-8222-222222222222";
const domain = "hns-community-ingress-staging.pirate.sc";
const expected = {
  appId,
  name: "hns-community-ingress-staging",
  domain,
  tokenIds: [tokenId],
};

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("fixture_missing");
  return item;
}

function application() {
  return {
    id: appId,
    name: expected.name,
    domain,
    type: "self_hosted",
    service_auth_401_redirect: true,
    app_launcher_visible: false,
    destinations: [{ type: "public", uri: domain }],
    self_hosted_domains: [domain],
    policies: [
      {
        name: `${expected.name}-service-auth`,
        decision: "non_identity",
        precedence: 1,
        include: [{ service_token: { token_id: tokenId } }],
        require: [] as { service_token: { token_id: string } }[],
        exclude: [],
      },
    ],
  };
}

describe("staging HNS Access application refusal", () => {
  test("accepts one exact staging service-auth policy", () => {
    expect(() => requireInlineAppShape(expected, application())).not.toThrow();
  });

  test("rejects a different or wildcard hostname", () => {
    const wrong = application();
    first(wrong.destinations).uri = "*.pirate.sc";
    expect(() => requireInlineAppShape(expected, wrong)).toThrow("inline_app_destination");
  });

  test("rejects an extra destination", () => {
    const wrong = application();
    wrong.destinations.push({ type: "public", uri: "another.pirate.sc" });
    expect(() => requireInlineAppShape(expected, wrong)).toThrow("inline_app_destination");
  });

  test("rejects a bypass decision", () => {
    const wrong = application();
    first(wrong.policies).decision = "bypass";
    expect(() => requireInlineAppShape(expected, wrong)).toThrow("inline_policy_shape");
  });

  test("rejects an extra policy", () => {
    const wrong = application();
    wrong.policies.push({ ...first(wrong.policies), name: "unreviewed" });
    expect(() => requireInlineAppShape(expected, wrong)).toThrow("inline_policy_count");
  });

  test("rejects a different token or broad service selector", () => {
    const wrong = application();
    first(wrong.policies).include = [
      { service_token: { token_id: "33333333-3333-4333-8333-333333333333" } },
    ];
    expect(() => requireInlineAppShape(expected, wrong)).toThrow("inline_policy_token_binding");
    const broad = application();
    first(broad.policies).include = [{ service_token: { token_id: "any_valid_service_token" } }];
    expect(() => requireInlineAppShape(expected, broad)).toThrow("staging_access_refused:id");
  });

  test("rejects changed challenge and extra requirements", () => {
    const wrong = application();
    wrong.service_auth_401_redirect = false;
    expect(() => requireInlineAppShape(expected, wrong)).toThrow("inline_app_shape");
    const extra = application();
    first(extra.policies).require.push({ service_token: { token_id: tokenId } });
    expect(() => requireInlineAppShape(expected, extra)).toThrow("inline_policy_require");
  });
});
