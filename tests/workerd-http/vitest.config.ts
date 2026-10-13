import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { telegramOidcOutbound } from "./telegram-oidc-outbound.ts";

const alias = {
  // Exact workspace subpaths must precede package-root aliases in both
  // Vite and native Workerd resolution. Keep real source modules in this pool.
  "@pirate/application/learner-audio-deletion": new URL(
    "../../packages/application/src/learner-audio-deletion.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/guest-participation-authority": new URL(
    "../../packages/application/src/guest-participation-authority.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/guest-study-ports": new URL(
    "../../packages/application/src/guest-study-ports.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/guest-learning-resource-admission": new URL(
    "../../packages/application/src/guest-learning-resource-admission.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/owner-learner-audio-deletion": new URL(
    "../../packages/application/src/owner-learner-audio-deletion.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/owner-reward-credit-ports": new URL(
    "../../packages/application/src/owner-reward-credit-ports.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/guest-proof-verifier": new URL(
    "../../packages/application/src/guest-proof-verifier.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/learner-audio-capture": new URL(
    "../../packages/application/src/learner-audio-capture.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/learner-audio-io-outcome": new URL(
    "../../packages/application/src/learner-audio-io-outcome.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/owner-guest-atomic-start": new URL(
    "../../packages/application/src/owner-guest-atomic-start.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/owner-spoken-captured-continuation": new URL(
    "../../packages/application/src/owner-spoken-captured-continuation.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/owner-guest-spoken-checkpoint-recovery": new URL(
    "../../packages/application/src/owner-guest-spoken-checkpoint-recovery.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/owner-guest-spoken-closed-recovery": new URL(
    "../../packages/application/src/owner-guest-spoken-closed-recovery.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/owner-guest-study-service": new URL(
    "../../packages/application/src/owner-guest-study-service.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/account-study-capture-protocol": new URL(
    "../../packages/application/src/account-study-capture-protocol.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/controlled-account-spoken": new URL(
    "../../packages/application/src/controlled-account-spoken.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/learner-audio-account-lock": new URL(
    "../../packages/platform-cf/src/learner-audio-account-lock.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/learner-audio-deletion-repository": new URL(
    "../../packages/platform-cf/src/learner-audio-deletion-repository.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/guest-proof-crypto": new URL(
    "../../packages/platform-cf/src/guest-proof-crypto.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/guest-proof-verifier": new URL(
    "../../packages/platform-cf/src/guest-proof-verifier.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/guest-prepared-study-content-store": new URL(
    "../../packages/platform-cf/src/guest-prepared-study-content-store.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/guest-authority-store": new URL(
    "../../packages/platform-cf/src/guest-authority-store.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/guest-attachment-preparation-store": new URL(
    "../../packages/platform-cf/src/guest-attachment-preparation-store.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/guest-resource-store": new URL(
    "../../packages/platform-cf/src/guest-resource-store.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/owner-study-starter": new URL(
    "../../packages/platform-cf/src/owner-study-starter.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/owner-spoken-checkpoint-store": new URL(
    "../../packages/platform-cf/src/owner-spoken-checkpoint-store.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/owner-study-mutations": new URL(
    "../../packages/platform-cf/src/owner-study-mutations.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/owner-spoken-fenced-archive": new URL(
    "../../packages/platform-cf/src/owner-spoken-fenced-archive.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/learner-audio-captured-io": new URL(
    "../../packages/platform-cf/src/learner-audio-captured-io.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/guest-resource-policy": new URL(
    "../../packages/platform-cf/src/guest-resource-policy.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/guest-recovery-deletion-store": new URL(
    "../../packages/platform-cf/src/guest-recovery-deletion-store.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/owner-audio-deletion-io": new URL(
    "../../packages/platform-cf/src/owner-audio-deletion-io.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/owner-guest-spoken-checkpoint-recovery-store": new URL(
    "../../packages/platform-cf/src/owner-guest-spoken-checkpoint-recovery-store.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/guest-practice-participation-read-store": new URL(
    "../../packages/platform-cf/src/guest-practice-participation-read-store.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/owner-study-store-composition": new URL(
    "../../packages/platform-cf/src/owner-study-store-composition.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/owner-account-source-control": new URL(
    "../../packages/platform-cf/src/owner-account-source-control.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/owner-guest-spoken-dispatch-context": new URL(
    "../../packages/platform-cf/src/owner-guest-spoken-dispatch-context.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/owner-study-invoking-transcriber": new URL(
    "../../packages/platform-cf/src/owner-study-invoking-transcriber.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/owner-guest-study-public-visibility": new URL(
    "../../packages/platform-cf/src/owner-guest-study-public-visibility.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/guest-study-resource-expiry": new URL(
    "../../packages/platform-cf/src/guest-study-resource-expiry.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/learner-audio-producer-store": new URL(
    "../../packages/platform-cf/src/learner-audio-producer-store.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/controlled-account-study-store": new URL(
    "../../packages/platform-cf/src/controlled-account-study-store.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/controlled-account-spoken-recovery": new URL(
    "../../packages/platform-cf/src/controlled-account-spoken-recovery.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/controlled-account-spoken-composition": new URL(
    "../../packages/platform-cf/src/controlled-account-spoken-composition.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/captured-karaoke-multipart": new URL(
    "../../packages/platform-cf/src/captured-karaoke-multipart.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/captured-karaoke-sqlite-journal": new URL(
    "../../packages/platform-cf/src/captured-karaoke-sqlite-journal.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/captured-karaoke-bindings": new URL(
    "../../packages/platform-cf/src/captured-karaoke-bindings.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/account-audio-deletion-protocol": new URL(
    "../../packages/platform-cf/src/account-audio-deletion-protocol.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/guest-study-managed-readiness": new URL(
    "../../packages/platform-cf/src/guest-study-managed-readiness.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/spaces-sale-namespace-repository": new URL(
    "../../packages/platform-cf/src/spaces-sale-namespace-repository.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/spaces-community-route-attachment-repository": new URL(
    "../../packages/platform-cf/src/spaces-community-route-attachment-repository.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/spaces-operator-assignment-repository": new URL(
    "../../packages/platform-cf/src/spaces-operator-assignment-repository.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/age-verification": new URL(
    "../../packages/application/src/use-cases/age-verification.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/account-age-verification": new URL(
    "../../packages/platform-cf/src/account-age-verification.ts",
    import.meta.url,
  ).pathname,

  "@pirate/application/telegram-study": new URL(
    "../../packages/application/src/telegram-study.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/telegram-linking": new URL(
    "../../packages/application/src/telegram-linking.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/telegram": new URL(
    "../../packages/application/src/telegram/index.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/telegram-oidc": new URL(
    "../../packages/application/src/telegram-oidc.ts",
    import.meta.url,
  ).pathname,
  "@pirate/domain/telegram": new URL("../../packages/domain/src/telegram.ts", import.meta.url)
    .pathname,
  "@pirate/application/video/playback-access": new URL(
    "../../packages/application/src/video/playback-access.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/video/poster-access": new URL(
    "../../packages/application/src/video/poster-access.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/video-poster-stream": new URL(
    "../../packages/platform-cf/src/video-poster-stream.ts",
    import.meta.url,
  ).pathname,
  "@pirate/platform-cf/hns-authority-diagnostics": new URL(
    "../../packages/platform-cf/src/hns-authority-diagnostics.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/video/stage-facts": new URL(
    "../../packages/application/src/video/stage-facts.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/post-slug": new URL(
    "../../packages/application/src/post-slug.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/hns-edge-alerts": new URL(
    "../../packages/application/src/use-cases/hns-edge-alerts.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/hns-edge-status": new URL(
    "../../packages/application/src/use-cases/hns-edge-status.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/content/community-moderation-runtime": new URL(
    "../../packages/application/src/use-cases/content/community-moderation-runtime.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/hns-community-app-api": new URL(
    "../../packages/application/src/hns-community-app-api.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/hns-forwarder-v3": new URL(
    "../../packages/application/src/hns-forwarder-v3.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/hns-community-handle-gateway": new URL(
    "../../packages/application/src/hns-community-handle-gateway.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/hns-handle-host-api": new URL(
    "../../packages/application/src/hns-handle-host-api.ts",
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
  "@pirate/application/use-cases/handles/spaces-sale-namespaces": new URL(
    "../../packages/application/src/use-cases/handles/spaces-sale-namespaces.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/handles/spaces-registry": new URL(
    "../../packages/application/src/use-cases/handles/spaces-registry.ts",
    import.meta.url,
  ).pathname,
  "@pirate/application/use-cases/handles/platform-pirate-rename": new URL(
    "../../packages/application/src/use-cases/handles/platform-pirate-rename.ts",
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
  "@pirate/platform-cf/hns-handle-host-api": new URL(
    "../../packages/platform-cf/src/hns-handle-host-api.ts",
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
