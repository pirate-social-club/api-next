import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const alias = {
  "@pirate/application/hns-community-app-api": new URL(
    "../../packages/application/src/hns-community-app-api.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/hns-forwarder-v3": new URL(
    "../../packages/application/src/hns-forwarder-v3.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/hns-static-platform-app-gateway": new URL(
    "../../packages/application/src/hns-static-platform-app-gateway.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/hns-host-serving": new URL(
    "../../packages/application/src/hns-host-serving.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/namespace-ownership": new URL(
    "../../packages/application/src/namespace-ownership/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/route-revalidation": new URL(
    "../../packages/application/src/route-revalidation/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/verification": new URL(
    "../../packages/application/src/verification/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/identity-account": new URL(
    "../../packages/application/src/use-cases/identity-account.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/current-user": new URL(
    "../../packages/application/src/use-cases/current-user.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/profile": new URL(
    "../../packages/application/src/use-cases/profile.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/handles/sales": new URL(
    "../../packages/application/src/use-cases/handles/sales.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/community/get-canonical-community-route": new URL(
    "../../packages/application/src/use-cases/community/get-canonical-community-route.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/session-authentication": new URL(
    "../../packages/application/src/use-cases/session-authentication.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/session-exchange": new URL(
    "../../packages/application/src/use-cases/session-exchange.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/identity-registration-handler": new URL(
    "../../packages/application/src/use-cases/identity-registration-handler.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application": new URL("../../packages/application/src/index.ts", import.meta.url)
    .pathname,
  "@pirate/contracts": new URL("../../packages/contracts/src/index.ts", import.meta.url).pathname,
  "@pirate/domain/verification": new URL(
    "../../packages/domain/src/verification/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/domain": new URL("../../packages/domain/src/index.ts", import.meta.url).pathname,
  "@pirate/platform-cf/namespace-ownership-provider-registry": new URL(
    "../../packages/platform-cf/src/namespace-ownership/provider-registry.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/hns-forwarder-v3": new URL(
    "../../packages/platform-cf/src/hns-forwarder-v3.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/hns-forwarder-replay-store": new URL(
    "../../packages/platform-cf/src/hns-forwarder-replay-store.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/cloudflare-access-jwt": new URL(
    "../../packages/platform-cf/src/cloudflare-access-jwt.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/hns-community-app-api": new URL(
    "../../packages/platform-cf/src/hns-community-app-api.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf": new URL("../../packages/platform-cf/src/index.ts", import.meta.url)
    .pathname,
  "@pirate/platform-cf/registration-rate-limiter": new URL(
    "../../packages/platform-cf/src/registration-rate-limiter.ts",
    import.meta.url,
  ).pathname,
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/workerd-http/wrangler.jsonc" },
      miniflare: {
        alias,
        serviceBindings: {
          HNS_OWNER_VERIFIER: async (request) => {
            const url = new URL(request.url);
            if (
              request.method !== "POST" ||
              request.headers.get("content-type") !== "application/json" ||
              request.headers.get("pirate-namespace-session-id") !== "namespace-session-workerd"
            ) {
              return new Response(null, { status: 422 });
            }
            if (url.pathname === "/internal/hns-owner/v1/start") {
              if (request.headers.get("accept") !== "application/json") {
                return new Response(null, { status: 422 });
              }
              return Response.json({
                upstream_session_ref: "upstream-workerd-binding",
                expires_at: "2099-01-01T00:00:00.000Z",
                presentation: {
                  kind: "embedded_sdk",
                  session_id: "upstream-workerd-binding",
                  protocol: "hns-txt-challenge",
                  version: "1",
                  payload: {
                    ownership_source: "hns_parent_chain_txt",
                    challenge_name: "jazleeuw",
                    challenge_value: "pirate-verification=upstream-workerd-binding",
                    expires_at: "2099-01-01T00:00:00.000Z",
                  },
                },
              });
            }
            if (url.pathname === "/internal/hns-owner/v1/poll") {
              if (
                request.headers.get("accept") !== "application/octet-stream" ||
                request.headers.get("pirate-hns-observation-id") !== "completion-attempt-workerd"
              ) {
                return new Response(null, { status: 422 });
              }
              return new Response(new Uint8Array([0, 1, 127, 255]), {
                headers: { "content-type": "application/octet-stream" },
              });
            }
            return new Response(null, { status: 404 });
          },
        },
      },
    }),
  ],
  resolve: { alias },
  test: {
    include: ["tests/workerd-http/**/*.test.ts"],
  },
});
