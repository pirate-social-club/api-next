import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { telegramOidcOutbound } from "./telegram-oidc-outbound.ts";

// Both Vite and native Workerd need exact public workspace subpaths before
// package-root aliases. Derive them from the maintained export manifests so
// newly selected real Worker graphs resolve without mocked module substitutes.
const workspaceAliases: [string, string][] = [];
for (const name of ["application", "platform-cf", "contracts", "domain"]) {
  const directory = new URL(`../../packages/${name}/`, import.meta.url);
  const manifest: unknown = JSON.parse(readFileSync(new URL("package.json", directory), "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("exports" in manifest) ||
      typeof manifest.exports !== "object" || manifest.exports === null)
    throw new Error(`Invalid workspace exports: ${name}`);
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if ((subpath !== "." && !subpath.startsWith("./")) || subpath.includes("*") ||
        typeof target !== "string" || !target.startsWith("./"))
      throw new Error(`Unsupported workspace export: ${name}/${subpath}`);
    workspaceAliases.push([
      `@pirate/${name}${subpath === "." ? "" : subpath.slice(1)}`,
      new URL(target, directory).pathname,
    ]);
  }
}
// Existing jobs internals also use the maintained tsconfig wildcard source path.
// These are real source modules, without adding new package-public exports.
for (const subpath of [
  "media-processing-cloudflare",
  "media-processing-store",
  "namespace-ownership/hns-owner-service-binding",
]) workspaceAliases.push([
  `@pirate/platform-cf/${subpath}`,
  new URL(`../../packages/platform-cf/src/${subpath}.ts`, import.meta.url).pathname,
]);
const alias = Object.fromEntries(workspaceAliases.sort(([a], [b]) => b.length - a.length));

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
