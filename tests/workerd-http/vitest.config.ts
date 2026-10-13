import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { withWorkspacePublicAliases } from "../workspace-public-aliases.ts";
import { telegramOidcOutbound } from "./telegram-oidc-outbound.ts";

// Preserve the existing explicitly admitted private source overrides. Public
// exact subpaths come from the same maintained manifests as the other pools.
const privateAliases: Record<string, string> = {};
for (const subpath of [
  "media-processing-cloudflare",
  "media-processing-store",
  "namespace-ownership/hns-owner-service-binding",
])
  privateAliases[`@pirate/platform-cf/${subpath}`] = new URL(
    `../../packages/platform-cf/src/${subpath}.ts`,
    import.meta.url,
  ).pathname;
const alias = withWorkspacePublicAliases(privateAliases);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/workerd-http/wrangler.jsonc" },
      miniflare: {
        alias,
        outboundService: telegramOidcOutbound,
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
              return Response.json(
                {
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
                },
                { headers: { "content-type": "application/json" } },
              );
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
    // Each file imports the full HTTP Worker graph. Keep those transforms serial
    // instead of multiplying the same graph across concurrent worker processes.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
